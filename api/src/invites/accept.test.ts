import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { acceptInvite } from './accept.ts';
import { issueInvite } from './issue.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run accept.test.ts');
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
const PREFIX = `inviteaccept${RUN_ID}`;

let counter = 0;
const PASSWORD = 'a-perfectly-fine-password';

/** A recognisable stand-in for Argon2id — the real hasher is wired in at the route. */
const hashPassword = async (plaintext: string): Promise<string> => `hashed:${plaintext}`;

function next(): string {
  counter += 1;
  return `${PREFIX}${counter}`;
}

async function makeIssuer(budget = 100): Promise<string> {
  const suffix = next();
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, email, handle, platform_invite_budget) values ($1, $2, $3, $4) returning id`,
    [`Invite Accept Test ${suffix}`, `${suffix}@example.test`, suffix, budget],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'teacher')`, [id]);
  return id;
}

let courseId: string;
let courseSlug: string;

function inDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Opens `n` connections and releases them back to the pool.
 *
 * Same reason as routes/setup.test.ts's warmPool: without it the "parallel"
 * acceptances are not parallel where it counts. The first caller gets a warm
 * idle client and finishes its whole transaction in a few sub-millisecond
 * round trips while the second is still waiting on a TCP connect + auth
 * handshake, so the second arrives to find the invite already spent — which
 * is a SEQUENCE, not a race, and a read-then-write claim passes it. Verified:
 * with the claim swapped for `select … then update`, this test passes without
 * the warm-up and fails with it (two accounts, two handles, both `ok`).
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

interface IssuedFixture {
  token: string;
  id: string;
  email: string;
}

async function issue(
  issuerId: string,
  options: { kind?: 'platform' | 'course'; createsAccount?: boolean; email?: string } = {},
): Promise<IssuedFixture> {
  const email = options.email ?? `${next()}@example.test`;
  const kind = options.kind ?? 'platform';
  const result = await issueInvite(pool, {
    issuerId,
    kind,
    email,
    courseId: kind === 'course' ? courseId : null,
    expiresAt: inDays(14),
    createsAccount: options.createsAccount ?? true,
    consumesBudget: options.createsAccount ?? true,
  });
  if (!result.ok) throw new Error('fixture: the issue was refused');
  return { token: result.invite.token, id: result.invite.id, email };
}

describe('accepting an invite (design §12, §13)', () => {
  let issuer: string;

  beforeAll(async () => {
    await applyMigrations();
    issuer = await makeIssuer();
    courseSlug = `${PREFIX}-course`;
    const { rows } = await pool.query<{ id: string }>(
      `insert into courses (slug, title, visibility, owner_id) values ($1, $2, 'restricted', $3) returning id`,
      [courseSlug, 'Invite Accept Test Course', issuer],
    );
    courseId = rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from enrollments where course_id = $1', [courseId]);
    // audit_log rows are deliberately left behind: migration 0005 makes the
    // table append-only with a BEFORE DELETE trigger, so a test that tidied
    // up after itself would be testing a table nobody else has.
    await pool.query('delete from invites where email like $1', [`${PREFIX}%`]);
    await pool.query('delete from courses where slug like $1', [`${PREFIX}%`]);
    await pool.query('delete from user_roles where user_id in (select id from users where handle like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from users where handle like $1', [`${PREFIX}%`]);
    await pool.end();
  });

  it('registers AND enrols in a single step for a course invite', async () => {
    const invite = await issue(issuer, { kind: 'course' });
    const handle = next();

    const result = await acceptInvite(
      pool,
      { token: invite.token, handle, password: PASSWORD, displayName: 'New Learner', timezone: null, actorId: null },
      { hashPassword },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe(invite.email);
    expect(result.user.handle).toBe(handle);
    expect(result.user.roles).toEqual(['student']);
    expect(result.courseSlug).toBe(courseSlug);
    expect(result.enrolled).toBe(true);

    const enrolment = await pool.query<{ status: string }>(
      'select status from enrollments where user_id = $1 and course_id = $2',
      [result.user.id, courseId],
    );
    expect(enrolment.rows[0]!.status).toBe('active');

    const credential = await pool.query<{ password_hash: string }>('select password_hash from users where id = $1', [
      result.user.id,
    ]);
    expect(credential.rows[0]!.password_hash).toBe(`hashed:${PASSWORD}`);

    const audit = await pool.query<{ action: string }>('select action from audit_log where target = $1', [invite.id]);
    expect(audit.rows.map((r) => r.action)).toContain('invite.accepted');
  });

  it('registers with no enrolment for a platform invite', async () => {
    const invite = await issue(issuer, { kind: 'platform' });
    const result = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.courseSlug).toBeNull();
    expect(result.enrolled).toBe(false);
  });

  it('TWO SIMULTANEOUS ACCEPTANCES of one token create exactly one account', async () => {
    const invite = await issue(issuer, { kind: 'course' });
    const handleA = next();
    const handleB = next();
    await warmPool(2);

    const [a, b] = await Promise.all([
      acceptInvite(
        pool,
        { token: invite.token, handle: handleA, password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword },
      ),
      acceptInvite(
        pool,
        { token: invite.token, handle: handleB, password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword },
      ),
    ]);

    // Exactly one winner, and the loser is told the invite is spent — not
    // handed a second account.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.reason).toBe('unusable');

    const accounts = await pool.query('select id from users where email = $1', [invite.email]);
    expect(accounts.rowCount).toBe(1);

    const handles = await pool.query('select 1 from users where handle in ($1, $2)', [handleA, handleB]);
    expect(handles.rowCount).toBe(1);

    const enrolments = await pool.query('select 1 from enrollments where course_id = $1 and user_id = (select id from users where email = $2)', [courseId, invite.email]);
    expect(enrolments.rowCount).toBe(1);

    // One acceptance, one audit entry. Two would mean the link was spent
    // twice even though only one account came out of it.
    const audit = await pool.query(`select 1 from audit_log where action = 'invite.accepted' and target = $1`, [
      invite.id,
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it('a SINGLE-USE link stays single-use when two signed-in acceptances collide', async () => {
    // The unique index on users.email is a second line of defence for the
    // registering shape — two racing registrations for one address collide
    // there whatever the claim does. This shape has no such backstop: the
    // account already exists, so nothing but the claim itself stops one link
    // being redeemed twice. Under a read-then-write claim BOTH calls return
    // ok and the invite is accepted twice.
    const suffix = next();
    const email = `${suffix}@example.test`;
    const { rows } = await pool.query<{ id: string }>(
      'insert into users (email, handle, display_name) values ($1, $2, $3) returning id',
      [email, suffix, 'Already Has An Account'],
    );
    const userId = rows[0]!.id;
    const invite = await issue(issuer, { kind: 'course', createsAccount: false, email });

    await warmPool(2);
    const attempt = () =>
      acceptInvite(
        pool,
        { token: invite.token, handle: null, password: null, displayName: null, timezone: null, actorId: userId },
        { hashPassword },
      );
    const [a, b] = await Promise.all([attempt(), attempt()]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const audit = await pool.query(`select 1 from audit_log where action = 'invite.accepted' and target = $1`, [
      invite.id,
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it('refuses a revoked invite', async () => {
    const invite = await issue(issuer);
    await pool.query('update invites set revoked_at = now() where id = $1', [invite.id]);
    const result = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unusable');
    expect((await pool.query('select 1 from users where email = $1', [invite.email])).rowCount).toBe(0);
  });

  it('refuses an expired invite', async () => {
    const invite = await issue(issuer);
    await pool.query(`update invites set expires_at = now() - interval '1 second' where id = $1`, [invite.id]);
    const result = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unusable');
    expect((await pool.query('select 1 from users where email = $1', [invite.email])).rowCount).toBe(0);
  });

  it('refuses an invite that has already been accepted', async () => {
    const invite = await issue(issuer);
    const first = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(first.ok).toBe(true);
    const second = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('unusable');
  });

  it('a WRONG TOKEN does not consume the claim', async () => {
    const invite = await issue(issuer);
    const wrong = await acceptInvite(
      pool,
      { token: 'not-the-token', handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(wrong.ok).toBe(false);

    const stillGood = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(stillGood.ok).toBe(true);
  });

  it('a taken handle releases the claim rather than burning the invite', async () => {
    const invite = await issue(issuer);
    const taken = next();
    await pool.query('insert into users (display_name, email, handle) values ($1, $2, $3)', [
      'Squatter',
      `${taken}@example.test`,
      taken,
    ]);

    const collided = await acceptInvite(
      pool,
      { token: invite.token, handle: taken, password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(collided.ok).toBe(false);
    if (!collided.ok) expect(collided.reason).toBe('taken');

    const retried = await acceptInvite(
      pool,
      { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
      { hashPassword },
    );
    expect(retried.ok).toBe(true);
  });

  describe('an invite for an address that already has an account', () => {
    it('enrols the signed-in invitee and creates no second account', async () => {
      const suffix = next();
      const existing = await pool.query<{ id: string }>(
        'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
        ['Existing Learner', `${suffix}@example.test`, suffix],
      );
      const userId = existing.rows[0]!.id;
      await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [userId]);

      const invite = await issue(issuer, {
        kind: 'course',
        createsAccount: false,
        email: `${suffix}@example.test`,
      });

      const result = await acceptInvite(
        pool,
        { token: invite.token, handle: null, password: null, displayName: null, timezone: null, actorId: userId },
        { hashPassword },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user.id).toBe(userId);
      expect(result.enrolled).toBe(true);
      expect((await pool.query('select 1 from users where email = $1', [invite.email])).rowCount).toBe(1);
    });

    it('refuses to register a new account on it, however good the handle is', async () => {
      const suffix = next();
      await pool.query('insert into users (display_name, email, handle) values ($1, $2, $3)', [
        'Existing Learner',
        `${suffix}@example.test`,
        suffix,
      ]);
      const invite = await issue(issuer, { createsAccount: false, email: `${suffix}@example.test` });

      const result = await acceptInvite(
        pool,
        { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('sign_in_required');
      // And the claim is released: the invitee can still accept it properly.
      const { rows } = await pool.query<{ accepted_at: Date | null }>('select accepted_at from invites where id = $1', [
        invite.id,
      ]);
      expect(rows[0]!.accepted_at).toBeNull();
    });

    it('refuses a signed-in actor who is not the invitee', async () => {
      const suffix = next();
      const invitee = await pool.query<{ id: string }>(
        'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
        ['Invitee', `${suffix}@example.test`, suffix],
      );
      const otherSuffix = next();
      const other = await pool.query<{ id: string }>(
        'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
        ['Someone Else', `${otherSuffix}@example.test`, otherSuffix],
      );
      const invite = await issue(issuer, {
        kind: 'course',
        createsAccount: false,
        email: `${suffix}@example.test`,
      });

      const result = await acceptInvite(
        pool,
        {
          token: invite.token,
          handle: null,
          password: null,
          displayName: null,
          timezone: null,
          actorId: other.rows[0]!.id,
        },
        { hashPassword },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('sign_in_required');
      expect(
        (await pool.query('select 1 from enrollments where user_id = $1 and course_id = $2', [
          invitee.rows[0]!.id,
          courseId,
        ])).rowCount,
      ).toBe(0);
    });
  });

  /**
   * THE EXPENSIVE WORK HAPPENS ONLY FOR A CALLER WHO HOLDS A LIVE INVITE.
   *
   * acceptInvite is reachable without an account — the token IS the
   * credential — and nothing rate-limits it. It used to run Argon2id (19 MiB,
   * ~100ms, deliberately) BEFORE the claim, so one anonymous request with a
   * junk token bought a memory-hard hash from anybody who could reach the
   * port.
   *
   * Counted rather than timed: the ordering is the property, and a counter
   * cannot flake the way a stopwatch can.
   */
  describe('a caller without a usable invite cannot make the server do Argon2id work', () => {
    function countingHasher() {
      let calls = 0;
      return {
        calls: () => calls,
        hashPassword: async (plaintext: string): Promise<string> => {
          calls += 1;
          return `hashed:${plaintext}`;
        },
      };
    }

    it('hashes nothing for a token that matches no invite', async () => {
      const hasher = countingHasher();
      const result = await acceptInvite(
        pool,
        {
          token: 'this-token-was-never-issued',
          handle: next(),
          password: PASSWORD,
          displayName: null,
          timezone: null,
          actorId: null,
        },
        { hashPassword: hasher.hashPassword },
      );

      expect(result.ok).toBe(false);
      expect(hasher.calls(), 'an unknown token still cost the server an Argon2id hash').toBe(0);
    });

    it('hashes nothing for an invite that was already accepted', async () => {
      const invite = await issue(issuer, { kind: 'platform' });
      const first = await acceptInvite(
        pool,
        { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword },
      );
      expect(first.ok).toBe(true);

      const hasher = countingHasher();
      const second = await acceptInvite(
        pool,
        { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword: hasher.hashPassword },
      );

      expect(second.ok).toBe(false);
      expect(hasher.calls(), 'a spent invite still cost the server an Argon2id hash').toBe(0);
    });

    it('hashes nothing for a revoked invite', async () => {
      const invite = await issue(issuer, { kind: 'platform' });
      await pool.query('update invites set revoked_at = now() where id = $1', [invite.id]);

      const hasher = countingHasher();
      const result = await acceptInvite(
        pool,
        { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword: hasher.hashPassword },
      );

      expect(result.ok).toBe(false);
      expect(hasher.calls()).toBe(0);
    });

    it('still hashes for the invitee who does hold a live invite', async () => {
      // The guard must not have become "never hash".
      const invite = await issue(issuer, { kind: 'platform' });
      const hasher = countingHasher();

      const result = await acceptInvite(
        pool,
        { token: invite.token, handle: next(), password: PASSWORD, displayName: null, timezone: null, actorId: null },
        { hashPassword: hasher.hashPassword },
      );

      expect(result.ok).toBe(true);
      expect(hasher.calls()).toBe(1);
    });
  });

});
