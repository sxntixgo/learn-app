import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEV_ACTOR } from '../policy/can.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run identity-schema.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors me.test.ts / progress.test.ts's own copy — see those for the
// rationale (each DB-touching test file owns its migration bootstrap).
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

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let handleCounter = 0;

/** Inserts a throwaway users row and returns its id. Unique per call and per run. */
async function makeUser(overrides: { email?: string | null; handle?: string | null } = {}): Promise<string> {
  handleCounter += 1;
  const suffix = `${RUN_ID}-${handleCounter}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const email = overrides.email === undefined ? `schema-${suffix}@example.test` : overrides.email;
  const handle = overrides.handle === undefined ? `schema${suffix}` : overrides.handle;
  const { rows } = await pool.query<{ id: string }>(
    'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
    [`Identity Schema Test ${suffix}`, email, handle],
  );
  return rows[0]!.id;
}

/** Runs `fn` and returns the Postgres error, failing the test if none is raised. */
async function expectPgError(fn: () => Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await fn();
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error('expected the database to reject this statement, but it succeeded');
}

const createdUsers: string[] = [];

describe('identity schema (migration 0005)', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    // audit_log deliberately has no FK to users (it must outlive the accounts
    // it describes), so deleting these rows is possible here; user_roles
    // cascades from users.
    if (createdUsers.length > 0) {
      await pool.query('delete from users where id = any($1::uuid[])', [createdUsers]);
    }
    await pool.end();
  });

  describe('users', () => {
    it('keeps the DEV_ACTOR row seeded by 0004 (phases 1-5 data depends on it)', async () => {
      const { rows } = await pool.query<{ id: string; display_name: string | null; avatar_kind: string }>(
        'select id, display_name, avatar_kind from users where id = $1',
        [DEV_ACTOR.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.display_name).toBe('Dev User');
      // Backfilled by the column default rather than left null.
      expect(rows[0]!.avatar_kind).toBe('identicon');
    });

    it('rejects a duplicate email', async () => {
      const email = `dupe-${RUN_ID}@example.test`;
      createdUsers.push(await makeUser({ email }));
      const err = await expectPgError(() => makeUser({ email }));
      expect(err.code).toBe('23505');
    });

    it('rejects an email that is not lower-cased (so uniqueness is case-insensitive)', async () => {
      const err = await expectPgError(() => makeUser({ email: `Mixed-${RUN_ID}@Example.Test` }));
      expect(err.code).toBe('23514');
    });

    it('rejects a duplicate handle', async () => {
      const handle = `duphandle${RUN_ID.replace(/[^a-z0-9]/gi, '')}`;
      createdUsers.push(await makeUser({ handle }));
      const err = await expectPgError(() => makeUser({ handle }));
      expect(err.code).toBe('23505');
    });

    it.each([
      ['Santiago', 'upper case'],
      ['has space', 'a space'],
      ['a', 'too short'],
      ['-leading', 'a leading hyphen'],
      ['sql;drop', 'punctuation'],
      ['emoji🙂', 'non-ascii'],
    ])('rejects the handle %j (%s)', async (handle) => {
      const err = await expectPgError(() => makeUser({ handle }));
      expect(err.code).toBe('23514');
    });

    it('accepts a URL-safe handle', async () => {
      const id = await makeUser({ handle: `ok-handle_9${handleCounter}` });
      createdUsers.push(id);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an unknown avatar_kind', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      const err = await expectPgError(() =>
        pool.query('update users set avatar_kind = $2 where id = $1', [id, 'svg']),
      );
      expect(err.code).toBe('23514');
    });

    it('links an operator account to a student account via operator_for', async () => {
      const student = await makeUser();
      const admin = await makeUser();
      createdUsers.push(student, admin);
      await pool.query('update users set operator_for = $2 where id = $1', [admin, student]);
      const { rows } = await pool.query<{ operator_for: string }>('select operator_for from users where id = $1', [
        admin,
      ]);
      expect(rows[0]!.operator_for).toBe(student);
    });

    it('refuses to make an account its own operator', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      const err = await expectPgError(() => pool.query('update users set operator_for = id where id = $1', [id]));
      expect(err.code).toBe('23514');
    });

    it('refuses two operator accounts for the same student', async () => {
      const student = await makeUser();
      const adminOne = await makeUser();
      const adminTwo = await makeUser();
      createdUsers.push(student, adminOne, adminTwo);
      await pool.query('update users set operator_for = $2 where id = $1', [adminOne, student]);
      const err = await expectPgError(() =>
        pool.query('update users set operator_for = $2 where id = $1', [adminTwo, student]),
      );
      expect(err.code).toBe('23505');
    });
  });

  describe('user_roles', () => {
    it('lets student and teacher coexist (design §5: roles are a set, not a ladder)', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      await pool.query('insert into user_roles (user_id, role) values ($1, $2), ($1, $3)', [id, 'student', 'teacher']);
      const { rows } = await pool.query<{ role: string }>(
        'select role from user_roles where user_id = $1 order by role',
        [id],
      );
      expect(rows.map((r) => r.role)).toEqual(['student', 'teacher']);
    });

    it('rejects an unknown role', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      const err = await expectPgError(() =>
        pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, 'superuser']),
      );
      expect(err.code).toBe('23514');
    });

    // The headline invariant of design §5.1: admin is exclusive, enforced by
    // the DATABASE and not by an application check that a future code path
    // could forget to call.
    it.each([['student'], ['teacher']])('refuses to grant %s to an account that already holds admin', async (role) => {
      const id = await makeUser();
      createdUsers.push(id);
      await pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, 'admin']);
      const err = await expectPgError(() =>
        pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, role]),
      );
      expect(err.code).toBe('23P01' /* exclusion_violation */);
    });

    it.each([['student'], ['teacher']])('refuses to grant admin to an account that already holds %s', async (role) => {
      const id = await makeUser();
      createdUsers.push(id);
      await pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, role]);
      const err = await expectPgError(() =>
        pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, 'admin']),
      );
      expect(err.code).toBe('23P01');
    });

    it('refuses admin and student inserted by the same statement', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      const err = await expectPgError(() =>
        pool.query('insert into user_roles (user_id, role) values ($1, $2), ($1, $3)', [id, 'admin', 'student']),
      );
      expect(err.code).toBe('23P01');
    });

    it('refuses to widen an existing admin row into a student row by UPDATE', async () => {
      const id = await makeUser();
      createdUsers.push(id);
      await pool.query('insert into user_roles (user_id, role) values ($1, $2), ($1, $3)', [id, 'student', 'teacher']);
      const err = await expectPgError(() =>
        pool.query('update user_roles set role = $2 where user_id = $1 and role = $3', [id, 'admin', 'teacher']),
      );
      expect(err.code).toBe('23P01');
    });

    it('refuses concurrent admin and student grants to the same account', async () => {
      // A trigger reading user_roles would let these two transactions pass
      // each other under READ COMMITTED and commit a forbidden pair. The
      // exclusion constraint makes the second one block and then fail.
      const id = await makeUser();
      createdUsers.push(id);

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('begin');
        await b.query('begin');
        await a.query('insert into user_roles (user_id, role) values ($1, $2)', [id, 'admin']);
        const bInsert = b.query('insert into user_roles (user_id, role) values ($1, $2)', [id, 'student']);
        await a.query('commit');

        const settled = await Promise.allSettled([bInsert]);
        expect(settled[0]!.status).toBe('rejected');
        await b.query('rollback');
      } finally {
        a.release();
        b.release();
      }

      const { rows } = await pool.query<{ role: string }>('select role from user_roles where user_id = $1', [id]);
      expect(rows.map((r) => r.role)).toEqual(['admin']);
    });
  });

  describe('instance_state', () => {
    it('holds exactly one row, and the schema refuses a second', async () => {
      const { rows } = await pool.query<{ id: number }>('select id from instance_state');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(1);

      const err = await expectPgError(() => pool.query('insert into instance_state (id) values (2)'));
      expect(err.code).toBe('23514');
    });

    it('refuses to keep a setup token hash once the instance is bootstrapped', async () => {
      const err = await expectPgError(() =>
        pool.query('update instance_state set bootstrapped_at = now(), setup_token_hash = $1 where id = 1', ['abc']),
      );
      expect(err.code).toBe('23514');
    });
  });

  describe('invites', () => {
    it('requires a course_id for a course invite and forbids one for a platform invite', async () => {
      const issuer = await makeUser();
      createdUsers.push(issuer);

      const platform = await expectPgError(() =>
        pool.query(
          `insert into invites (kind, issued_by, email, token_hash, course_id, expires_at)
           values ('platform', $1, $2, $3, gen_random_uuid(), now() + interval '7 days')`,
          [issuer, `invite-${RUN_ID}@example.test`, `hash-platform-${RUN_ID}`],
        ),
      );
      expect(platform.code).toBe('23514');

      const course = await expectPgError(() =>
        pool.query(
          `insert into invites (kind, issued_by, email, token_hash, expires_at)
           values ('course', $1, $2, $3, now() + interval '7 days')`,
          [issuer, `invite-${RUN_ID}@example.test`, `hash-course-${RUN_ID}`],
        ),
      );
      expect(course.code).toBe('23514');
    });

    it('stores a platform invite and rejects a duplicate token hash', async () => {
      const issuer = await makeUser();
      createdUsers.push(issuer);
      const tokenHash = `hash-unique-${RUN_ID}`;
      await pool.query(
        `insert into invites (kind, issued_by, email, token_hash, expires_at)
         values ('platform', $1, $2, $3, now() + interval '7 days')`,
        [issuer, `invite2-${RUN_ID}@example.test`, tokenHash],
      );
      const err = await expectPgError(() =>
        pool.query(
          `insert into invites (kind, issued_by, email, token_hash, expires_at)
           values ('platform', $1, $2, $3, now() + interval '7 days')`,
          [issuer, `invite3-${RUN_ID}@example.test`, tokenHash],
        ),
      );
      expect(err.code).toBe('23505');
      await pool.query('delete from invites where token_hash = $1', [tokenHash]);
    });

    it('rejects an unknown invite kind', async () => {
      const issuer = await makeUser();
      createdUsers.push(issuer);
      const err = await expectPgError(() =>
        pool.query(
          `insert into invites (kind, issued_by, email, token_hash, expires_at)
           values ('site', $1, $2, $3, now() + interval '7 days')`,
          [issuer, `invite4-${RUN_ID}@example.test`, `hash-kind-${RUN_ID}`],
        ),
      );
      expect(err.code).toBe('23514');
    });
  });

  describe('audit_log', () => {
    it('is append-only, like activity_events', async () => {
      const actorId = await makeUser();
      createdUsers.push(actorId);
      const { rows } = await pool.query<{ id: string }>(
        `insert into audit_log (actor_id, action, target, meta)
         values ($1, 'test.append_only', $2, '{"k":"v"}'::jsonb) returning id`,
        [actorId, `run-${RUN_ID}`],
      );
      const id = rows[0]!.id;

      const onUpdate = await expectPgError(() =>
        pool.query('update audit_log set action = $2 where id = $1', [id, 'test.tampered']),
      );
      expect(onUpdate.message).toMatch(/append-only/);

      const onDelete = await expectPgError(() => pool.query('delete from audit_log where id = $1', [id]));
      expect(onDelete.message).toMatch(/append-only/);
    });
  });
});
