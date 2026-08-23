import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MAX_DISPLAY_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } from './account-fields.ts';
import type { BootstrapRequest } from './bootstrap.ts';
import { bootstrapInstance, parseBootstrapRequest } from './bootstrap.ts';
import { hashSetupToken } from './setup-token.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run bootstrap.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pool = new Pool({ connectionString });

// Mirrors every other DB-touching test file: each owns its migration
// bootstrap, because tools/src/migrate.test.ts drops tables and vitest runs
// files sequentially in an order this file cannot depend on.
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
      if ((err as { code?: string }).code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

// =============================================================================
// This file tests auth/bootstrap.ts DIRECTLY, which routes/setup.test.ts
// cannot: the route can only ever call it through a well-formed HTTP request
// with the production wiring. The cases that matter most here are the ones
// that live below or beside that path —
//
//   * a body that is not an object at all (Fastify hands the handler whatever
//     JSON parsed to, including an array or a scalar),
//   * the CHEAP PRE-CHECK's contract, i.e. that no password is hashed for a
//     caller who does not hold the token — the module header calls hashing
//     first "a CPU and memory exhaustion primitive" and says the bug survived
//     one round of fixing, so it is worth an assertion of its own,
//   * the failure paths that must RELEASE the claim rather than burn it,
//   * and a setup token revoked in the window the pre-check opens.
// =============================================================================

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const TOKEN = `setup-token-${RUN_ID}`;
const PASSWORD = 'password-long-enough';

let seq = 0;

/** A fresh, valid account pair. Unique per call so no case can collide with another. */
function accountPair(): { admin: BootstrapRequest['admin']; student: BootstrapRequest['student'] } {
  seq += 1;
  return {
    admin: { email: `ops${seq}-${RUN_ID}@example.test`, handle: `ops${seq}${RUN_ID}`, password: PASSWORD, displayName: 'Operator' },
    student: { email: `stu${seq}-${RUN_ID}@example.test`, handle: `stu${seq}${RUN_ID}`, password: PASSWORD, displayName: null },
  };
}

function request(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  return { setupToken: TOKEN, ...accountPair(), timezone: null, ...overrides };
}

/** Puts the instance back where a fresh deployment starts: unclaimed, token armed. */
async function armInstance(token = TOKEN): Promise<void> {
  await pool.query(
    `update instance_state
        set bootstrapped_at = null, setup_token_hash = $1, setup_token_issued_at = now()
      where id = 1`,
    [hashSetupToken(token)],
  );
}

interface InstanceStateRow {
  bootstrapped_at: Date | null;
  setup_token_hash: string | null;
}

async function instanceState(): Promise<InstanceStateRow> {
  const { rows } = await pool.query<InstanceStateRow>(
    'select bootstrapped_at, setup_token_hash from instance_state where id = 1',
  );
  return rows[0]!;
}

async function usersFromThisRun(): Promise<{ id: string; email: string; handle: string; password_hash: string | null; operator_for: string | null }[]> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    handle: string;
    password_hash: string | null;
    operator_for: string | null;
  }>('select id, email, handle, password_hash, operator_for from users where email like $1 order by email', [
    `%${RUN_ID}@example.test`,
  ]);
  return rows;
}

async function deleteUsersFromThisRun(): Promise<void> {
  await pool.query('delete from user_roles where user_id in (select id from users where email like $1)', [
    `%${RUN_ID}@example.test`,
  ]);
  await pool.query('delete from users where email like $1', [`%${RUN_ID}@example.test`]);
}

// ---------------------------------------------------------------------------
// parseBootstrapRequest — everything here happens BEFORE the claim, so every
// refusal below has to leave the instance claimable.
// ---------------------------------------------------------------------------
describe('parseBootstrapRequest', () => {
  const valid = () => {
    const pair = accountPair();
    return { setupToken: TOKEN, admin: { ...pair.admin }, student: { ...pair.student }, timezone: 'America/Denver' };
  };

  it.each([
    ['null', null],
    ['an array', [{ setupToken: 'x' }]],
    ['a string', '{"setupToken":"x"}'],
    ['a number', 7],
    ['undefined', undefined],
  ])('refuses a body that is %s', (_label, body) => {
    // Fastify hands the handler whatever the JSON parser produced. `typeof
    // null === 'object'` and an array is an object too, so both need naming
    // explicitly — without them the reads below would be `undefined` lookups
    // that fall through to a confusing per-field message, or worse, a throw
    // on the one route that has no authentication in front of it.
    const result = parseBootstrapRequest(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('A JSON object body is required.');
  });

  it('refuses a setup token that is only whitespace', () => {
    // `' '` is truthy, so a form that posts an untouched, space-padded field
    // would otherwise reach the claim and be compared as a real token.
    const result = parseBootstrapRequest({ ...valid(), setupToken: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('setupToken is required.');
  });

  it('trims the setup token it accepts, because a copy-paste carries whitespace', () => {
    const result = parseBootstrapRequest({ ...valid(), setupToken: `  ${TOKEN}\n` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.setupToken).toBe(TOKEN);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a number', 12],
  ])('refuses an admin whose email is %s, distinctly from a malformed one', (_label, email) => {
    const body = valid();
    const result = parseBootstrapRequest({ ...body, admin: { ...body.admin, email } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "required" and "not a valid email address" are different problems and
    // the wizard shows the message verbatim.
    expect(result.message).toBe('admin.email is required.');
  });

  it('refuses an email longer than the column allows, before the pattern gets to it', () => {
    // 254 is the RFC's maximum and what the length check uses. An address
    // over it is refused here rather than at the database, which has no
    // length constraint of its own — so without this bound the only limit on
    // a stored email is the body size limit.
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.test'.length);
    const body = valid();
    expect(parseBootstrapRequest({ ...body, admin: { ...body.admin, email: `${local}@example.test` } }).ok).toBe(true);

    const second = valid();
    const result = parseBootstrapRequest({
      ...second,
      admin: { ...second.admin, email: `${local}x@example.test` },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('admin.email is not a valid email address.');
  });

  it.each([
    ['a number', 42],
    ['an object', { first: 'Ada' }],
    ['an array', ['Ada']],
    ['a boolean', true],
  ])('refuses a displayName that is %s', (_label, displayName) => {
    const body = valid();
    const result = parseBootstrapRequest({ ...body, student: { ...body.student, displayName } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('student.displayName must be a string when provided.');
  });

  it('accepts a displayName at the length limit and refuses one over it', () => {
    const atLimit = 'n'.repeat(MAX_DISPLAY_NAME_LENGTH);
    const first = valid();
    expect(parseBootstrapRequest({ ...first, admin: { ...first.admin, displayName: atLimit } }).ok).toBe(true);

    const second = valid();
    const result = parseBootstrapRequest({ ...second, admin: { ...second.admin, displayName: `${atLimit}o` } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`at most ${MAX_DISPLAY_NAME_LENGTH}`);
  });

  it('measures the displayName after trimming, not before', () => {
    // Otherwise a padded-but-legal name is refused for a length the user
    // cannot see, and the stored value would have been within the limit.
    const body = valid();
    const padded = `   ${'n'.repeat(MAX_DISPLAY_NAME_LENGTH)}   `;
    const result = parseBootstrapRequest({ ...body, admin: { ...body.admin, displayName: padded } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.admin.displayName).toBe('n'.repeat(MAX_DISPLAY_NAME_LENGTH));
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['only whitespace', '   '],
  ])('normalizes a displayName that is %s to null rather than to an empty string', (_label, displayName) => {
    // `display_name` is nullable and everything downstream falls back to the
    // handle when it is null. An empty string is not null, so it renders as a
    // blank name in every profile, feed entry and comment.
    const body = valid();
    const result = parseBootstrapRequest({ ...body, admin: { ...body.admin, displayName } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.admin.displayName).toBeNull();
  });

  it('refuses a password over the Argon2id input bound', () => {
    // The bound belongs to auth/account-fields.ts, but the assertion belongs
    // here too: this is the unauthenticated route, and it is the reason the
    // bound exists at all.
    const body = valid();
    const result = parseBootstrapRequest({
      ...body,
      student: { ...body.student, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('student.password');
  });

  it('keeps a valid timezone and turns an absent one into null', () => {
    const kept = parseBootstrapRequest(valid());
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.timezone).toBe('America/Denver');

    const body = valid();
    const absent = parseBootstrapRequest({ ...body, timezone: undefined });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value.timezone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bootstrapInstance
// ---------------------------------------------------------------------------
describe('bootstrapInstance', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await deleteUsersFromThisRun();
    await armInstance();
  });

  afterAll(async () => {
    await deleteUsersFromThisRun();
    // Leave the singleton as the other DB-touching files expect to find it.
    await pool.query(
      'update instance_state set bootstrapped_at = null, setup_token_hash = null, setup_token_issued_at = null where id = 1',
    );
    await pool.end();
  });

  // =========================================================================
  // THE PRE-CHECK'S WHOLE PURPOSE (module header): "a cheap read first, and
  // the expensive work only for a caller who actually holds the token."
  // Argon2id is 19 MiB and ~100ms PER CALL and this route is unauthenticated
  // and unthrottled by design, so hashing before the token is checked hands
  // any anonymous caller two of them per HTTP request. The header records
  // that the first fix missed the `gone` path, which is why both refusals get
  // their own assertion.
  // =========================================================================
  it('hashes NO password when the setup token is wrong', async () => {
    const hashPassword = vi.fn(async (plaintext: string) => `argon2id-of-${plaintext}`);

    const result = await bootstrapInstance(pool, request({ setupToken: 'not-the-token' }), { hashPassword });

    expect(result).toEqual({ ok: false, reason: 'unauthorized', message: 'Invalid setup token.' });
    expect(hashPassword).not.toHaveBeenCalled();
    // And the claim is untouched: a wrong guess must not consume it.
    const state = await instanceState();
    expect(state.bootstrapped_at).toBeNull();
    expect(state.setup_token_hash).toBe(hashSetupToken(TOKEN));
  });

  it('hashes NO password when the instance is already claimed, even with a valid-looking token', async () => {
    await pool.query('update instance_state set setup_token_hash = null, bootstrapped_at = now() where id = 1');
    const hashPassword = vi.fn(async (plaintext: string) => `argon2id-of-${plaintext}`);

    const result = await bootstrapInstance(pool, request(), { hashPassword });

    expect(result).toEqual({ ok: false, reason: 'gone', message: 'This instance has already been set up.' });
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('creates the linked operator/student pair with their roles and hashes both passwords once', async () => {
    const hashPassword = vi.fn(async (plaintext: string) => `argon2id-of-${plaintext}`);
    const req = request();

    const result = await bootstrapInstance(pool, req, { hashPassword });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admin.roles).toEqual(['admin']);
    expect(result.student.roles).toEqual(['student']);
    expect(hashPassword).toHaveBeenCalledTimes(2);

    const rows = await usersFromThisRun();
    const admin = rows.find((r) => r.email === req.admin.email)!;
    const student = rows.find((r) => r.email === req.student.email)!;
    // Design §5.1: the operator account points at the student, never the
    // other way round — `users_operator_for_key` gives a student at most one
    // operator, and reversing the direction would silently make the operator
    // the one that can only have one student.
    expect(admin.operator_for).toBe(student.id);
    expect(student.operator_for).toBeNull();
    // Each account gets its OWN hash: hashing once and reusing the digest
    // would make the two credentials the same secret.
    expect(admin.password_hash).toBe(`argon2id-of-${req.admin.password}`);
    expect(student.password_hash).toBe(`argon2id-of-${req.student.password}`);
  });

  it('leaves password_hash NULL when no hashing dependency is supplied', async () => {
    // BootstrapDeps documents this: "a placeholder hash is far more dangerous
    // than a null" — NULL means no credential (migration 0005) and
    // auth/password.ts treats it as an unconditional failure. An invented
    // scheme, or an empty string, would be a credential.
    const req = request();
    const result = await bootstrapInstance(pool, req);

    expect(result.ok).toBe(true);
    const rows = await usersFromThisRun();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.password_hash).toBeNull();
    }
  });

  // =========================================================================
  // FAILURE MUST RELEASE THE CLAIM, NOT BURN IT (function docstring: "a
  // failure partway through releases the claim rather than burning it, so a
  // fumbled wizard submission does not permanently brick a fresh instance").
  // Both of these run AFTER the atomic UPDATE has already matched the row.
  // =========================================================================
  it('reports a taken email as invalid and rolls the claim back, so the wizard can be resubmitted', async () => {
    const req = request();
    // Somebody — a pre-auth row from an earlier phase, a restored dump —
    // already owns the address the operator typed.
    await pool.query('insert into users (email, handle) values ($1, $2)', [req.admin.email, `pre${seq}${RUN_ID}`]);

    const result = await bootstrapInstance(pool, req);

    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      message: 'That email address or handle is already taken.',
    });

    const state = await instanceState();
    expect(state.bootstrapped_at).toBeNull();
    expect(state.setup_token_hash).toBe(hashSetupToken(TOKEN));

    // Nothing partial survived: no student account, no orphaned roles.
    const rows = await usersFromThisRun();
    expect(rows.map((r) => r.email)).toEqual([req.admin.email]);

    // And the retry with a free address really works — the point of not
    // burning the claim.
    const retry = await bootstrapInstance(pool, request());
    expect(retry.ok).toBe(true);
  });

  it('rethrows an unexpected database error instead of reporting it as a bad request', async () => {
    // Only 23505 (unique violation) is a user-fixable "that name is taken".
    // Anything else is a fault, and reporting it as a 400 would tell the
    // operator to edit a form that is not the problem. `request` is the type
    // parseBootstrapRequest produces, but bootstrapInstance is exported and
    // must not assume the caller validated: this handle trips
    // users_handle_url_safe (23514) inside the transaction.
    const req = request();
    req.student.handle = 'Not A Handle';

    await expect(bootstrapInstance(pool, req)).rejects.toMatchObject({ code: '23514' });

    // The claim went back with the transaction.
    const state = await instanceState();
    expect(state.bootstrapped_at).toBeNull();
    expect(state.setup_token_hash).toBe(hashSetupToken(TOKEN));
    expect(await usersFromThisRun()).toHaveLength(0);
  });

  // =========================================================================
  // THE PRE-CHECK IS NOT THE AUTHORIZATION (module header: "the atomic claim
  // inside the transaction still is, and it re-checks the same hash under the
  // row lock, so a token revoked in the microseconds between the two still
  // loses"). Password hashing is the slow step between the two reads, so the
  // hashing seam is exactly where that window can be opened deterministically
  // — a real restart re-arms the token there (auth/setup-token.ts rotates on
  // every boot).
  // =========================================================================
  it('loses to a setup token that was rotated after the pre-check passed', async () => {
    const rotated = `rotated-token-${RUN_ID}`;
    const hashPassword = vi.fn(async (plaintext: string) => {
      await armInstance(rotated);
      return `argon2id-of-${plaintext}`;
    });

    const result = await bootstrapInstance(pool, request(), { hashPassword });

    expect(result).toEqual({ ok: false, reason: 'unauthorized', message: 'Invalid setup token.' });
    // Unclaimed, and now claimable only with the NEW token.
    const state = await instanceState();
    expect(state.bootstrapped_at).toBeNull();
    expect(state.setup_token_hash).toBe(hashSetupToken(rotated));
    expect(await usersFromThisRun()).toHaveLength(0);

    expect((await bootstrapInstance(pool, request({ setupToken: rotated }))).ok).toBe(true);
  });

  it('tells a loser the instance is GONE, never that its token was wrong', async () => {
    // The token was right; somebody else's transaction committed the claim
    // while this one was hashing. What matters is that the loser is not told
    // "Invalid setup token" — that would send an operator hunting through
    // logs for a token that was never the problem.
    //
    // `gone` and not `conflict`, deterministically: the spy below fires
    // during HASHING, which is before the transaction opens, so the read at
    // the top of that transaction always sees the finished claim. Reaching
    // `conflict` needs the winner to commit in the narrow window between
    // that read and the UPDATE — a genuine race, which routes/setup.test.ts
    // exercises with warmPool and deliberately accepts either 409 or 410,
    // having already found that demanding 409 fails for timing rather than
    // for behaviour.
    const winner = request();
    const hashPassword = vi.fn(async (plaintext: string) => {
      if (hashPassword.mock.calls.length === 1) {
        expect((await bootstrapInstance(pool, winner)).ok).toBe(true);
      }
      return `argon2id-of-${plaintext}`;
    });

    const result = await bootstrapInstance(pool, request(), { hashPassword });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason, 'a loser must never be told its token was invalid').toBe('gone');
    expect(result.message).toBe('This instance has already been set up.');
    // Exactly one pair exists: the winner's.
    const rows = await usersFromThisRun();
    expect(rows.map((r) => r.email).sort()).toEqual([winner.admin.email, winner.student.email].sort());
  });

  it('refuses to answer at all when instance_state has no row, naming migrations', async () => {
    // A database that was created but never migrated would otherwise answer
    // "Invalid setup token" forever, sending the operator to hunt for a token
    // that was never issued.
    await pool.query('delete from instance_state where id = 1');
    try {
      await expect(bootstrapInstance(pool, request())).rejects.toThrow(/run migrations/i);
    } finally {
      await pool.query('insert into instance_state (id) values (1) on conflict (id) do nothing');
    }
  });
});
