import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  REFRESH_TOKEN_TTL_DAYS,
  hashRefreshToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeDeviceSessions,
  revokeSession,
  rotateRefreshToken,
} from './refresh-token.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run refresh-token.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pool = new Pool({ connectionString });

// Mirrors every other DB-touching test file: each owns its migration bootstrap.
async function applyMigrations(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [version]);
    } catch (err) {
      if ((err as { code?: string }).code !== '42P07') throw err;
    }
  }
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
let userId: string;
let otherUserId: string;

interface TokenRow {
  id: string;
  family_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  device_label: string | null;
  expires_at: Date;
}

async function familyRows(familyId: string): Promise<TokenRow[]> {
  const { rows } = await pool.query<TokenRow>(
    'select id, family_id, used_at, revoked_at, device_label, expires_at from refresh_tokens where family_id = $1 order by issued_at',
    [familyId],
  );
  return rows;
}

describe('rotating refresh tokens with reuse detection (design §13)', () => {
  beforeAll(async () => {
    await applyMigrations();
    const inserted = await pool.query<{ id: string }>(
      `insert into users (email, handle, display_name)
       values ($1, $2, 'Refresh Fixture'), ($3, $4, 'Refresh Fixture Two')
       returning id`,
      [`rt-${RUN_ID}@example.test`, `rt${RUN_ID}`, `rt2-${RUN_ID}@example.test`, `rt2${RUN_ID}`],
    );
    userId = inserted.rows[0]!.id;
    otherUserId = inserted.rows[1]!.id;
  });

  afterAll(async () => {
    // refresh_tokens cascades from users.
    await pool.query('delete from audit_log where actor_id in ($1, $2)', [userId, otherUserId]).catch(() => {});
    await pool.query('delete from users where id in ($1, $2)', [userId, otherUserId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from refresh_tokens where user_id in ($1, $2)', [userId, otherUserId]);
  });

  describe('issuing', () => {
    it('stores only a hash — the plaintext token appears nowhere in the row', async () => {
      const issued = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });

      const { rows } = await pool.query('select * from refresh_tokens where family_id = $1', [issued.familyId]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(issued.token);
      expect(rows[0]!.token_hash).toBe(hashRefreshToken(issued.token));
      expect(rows[0]!.device_label).toBe('iPad');
      expect(rows[0]!.used_at).toBeNull();
      expect(rows[0]!.revoked_at).toBeNull();
    });

    it('is opaque and unguessable, and expires in ~30 days', async () => {
      const a = await issueRefreshToken(pool, { userId });
      const b = await issueRefreshToken(pool, { userId });

      expect(a.token).not.toBe(b.token);
      expect(a.familyId).not.toBe(b.familyId);
      // 32 random bytes, base64url.
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const days = (a.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(REFRESH_TOKEN_TTL_DAYS).toBe(30);
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });
  });

  describe('rotation', () => {
    it('exchanges a live token for a new one in the same family, and spends the old one', async () => {
      const first = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const result = await rotateRefreshToken(pool, first.token);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.userId).toBe(userId);
      expect(result.familyId).toBe(first.familyId);
      expect(result.token).not.toBe(first.token);

      const rows = await familyRows(first.familyId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.used_at).toBeInstanceOf(Date);
      expect(rows[0]!.revoked_at).toBeNull();
      expect(rows[1]!.used_at).toBeNull();
      // The device label rides along, so "sign out my iPad" still knows which is which.
      expect(rows[1]!.device_label).toBe('iPad');
    });

    it('lets a rotated token keep rotating (a long-lived session)', async () => {
      let current = await issueRefreshToken(pool, { userId });
      for (let i = 0; i < 3; i += 1) {
        const result = await rotateRefreshToken(pool, current.token);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        current = { token: result.token, familyId: result.familyId, expiresAt: result.expiresAt };
      }
      expect(await familyRows(current.familyId)).toHaveLength(4);
    });

    it('refuses a token it has never seen, without touching anything', async () => {
      const live = await issueRefreshToken(pool, { userId });
      const result = await rotateRefreshToken(pool, 'not-a-real-token');

      expect(result).toEqual({ ok: false, reason: 'unknown' });
      const rows = await familyRows(live.familyId);
      expect(rows[0]!.revoked_at).toBeNull();
      expect(rows[0]!.used_at).toBeNull();
    });

    it('refuses an expired token and closes it out', async () => {
      const issued = await issueRefreshToken(pool, { userId });
      // issued_at moves too: the table's own check constraint keeps
      // expires_at after issued_at, so an expired row is an OLD row.
      await pool.query(
        `update refresh_tokens
            set issued_at = now() - interval '31 days', expires_at = now() - interval '1 second'
          where family_id = $1`,
        [issued.familyId],
      );

      expect(await rotateRefreshToken(pool, issued.token)).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect((await familyRows(issued.familyId))[0]!.revoked_at).toBeInstanceOf(Date);
    });

    it('refuses a revoked token', async () => {
      const issued = await issueRefreshToken(pool, { userId });
      await revokeSession(pool, issued.token);
      expect(await rotateRefreshToken(pool, issued.token)).toEqual({
        ok: false,
        reason: 'revoked',
      });
    });
  });

  // ==========================================================================
  // THE BEHAVIOUR THIS MODULE EXISTS FOR (design §13):
  // "presenting a spent token revokes the whole family".
  // ==========================================================================
  describe('reuse detection', () => {
    it('kills the ENTIRE family when a spent token is replayed, and the live session dies with it', async () => {
      const first = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });

      const rotated = await rotateRefreshToken(pool, first.token);
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;

      // The thief replays the token the legitimate client already spent.
      const replay = await rotateRefreshToken(pool, first.token);
      expect(replay).toEqual({ ok: false, reason: 'reuse' });

      // Every token in the family is revoked — including the one the honest
      // client is holding right now. That is the point: the family is
      // compromised, so both parties are logged out and only a fresh login
      // (which needs the password) gets back in.
      const rows = await familyRows(first.familyId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.revoked_at).toBeInstanceOf(Date);
      }

      // The session cannot continue: the honest client's current token is dead.
      expect(await rotateRefreshToken(pool, rotated.token)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      // And replaying again stays dead rather than resurrecting anything.
      expect(await rotateRefreshToken(pool, first.token)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('kills the family from ANY spent generation, not just the newest', async () => {
      const gen1 = await issueRefreshToken(pool, { userId });
      const gen2 = await rotateRefreshToken(pool, gen1.token);
      expect(gen2.ok).toBe(true);
      if (!gen2.ok) return;
      const gen3 = await rotateRefreshToken(pool, gen2.token);
      expect(gen3.ok).toBe(true);
      if (!gen3.ok) return;

      // Replay the oldest token of all.
      expect(await rotateRefreshToken(pool, gen1.token)).toEqual({ ok: false, reason: 'reuse' });

      const rows = await familyRows(gen1.familyId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
      expect(await rotateRefreshToken(pool, gen3.token)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('leaves other families and other devices alone', async () => {
      const iPad = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const laptop = await issueRefreshToken(pool, { userId, deviceLabel: 'laptop' });
      const stranger = await issueRefreshToken(pool, { userId: otherUserId });

      const rotated = await rotateRefreshToken(pool, iPad.token);
      expect(rotated.ok).toBe(true);
      expect(await rotateRefreshToken(pool, iPad.token)).toEqual({ ok: false, reason: 'reuse' });

      expect((await familyRows(laptop.familyId))[0]!.revoked_at).toBeNull();
      expect((await familyRows(stranger.familyId))[0]!.revoked_at).toBeNull();
    });

    it('records the revocation in the audit log', async () => {
      const issued = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      await rotateRefreshToken(pool, issued.token);
      await rotateRefreshToken(pool, issued.token);

      // Scoped to this family: audit_log is append-only by trigger (0005), so
      // entries written by the other cases in this file are still there.
      const { rows } = await pool.query<{
        action: string;
        meta: { familyId?: string; revoked?: number };
      }>(
        "select action, meta from audit_log where actor_id = $1 and action = 'auth.refresh_reuse_detected' and target = $2",
        [userId, issued.familyId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.meta.familyId).toBe(issued.familyId);
      expect(rows[0]!.meta.revoked).toBe(2);
    });

    it('survives two clients presenting the same token at the same instant', async () => {
      const issued = await issueRefreshToken(pool, { userId });

      const [a, b] = await Promise.all([
        rotateRefreshToken(pool, issued.token),
        rotateRefreshToken(pool, issued.token),
      ]);

      // Exactly one exchange may succeed. The loser is, by definition, a
      // replay of a spent token — so the family dies, which is the strict and
      // correct reading: a token presented twice cannot be told apart from a
      // stolen one.
      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      expect(outcomes.filter((r) => !r.ok && r.reason === 'reuse')).toHaveLength(1);

      const rows = await familyRows(issued.familyId);
      expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    });
  });

  describe('revocation', () => {
    it("revokeSession kills only the presented token's family (sign out this device)", async () => {
      const iPad = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const laptop = await issueRefreshToken(pool, { userId, deviceLabel: 'laptop' });

      expect(await revokeSession(pool, iPad.token)).toBe(true);

      expect((await familyRows(iPad.familyId))[0]!.revoked_at).toBeInstanceOf(Date);
      expect((await familyRows(laptop.familyId))[0]!.revoked_at).toBeNull();
      expect(await rotateRefreshToken(pool, iPad.token)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('revokeSession reports false for a token it does not know', async () => {
      expect(await revokeSession(pool, 'nonsense')).toBe(false);
    });

    it("revokeAllForUser kills every family of that user and nobody else's", async () => {
      const iPad = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const laptop = await issueRefreshToken(pool, { userId, deviceLabel: 'laptop' });
      const stranger = await issueRefreshToken(pool, { userId: otherUserId });

      expect(await revokeAllForUser(pool, userId)).toBe(2);

      expect((await familyRows(iPad.familyId))[0]!.revoked_at).toBeInstanceOf(Date);
      expect((await familyRows(laptop.familyId))[0]!.revoked_at).toBeInstanceOf(Date);
      expect((await familyRows(stranger.familyId))[0]!.revoked_at).toBeNull();
    });

    it('revokeDeviceSessions keeps one live family per device (design §13)', async () => {
      const oldIPad = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const laptop = await issueRefreshToken(pool, { userId, deviceLabel: 'laptop' });

      expect(await revokeDeviceSessions(pool, userId, 'iPad')).toBe(1);
      const newIPad = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });

      expect(await rotateRefreshToken(pool, oldIPad.token)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect((await familyRows(laptop.familyId))[0]!.revoked_at).toBeNull();
      expect((await rotateRefreshToken(pool, newIPad.token)).ok).toBe(true);
    });

    it('revokeDeviceSessions with no label does not sweep every labelled device', async () => {
      const labelled = await issueRefreshToken(pool, { userId, deviceLabel: 'iPad' });
      const unlabelled = await issueRefreshToken(pool, { userId, deviceLabel: null });

      expect(await revokeDeviceSessions(pool, userId, null)).toBe(1);
      expect((await familyRows(labelled.familyId))[0]!.revoked_at).toBeNull();
      expect((await familyRows(unlabelled.familyId))[0]!.revoked_at).toBeInstanceOf(Date);
    });
  });
});
