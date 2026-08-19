import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { issueInvite, refundExpiredInvites, remainingBudget, revokeInvite } from './issue.ts';
import { hashInviteToken } from './token.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run issue.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

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
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const PREFIX = `inviteissue${RUN_ID}`;

let counter = 0;

async function makeUser(budget = 0): Promise<string> {
  counter += 1;
  const suffix = `${PREFIX}${counter}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, email, handle, platform_invite_budget)
     values ($1, $2, $3, $4) returning id`,
    [`Invite Issue Test ${suffix}`, `${suffix}@example.test`, suffix, budget],
  );
  return rows[0]!.id;
}

function inviteeEmail(): string {
  counter += 1;
  return `${PREFIX}invitee${counter}@example.test`;
}

function inDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function budgetOf(userId: string): Promise<number> {
  const { rows } = await pool.query<{ platform_invite_budget: number }>(
    'select platform_invite_budget from users where id = $1',
    [userId],
  );
  return rows[0]!.platform_invite_budget;
}

describe('issuing, revoking and refunding invites (design §12)', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await pool.query('delete from invites where email like $1', [`${PREFIX}%`]);
    await pool.query('delete from audit_log where actor_id in (select id from users where handle like $1)', [
      `${PREFIX}%`,
    ]).catch(() => {});
    await pool.query('delete from users where handle like $1', [`${PREFIX}%`]);
    await pool.end();
  });

  it('stores only the hash of the token, and returns the plaintext exactly once', async () => {
    const teacher = await makeUser(2);
    const result = await issueInvite(pool, {
      issuerId: teacher,
      kind: 'platform',
      email: inviteeEmail(),
      courseId: null,
      expiresAt: inDays(14),
      createsAccount: true,
      consumesBudget: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await pool.query<{ token_hash: string }>('select token_hash from invites where id = $1', [
      result.invite.id,
    ]);
    expect(rows[0]!.token_hash).toBe(hashInviteToken(result.invite.token));
    expect(rows[0]!.token_hash).not.toBe(result.invite.token);
  });

  it('DECREMENTS THE BUDGET ON ISSUE, not on acceptance', async () => {
    const teacher = await makeUser(3);
    await issueInvite(pool, {
      issuerId: teacher,
      kind: 'platform',
      email: inviteeEmail(),
      courseId: null,
      expiresAt: inDays(14),
      createsAccount: true,
      consumesBudget: true,
    });
    // Nothing has been accepted; the unit is already gone.
    expect(await budgetOf(teacher)).toBe(2);
  });

  it('refuses an issue when the budget is exhausted', async () => {
    const teacher = await makeUser(0);
    const result = await issueInvite(pool, {
      issuerId: teacher,
      kind: 'platform',
      email: inviteeEmail(),
      courseId: null,
      expiresAt: inDays(14),
      createsAccount: true,
      consumesBudget: true,
    });
    expect(result).toEqual({ ok: false, reason: 'budget_exhausted' });
    const { rowCount } = await pool.query('select 1 from invites where issued_by = $1', [teacher]);
    expect(rowCount).toBe(0);
  });

  it('does not charge an unlimited issuer (§12: admin platform invites are unlimited)', async () => {
    const admin = await makeUser(0);
    const result = await issueInvite(pool, {
      issuerId: admin,
      kind: 'platform',
      email: inviteeEmail(),
      courseId: null,
      expiresAt: inDays(14),
      createsAccount: true,
      consumesBudget: false,
    });
    expect(result.ok).toBe(true);
    expect(await budgetOf(admin)).toBe(0);
  });

  it('two SIMULTANEOUS issues against a budget of 1 yield exactly one invite', async () => {
    const teacher = await makeUser(1);
    const [a, b] = await Promise.all([
      issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      }),
      issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await budgetOf(teacher)).toBe(0);
    const { rowCount } = await pool.query('select 1 from invites where issued_by = $1', [teacher]);
    expect(rowCount).toBe(1);
  });

  it('writes invite.issued to audit_log — without the token', async () => {
    const teacher = await makeUser(1);
    const email = inviteeEmail();
    const result = await issueInvite(pool, {
      issuerId: teacher,
      kind: 'platform',
      email,
      courseId: null,
      expiresAt: inDays(14),
      createsAccount: true,
      consumesBudget: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await pool.query<{ action: string; target: string; meta: Record<string, unknown> }>(
      'select action, target, meta from audit_log where actor_id = $1',
      [teacher],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('invite.issued');
    expect(rows[0]!.target).toBe(result.invite.id);
    expect(rows[0]!.meta.email).toBe(email);
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(result.invite.token);
  });

  describe('refunds', () => {
    it('REFUNDS ON REVOCATION, once', async () => {
      const teacher = await makeUser(1);
      const issued = await issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      expect(await budgetOf(teacher)).toBe(0);

      const revoked = await revokeInvite(pool, {
        inviteId: issued.invite.id,
        actorId: teacher,
        scopeToIssuer: true,
      });
      expect(revoked).toEqual({ ok: true, refunded: true });
      expect(await budgetOf(teacher)).toBe(1);

      // A second revocation is not a second refund.
      const again = await revokeInvite(pool, { inviteId: issued.invite.id, actorId: teacher, scopeToIssuer: true });
      expect(again).toEqual({ ok: false, reason: 'not_revocable' });
      expect(await budgetOf(teacher)).toBe(1);
    });

    it('refuses to revoke another issuer’s invite when scoped to the issuer', async () => {
      const teacher = await makeUser(1);
      const stranger = await makeUser(0);
      const issued = await issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      });
      if (!issued.ok) throw new Error('expected the issue to succeed');

      const denied = await revokeInvite(pool, {
        inviteId: issued.invite.id,
        actorId: stranger,
        scopeToIssuer: true,
      });
      expect(denied).toEqual({ ok: false, reason: 'not_revocable' });
      expect(await budgetOf(teacher)).toBe(0);

      // An admin (unscoped) can, and the unit still goes back to the issuer.
      const allowed = await revokeInvite(pool, {
        inviteId: issued.invite.id,
        actorId: stranger,
        scopeToIssuer: false,
      });
      expect(allowed).toEqual({ ok: true, refunded: true });
      expect(await budgetOf(teacher)).toBe(1);
    });

    it('REFUNDS ON EXPIRY, lazily and exactly once', async () => {
      const teacher = await makeUser(1);
      const issued = await issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      });
      if (!issued.ok) throw new Error('expected the issue to succeed');
      expect(await budgetOf(teacher)).toBe(0);

      // Age it past its expiry rather than waiting for one.
      await pool.query(`update invites set expires_at = now() - interval '1 minute' where id = $1`, [
        issued.invite.id,
      ]);

      expect(await refundExpiredInvites(pool, teacher)).toBe(1);
      expect(await budgetOf(teacher)).toBe(1);

      // The sweep is idempotent: the unit does not come back twice.
      expect(await refundExpiredInvites(pool, teacher)).toBe(0);
      expect(await budgetOf(teacher)).toBe(1);
    });

    it('never refunds an ACCEPTED invite — the unit bought an account', async () => {
      const teacher = await makeUser(1);
      const issued = await issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      });
      if (!issued.ok) throw new Error('expected the issue to succeed');

      await pool.query(`update invites set accepted_at = now(), expires_at = now() - interval '1 minute' where id = $1`, [
        issued.invite.id,
      ]);

      expect(await refundExpiredInvites(pool, teacher)).toBe(0);
      expect(await budgetOf(teacher)).toBe(0);
      const revoked = await revokeInvite(pool, { inviteId: issued.invite.id, actorId: teacher, scopeToIssuer: true });
      expect(revoked).toEqual({ ok: false, reason: 'not_revocable' });
      expect(await budgetOf(teacher)).toBe(0);
    });

    it('remainingBudget sweeps first, so a stale expired invite never hides a free unit', async () => {
      const teacher = await makeUser(1);
      const issued = await issueInvite(pool, {
        issuerId: teacher,
        kind: 'platform',
        email: inviteeEmail(),
        courseId: null,
        expiresAt: inDays(14),
        createsAccount: true,
        consumesBudget: true,
      });
      if (!issued.ok) throw new Error('expected the issue to succeed');
      await pool.query(`update invites set expires_at = now() - interval '1 second' where id = $1`, [issued.invite.id]);

      expect(await remainingBudget(pool, teacher)).toBe(1);
    });
  });
});
