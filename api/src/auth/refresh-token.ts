import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

// Rotating opaque refresh tokens with reuse detection (design §13):
// "Rotating opaque refresh tokens with reuse detection — presenting a spent
// token revokes the whole family. One per device, so 'sign out my iPad'
// works."
//
// The model, and why each piece is the way it is:
//
//   OPAQUE, not a JWT. A refresh token's whole job is to be revocable, and
//   a stateless token is not. So it is 256 bits of randomness whose SHA-256
//   is the only stored form — the same reasoning as auth/setup-token.ts: a
//   uniformly random 256-bit value has no dictionary to attack, so a KDF
//   would buy nothing here. (Argon2id is for human-chosen passwords, in
//   auth/password.ts, and nowhere else.)
//
//   ROTATING. Every exchange spends the presented token (`used_at`) and
//   issues a new one. A refresh token is therefore valid exactly once.
//
//   FAMILIES. Every token minted by rotating another carries the same
//   `family_id` — one device's session across its whole life. Revocation is
//   per family.
//
//   REUSE DETECTION. A token with `used_at` set has already been exchanged,
//   which means the legitimate client threw it away and is holding a
//   different one. A second presentation is therefore either a thief
//   replaying a stolen token or a client that leaked one — indistinguishable,
//   and both mean the family is compromised. So the family is revoked
//   entirely: the attacker AND the victim are logged out, and only a fresh
//   password login gets back in. Revoking just the replayed token would
//   leave the thief's copy of the *newer* token working, which is the exact
//   failure this mechanism exists to prevent.
//
// The whole exchange runs in one transaction over a `select ... for update`
// on the token row. That is what makes two simultaneous presentations of the
// same token resolve to exactly one success and one detected reuse, instead
// of two successes forking the family in a way nothing downstream could
// untangle.

export const REFRESH_TOKEN_TTL_DAYS = 30;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_BYTES = 32;

/** Anything with `.query` — the pool, or a client already inside a transaction. */
type Queryable = Pick<pg.Pool, 'query'>;

export interface IssuedRefreshToken {
  /** The plaintext token. Returned once, stored nowhere, sent only as a cookie. */
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface IssueOptions {
  userId: string;
  /** Continues an existing session when set; starts a new family when absent. */
  familyId?: string;
  deviceLabel?: string | null;
}

export type RotationFailureReason =
  /** No such token: never issued, or long since pruned. */
  | 'unknown'
  /** Past `expires_at`. */
  | 'expired'
  /** Logged out, superseded on this device, or killed by reuse detection. */
  | 'revoked'
  /** Already spent. The family has just been revoked. */
  | 'reuse';

export type RotationResult =
  | {
      ok: true;
      userId: string;
      token: string;
      familyId: string;
      expiresAt: Date;
      deviceLabel: string | null;
    }
  | { ok: false; reason: RotationFailureReason };

/** The only form of a refresh token that is ever persisted. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Mints a refresh token. Pass `familyId` to continue a session, omit it to
 * start one.
 */
export async function issueRefreshToken(db: Queryable, options: IssueOptions): Promise<IssuedRefreshToken> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const { rows } = await db.query<{ family_id: string }>(
    `insert into refresh_tokens (user_id, family_id, token_hash, device_label, expires_at)
     values ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, $5)
     returning family_id`,
    [options.userId, options.familyId ?? null, hashRefreshToken(token), options.deviceLabel ?? null, expiresAt],
  );

  return { token, familyId: rows[0]!.family_id, expiresAt };
}

/**
 * Revokes every unrevoked token in a family. Returns how many rows died.
 *
 * Idempotent: revoking an already-dead family updates nothing and returns 0,
 * so the reuse path can be entered twice without rewriting timestamps.
 */
export async function revokeFamily(db: Queryable, familyId: string): Promise<number> {
  const { rowCount } = await db.query(
    'update refresh_tokens set revoked_at = now() where family_id = $1 and revoked_at is null',
    [familyId],
  );
  return rowCount ?? 0;
}

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  device_label: string | null;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

/**
 * Exchanges a refresh token for a fresh one — or detects that it has already
 * been spent and revokes the whole family.
 */
export async function rotateRefreshToken(pool: pg.Pool, presented: string): Promise<RotationResult> {
  if (typeof presented !== 'string' || presented === '') return { ok: false, reason: 'unknown' };

  const client = await pool.connect();
  try {
    await client.query('begin');

    // FOR UPDATE, not a plain select: this lock is the entire concurrency
    // story. A second presentation of the same token blocks here and then
    // re-reads the row AFTER the first transaction commits, so it sees
    // `used_at` and takes the reuse branch. Without it, both would read a
    // fresh-looking row and both would succeed.
    const found = await client.query<TokenRow>(
      `select id, user_id, family_id, device_label, expires_at, used_at, revoked_at
         from refresh_tokens
        where token_hash = $1
        for update`,
      [hashRefreshToken(presented)],
    );
    const row = found.rows[0];

    if (!row) {
      await client.query('rollback');
      return { ok: false, reason: 'unknown' };
    }

    // Order matters: `revoked` is checked before `used`. A revoked token that
    // was also spent is already accounted for — its family died when it was
    // revoked — and re-entering the reuse path would rewrite revoked_at
    // timestamps and add a duplicate audit entry on every retry of a dead
    // session, which is noise that hides the real detection.
    if (row.revoked_at !== null) {
      await client.query('rollback');
      return { ok: false, reason: 'revoked' };
    }

    if (row.used_at !== null) {
      // ===================================================================
      // REUSE DETECTED. The whole family goes.
      // ===================================================================
      const revoked = await revokeFamily(client, row.family_id);
      await client.query(
        `insert into audit_log (actor_id, action, target, meta)
         values ($1, 'auth.refresh_reuse_detected', $2, $3::jsonb)`,
        [
          row.user_id,
          row.family_id,
          JSON.stringify({ familyId: row.family_id, revoked, deviceLabel: row.device_label }),
        ],
      );
      await client.query('commit');
      return { ok: false, reason: 'reuse' };
    }

    if (row.expires_at.getTime() <= Date.now()) {
      // Closed out rather than merely refused, so a token that sat unused
      // past its expiry cannot later be replayed into the reuse path and
      // used to kill a family that is otherwise fine.
      await revokeFamily(client, row.family_id);
      await client.query('commit');
      return { ok: false, reason: 'expired' };
    }

    // `and used_at is null` again: belt to the FOR UPDATE's braces. If this
    // ever matched zero rows, something spent the token between the select
    // and here, and the safe reading of that is a replay.
    const spent = await client.query('update refresh_tokens set used_at = now() where id = $1 and used_at is null', [
      row.id,
    ]);
    if (spent.rowCount === 0) {
      await revokeFamily(client, row.family_id);
      await client.query('commit');
      return { ok: false, reason: 'reuse' };
    }

    const issued = await issueRefreshToken(client, {
      userId: row.user_id,
      familyId: row.family_id,
      deviceLabel: row.device_label,
    });

    await client.query('commit');
    return {
      ok: true,
      userId: row.user_id,
      token: issued.token,
      familyId: issued.familyId,
      expiresAt: issued.expiresAt,
      deviceLabel: row.device_label,
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Logout: revokes the family the presented token belongs to. Returns false
 * when the token is unknown (an already-logged-out client, or noise).
 */
export async function revokeSession(db: Queryable, presented: string): Promise<boolean> {
  if (typeof presented !== 'string' || presented === '') return false;

  const { rows } = await db.query<{ family_id: string }>('select family_id from refresh_tokens where token_hash = $1', [
    hashRefreshToken(presented),
  ]);
  const familyId = rows[0]?.family_id;
  if (!familyId) return false;

  await revokeFamily(db, familyId);
  return true;
}

/** Logout-all: every device. Returns the number of families revoked. */
export async function revokeAllForUser(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `with killed as (
       update refresh_tokens set revoked_at = now()
        where user_id = $1 and revoked_at is null
        returning family_id
     )
     select count(distinct family_id)::text as n from killed`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * "One per device" (design §13): revokes this user's live families for a
 * given device label, so a fresh login on that device supersedes the old
 * session instead of accumulating a second one.
 *
 * `is not distinct from` so a null label matches only other null labels —
 * an unlabelled client must not sweep away every named device.
 */
export async function revokeDeviceSessions(db: Queryable, userId: string, deviceLabel: string | null): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `with killed as (
       update refresh_tokens set revoked_at = now()
        where user_id = $1 and device_label is not distinct from $2 and revoked_at is null
        returning family_id
     )
     select count(distinct family_id)::text as n from killed`,
    [userId, deviceLabel],
  );
  return Number(rows[0]?.n ?? 0);
}
