import type pg from 'pg';
import { generateInviteToken, hashInviteToken } from './token.ts';

// Issuing, revoking and refunding invites (design §12).
//
// §12, the whole of it in three sentences:
//
//   "A teacher's platform-invite budget defaults to 0 — creating accounts is
//    granted deliberately, not assumed. One action issues one link that both
//    registers the person and enrolls them in the course. The budget
//    decrements on ISSUE (so invites cannot be hoarded or spammed) and is
//    refunded on expiry or revocation."
//
// THE DECREMENT IS THE GATE, NOT A SIDE EFFECT. `update users set
// platform_invite_budget = platform_invite_budget - 1 where id = $1 and
// platform_invite_budget > 0` inside the issuing transaction — the same
// technique as the bootstrap claim (auth/bootstrap.ts) and for the same
// reason: a read-then-write lets two concurrent issues with one unit of
// budget both pass the read. Zero rows updated IS the refusal; there is no
// separate check that could disagree with it.
//
// REFUNDS ARE LAZY AND IDEMPOTENT. There is no job queue in this design
// (§4: Postgres is the only stateful service), so an expired invite's unit
// comes back when someone next looks at that issuer's budget — which is
// exactly when it matters, because that is when they are about to issue or
// to be told how many they have left. `where refunded_at is null` makes two
// concurrent sweeps refund it once.

export type InviteKind = 'platform' | 'course';

/** Everything the caller has already decided, checked by `can()`, and normalized. */
export interface IssueInviteRequest {
  issuerId: string;
  kind: InviteKind;
  /** Lower-cased. The token is bound to this address (§13). */
  email: string;
  /** `courses.id` for a course invite, null for a platform invite. */
  courseId: string | null;
  expiresAt: Date;
  /**
   * Whether accepting this invite may create an account — i.e. no account
   * held this address at issue time. See migration 0015: recorded, never
   * re-derived at acceptance.
   */
  createsAccount: boolean;
  /**
   * Whether to charge a unit of the issuer's platform-invite budget. False
   * for an admin (§12: unlimited) and for an invite that cannot create an
   * account. When true, an exhausted budget refuses the whole issue.
   */
  consumesBudget: boolean;
  /** Copied into the audit entry; the identity that was true at the time. */
  meta?: Record<string, unknown>;
}

export interface IssuedInvite {
  id: string;
  kind: InviteKind;
  email: string;
  courseId: string | null;
  expiresAt: Date;
  createdAt: Date;
  budgetConsumed: boolean;
  createsAccount: boolean;
  /**
   * The plaintext token, returned EXACTLY ONCE — to the issuer, who puts it
   * in the link. Only its SHA-256 is stored, so it cannot be recovered
   * afterwards; a lost link is revoked and re-issued.
   */
  token: string;
}

export type IssueInviteResult =
  | { ok: true; invite: IssuedInvite }
  /** The issuer's budget was exhausted between `can()` and the decrement. */
  | { ok: false; reason: 'budget_exhausted' };

/**
 * Refunds every expired, unaccepted, unrevoked invite that took budget.
 *
 * Call before reading a budget and before charging one. Scoped to a single
 * issuer, or to everyone when `issuerId` is null (the admin screen, which
 * shows every invite's status). Returns how many units were returned.
 *
 * The two statements are one command: the CTE's UPDATE marks the rows and
 * the outer UPDATE credits the accounts, so there is no window in which an
 * invite is marked refunded but the unit has not come back.
 */
export async function refundExpiredInvites(db: Pick<pg.Pool, 'query'>, issuerId: string | null): Promise<number> {
  const { rows } = await db.query<{ refunded: string }>(
    `with expired as (
       update invites
          set refunded_at = now()
        where budget_consumed
          and refunded_at is null
          and accepted_at is null
          and revoked_at is null
          and expires_at <= now()
          and ($1::uuid is null or issued_by = $1::uuid)
        returning issued_by
     ),
     per_issuer as (
       select issued_by, count(*)::int as units from expired where issued_by is not null group by issued_by
     ),
     credited as (
       update users u
          set platform_invite_budget = u.platform_invite_budget + p.units
         from per_issuer p
        where u.id = p.issued_by
       returning p.units
     )
     select coalesce(sum(units), 0)::text as refunded from credited`,
    [issuerId],
  );
  return Number(rows[0]?.refunded ?? 0);
}

/** The issuer's budget right now, after any expired invites of theirs are refunded. */
export async function remainingBudget(db: Pick<pg.Pool, 'query'>, issuerId: string): Promise<number> {
  await refundExpiredInvites(db, issuerId);
  const { rows } = await db.query<{ platform_invite_budget: number }>(
    'select platform_invite_budget from users where id = $1',
    [issuerId],
  );
  return rows[0]?.platform_invite_budget ?? 0;
}

/**
 * Issues one invite: charges the budget (when it applies), stores the token
 * hash, and writes the audit entry — all in one transaction, so a failure
 * anywhere refunds nothing because nothing was ever spent.
 */
export async function issueInvite(pool: pg.Pool, request: IssueInviteRequest): Promise<IssueInviteResult> {
  const token = generateInviteToken();
  const client = await pool.connect();
  try {
    await client.query('begin');

    if (request.consumesBudget) {
      // THE GATE. Not "read the budget, then decide": the WHERE clause is
      // the decision, and a second concurrent issue blocks on this row lock
      // and re-evaluates it against the committed value.
      const charged = await client.query(
        `update users
            set platform_invite_budget = platform_invite_budget - 1
          where id = $1 and platform_invite_budget > 0`,
        [request.issuerId],
      );
      if (charged.rowCount === 0) {
        await client.query('rollback');
        return { ok: false, reason: 'budget_exhausted' };
      }
    }

    const inserted = await client.query<{
      id: string;
      kind: InviteKind;
      email: string;
      course_id: string | null;
      expires_at: Date;
      created_at: Date;
    }>(
      `insert into invites (kind, issued_by, email, token_hash, course_id, expires_at, budget_consumed, creates_account)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, kind, email, course_id, expires_at, created_at`,
      [
        request.kind,
        request.issuerId,
        request.email,
        hashInviteToken(token),
        request.courseId,
        request.expiresAt,
        request.consumesBudget,
        request.createsAccount,
      ],
    );
    const row = inserted.rows[0]!;

    // §12: "all privileged actions — role changes, budget grants, invite
    // issuance, course publishing — are written to audit_log". The token
    // itself is NOT in the meta: an audit log readable by every admin must
    // not be a place invite links can be harvested from.
    await client.query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'invite.issued', $2, $3::jsonb)`,
      [
        request.issuerId,
        row.id,
        JSON.stringify({
          kind: row.kind,
          email: row.email,
          courseId: row.course_id,
          expiresAt: row.expires_at,
          budgetConsumed: request.consumesBudget,
          createsAccount: request.createsAccount,
          ...request.meta,
        }),
      ],
    );

    await client.query('commit');

    return {
      ok: true,
      invite: {
        id: row.id,
        kind: row.kind,
        email: row.email,
        courseId: row.course_id,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        budgetConsumed: request.consumesBudget,
        createsAccount: request.createsAccount,
        token,
      },
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type RevokeInviteResult =
  | { ok: true; refunded: boolean }
  /** Already accepted, already revoked, or no such invite for this scope. */
  | { ok: false; reason: 'not_revocable' };

/**
 * Revokes an invite and returns its unit of budget, if it took one.
 *
 * `scopeToIssuer` is the teacher case: a teacher may revoke only what they
 * issued, and that is enforced HERE in the WHERE clause rather than by a
 * read-then-check in the route, so there is no window between the two.
 */
export async function revokeInvite(
  pool: pg.Pool,
  args: { inviteId: string; actorId: string; scopeToIssuer: boolean },
): Promise<RevokeInviteResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const revoked = await client.query<{ id: string; email: string; kind: InviteKind; budget_consumed: boolean; issued_by: string | null }>(
      `update invites
          set revoked_at = now()
        where id = $1
          and accepted_at is null
          and revoked_at is null
          and ($3 = false or issued_by = $2::uuid)
        returning id, email, kind, budget_consumed, issued_by`,
      [args.inviteId, args.actorId, args.scopeToIssuer],
    );
    const row = revoked.rows[0];
    if (!row) {
      await client.query('rollback');
      return { ok: false, reason: 'not_revocable' };
    }

    let refunded = false;
    if (row.budget_consumed && row.issued_by !== null) {
      // Same `where refunded_at is null` idempotence as the expiry sweep: an
      // invite that expired (and was refunded) a moment before being revoked
      // must not pay out twice.
      const marked = await client.query('update invites set refunded_at = now() where id = $1 and refunded_at is null', [
        row.id,
      ]);
      if (marked.rowCount === 1) {
        await client.query(
          'update users set platform_invite_budget = platform_invite_budget + 1 where id = $1',
          [row.issued_by],
        );
        refunded = true;
      }
    }

    await client.query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'invite.revoked', $2, $3::jsonb)`,
      [args.actorId, row.id, JSON.stringify({ kind: row.kind, email: row.email, refunded })],
    );

    await client.query('commit');
    return { ok: true, refunded };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
