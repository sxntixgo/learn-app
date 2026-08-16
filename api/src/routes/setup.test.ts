import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { hashSetupToken } from '../auth/setup-token.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run setup.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors me.test.ts / progress.test.ts's own copy — each DB-touching test
// file owns its migration bootstrap.
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
const TOKEN = 'setup-token-for-tests-0123456789abcdef';
const ADMIN_EMAIL = `ops-${RUN_ID}@example.test`;
const STUDENT_EMAIL = `learner-${RUN_ID}@example.test`;
const ADMIN_HANDLE = `ops${RUN_ID}`;
const STUDENT_HANDLE = `learner${RUN_ID}`;

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setupToken: TOKEN,
    admin: {
      email: ADMIN_EMAIL,
      handle: ADMIN_HANDLE,
      password: 'correct-horse-battery-staple',
      displayName: 'Ops Account',
    },
    student: {
      email: STUDENT_EMAIL,
      handle: STUDENT_HANDLE,
      password: 'another-long-enough-password',
      displayName: 'Learner Account',
    },
    timezone: 'Europe/Madrid',
    ...overrides,
  };
}

/** Puts the instance back to "fresh install, token issued". */
async function resetInstanceState(): Promise<void> {
  await pool.query(
    `update instance_state
        set bootstrapped_at = null, setup_token_hash = $1, setup_token_issued_at = now()
      where id = 1`,
    [hashSetupToken(TOKEN)],
  );
}

/** Removes every account this file's tests created. */
async function deleteTestUsers(): Promise<void> {
  // operator_for is a self-FK, so clear the link before deleting.
  await pool.query('update users set operator_for = null where email like $1', [`%${RUN_ID}@example.test`]);
  await pool.query('delete from users where email like $1', [`%${RUN_ID}@example.test`]);
}

interface InstanceStateRow {
  bootstrapped_at: Date | null;
  setup_token_hash: string | null;
}

async function readInstanceState(): Promise<InstanceStateRow> {
  const { rows } = await pool.query<InstanceStateRow>(
    'select bootstrapped_at, setup_token_hash from instance_state where id = 1',
  );
  return rows[0]!;
}

/**
 * Opens `n` connections and releases them back to the pool.
 *
 * Without this the "concurrent" requests are not concurrent where it counts:
 * the first handler gets a warm idle client and completes its whole
 * transaction in a few sub-millisecond round trips, while the second is still
 * waiting on a fresh TCP connect + auth handshake — so it arrives to find the
 * instance already claimed (410) instead of racing for it (409). Warming the
 * pool first makes both handlers start their transactions in the same tick,
 * which is the situation under test.
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

async function rolesOf(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ role: string }>('select role from user_roles where user_id = $1 order by role', [
    userId,
  ]);
  return rows.map((r) => r.role);
}

let server: FastifyInstance;

describe('POST /api/v1/setup', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);
  });

  beforeEach(async () => {
    await deleteTestUsers();
    await resetInstanceState();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await pool.query(
      'update instance_state set bootstrapped_at = null, setup_token_hash = null, setup_token_issued_at = null where id = 1',
    );
    // `pool` IS the module pool (setPool above), so closePool ends it — same
    // pattern as me.test.ts, which is why there is no separate pool.end().
    await closePool();
  });

  describe('the successful claim', () => {
    it('creates the linked operator + student pair (design §5.2)', async () => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });

      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        admin: { id: string; handle: string; email: string; roles: string[] };
        student: { id: string; handle: string; email: string; roles: string[] };
      };

      expect(body.admin.handle).toBe(ADMIN_HANDLE);
      expect(body.student.handle).toBe(STUDENT_HANDLE);
      expect(body.admin.roles).toEqual(['admin']);
      expect(body.student.roles).toEqual(['student']);

      // Two rows, and the admin is exclusive — no student/teacher on it.
      expect(await rolesOf(body.admin.id)).toEqual(['admin']);
      expect(await rolesOf(body.student.id)).toEqual(['student']);

      const { rows } = await pool.query<{ id: string; operator_for: string | null; timezone: string | null }>(
        'select id, operator_for, timezone from users where email in ($1, $2) order by email',
        [ADMIN_EMAIL, STUDENT_EMAIL],
      );
      expect(rows).toHaveLength(2);

      const admin = rows.find((r) => r.id === body.admin.id)!;
      const student = rows.find((r) => r.id === body.student.id)!;
      expect(admin.operator_for).toBe(student.id);
      expect(student.operator_for).toBeNull();
      expect(student.timezone).toBe('Europe/Madrid');
    });

    it('marks the instance bootstrapped and destroys the setup token', async () => {
      await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });

      const state = await readInstanceState();
      expect(state.bootstrapped_at).toBeInstanceOf(Date);
      expect(state.setup_token_hash).toBeNull();
    });

    it('writes an audit_log entry for the claim', async () => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      const body = response.json() as { admin: { id: string } };

      const { rows } = await pool.query<{ action: string; actor_id: string; target: string; meta: unknown }>(
        'select action, actor_id, target, meta from audit_log where actor_id = $1',
        [body.admin.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('instance.bootstrapped');
    });

    it('never stores the submitted password in cleartext', async () => {
      await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      const { rows } = await pool.query('select * from users where email in ($1, $2)', [ADMIN_EMAIL, STUDENT_EMAIL]);
      expect(JSON.stringify(rows)).not.toContain('correct-horse-battery-staple');
    });

    it('stores the hash produced by the injected password hasher (the Argon2id seam)', async () => {
      await server.close();
      const hashPassword = vi.fn(async (plaintext: string) => `hashed:${plaintext.length}`);
      server = await buildServer({ hashPassword });

      const response = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      expect(response.statusCode).toBe(201);
      expect(hashPassword).toHaveBeenCalledTimes(2);

      const { rows } = await pool.query<{ password_hash: string | null }>(
        'select password_hash from users where email = $1',
        [ADMIN_EMAIL],
      );
      expect(rows[0]!.password_hash).toBe('hashed:28');
    });

    it('consults the policy module (CLAUDE.md rule 2)', async () => {
      await server.close();
      const can = vi.fn(() => true);
      server = await buildServer({ can });

      await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      expect(can).toHaveBeenCalledWith(expect.objectContaining({ roles: [] }), 'instance:bootstrap');
    });
  });

  describe('once claimed', () => {
    it('returns 410 Gone, permanently, recorded in instance_state', async () => {
      const first = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      expect(first.statusCode).toBe(201);

      const second = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody({
          admin: { email: `x-${RUN_ID}@example.test`, handle: `xops${RUN_ID}`, password: 'password-long-enough' },
          student: { email: `y-${RUN_ID}@example.test`, handle: `ystu${RUN_ID}`, password: 'password-long-enough' },
        }),
      });
      expect(second.statusCode).toBe(410);

      // Still exactly one admin, and no accounts from the second attempt.
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from user_roles ur
           join users u on u.id = ur.user_id
          where ur.role = 'admin' and u.email like $1`,
        [`%${RUN_ID}@example.test`],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('returns 410 rather than 401 even when the token is wrong', async () => {
      await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody({ setupToken: 'not-the-token' }),
      });
      expect(response.statusCode).toBe(410);
    });

    it('reports the instance as bootstrapped on GET /api/v1/setup', async () => {
      const before = await server.inject({ method: 'GET', url: '/api/v1/setup' });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ bootstrapped: false });

      await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });

      const after = await server.inject({ method: 'GET', url: '/api/v1/setup' });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ bootstrapped: true });
    });
  });

  describe('a wrong or tampered token', () => {
    it.each([
      ['a different token', 'wrong-token-entirely'],
      ['a truncated token', TOKEN.slice(0, -1)],
      ['the token with one character changed', `${TOKEN.slice(0, -1)}0`],
      ['the token hash itself', hashSetupToken(TOKEN)],
    ])('returns 401 for %s, and does not consume the claim', async (_label, setupToken) => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody({ setupToken }) });

      expect(response.statusCode).toBe(401);
      const state = await readInstanceState();
      expect(state.bootstrapped_at).toBeNull();
      expect(state.setup_token_hash).toBe(hashSetupToken(TOKEN));

      const { rows } = await pool.query('select id from users where email = $1', [ADMIN_EMAIL]);
      expect(rows).toHaveLength(0);

      // And the real token still works afterwards.
      const retry = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      expect(retry.statusCode).toBe(201);
    });

    it('returns 401 when no setup token has been issued at all', async () => {
      await pool.query('update instance_state set setup_token_hash = null where id = 1');
      const response = await server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() });
      expect(response.statusCode).toBe(401);
      expect((await readInstanceState()).bootstrapped_at).toBeNull();
    });
  });

  describe('validation', () => {
    it.each([
      ['a missing setup token', { setupToken: undefined }],
      ['a missing admin block', { admin: undefined }],
      ['a missing student block', { student: undefined }],
      ['an admin email that is not an email', { admin: { email: 'nope', handle: 'opsx', password: 'password-long-enough' } }],
      [
        'a handle that is not URL-safe',
        { admin: { email: `a-${RUN_ID}@example.test`, handle: 'not a handle', password: 'password-long-enough' } },
      ],
      [
        'a reserved handle',
        { admin: { email: `a-${RUN_ID}@example.test`, handle: 'admin', password: 'password-long-enough' } },
      ],
      ['a short password', { admin: { email: `a-${RUN_ID}@example.test`, handle: 'opsx', password: 'short' } }],
      ['an invalid timezone', { timezone: 'Mars/Olympus_Mons' }],
    ])('rejects %s with 400 and leaves the instance unclaimed', async (_label, overrides) => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody(overrides as Record<string, unknown>),
      });

      expect(response.statusCode).toBe(400);
      const state = await readInstanceState();
      expect(state.bootstrapped_at).toBeNull();
      expect(state.setup_token_hash).toBe(hashSetupToken(TOKEN));
    });

    it('rejects a pair that shares one email', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody({
          student: {
            email: ADMIN_EMAIL.toUpperCase(),
            handle: STUDENT_HANDLE,
            password: 'password-long-enough',
          },
        }),
      });
      expect(response.statusCode).toBe(400);
      expect((await readInstanceState()).bootstrapped_at).toBeNull();
    });

    it('rejects a pair that shares one handle', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody({
          student: { email: STUDENT_EMAIL, handle: ADMIN_HANDLE, password: 'password-long-enough' },
        }),
      });
      expect(response.statusCode).toBe(400);
      expect((await readInstanceState()).bootstrapped_at).toBeNull();
    });

    it('normalizes the email and handle it stores', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: validBody({
          admin: {
            email: `  ${ADMIN_EMAIL.toUpperCase()} `,
            handle: `  ${ADMIN_HANDLE.toUpperCase()}  `,
            password: 'password-long-enough',
          },
        }),
      });

      expect(response.statusCode).toBe(201);
      const { rows } = await pool.query<{ email: string; handle: string }>(
        'select email, handle from users where email = $1',
        [ADMIN_EMAIL],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.handle).toBe(ADMIN_HANDLE);
    });
  });

  describe('two concurrent claims', () => {
    it('yields exactly one admin; the loser gets 409', async () => {
      const other = await buildServer();
      try {
        await warmPool(2);

        // Genuinely in flight at the same time: both requests are dispatched
        // before either transaction commits. They are served by two servers
        // over two pool connections, so nothing serializes them but the
        // database.
        const [a, b] = await Promise.all([
          server.inject({ method: 'POST', url: '/api/v1/setup', payload: validBody() }),
          other.inject({
            method: 'POST',
            url: '/api/v1/setup',
            payload: validBody({
              admin: {
                email: `rival-ops-${RUN_ID}@example.test`,
                handle: `rivalops${RUN_ID}`,
                password: 'password-long-enough',
              },
              student: {
                email: `rival-stu-${RUN_ID}@example.test`,
                handle: `rivalstu${RUN_ID}`,
                password: 'password-long-enough',
              },
            }),
          }),
        ]);

        const codes = [a.statusCode, b.statusCode].sort();
        expect(codes).toEqual([201, 409]);

        const { rows } = await pool.query<{ n: string }>(
          `select count(*)::text as n from user_roles ur
             join users u on u.id = ur.user_id
            where ur.role = 'admin' and u.email like $1`,
          [`%${RUN_ID}@example.test`],
        );
        expect(rows[0]!.n).toBe('1');

        // The loser left nothing behind at all.
        const { rows: pairRows } = await pool.query<{ n: string }>(
          'select count(*)::text as n from users where email like $1',
          [`%${RUN_ID}@example.test`],
        );
        expect(pairRows[0]!.n).toBe('2');
      } finally {
        await other.close();
      }
    });

    it('yields exactly one admin under eight simultaneous claims', async () => {
      const servers = await Promise.all(Array.from({ length: 8 }, () => buildServer()));
      try {
        await warmPool(8);

        const responses = await Promise.all(
          servers.map((s, i) =>
            s.inject({
              method: 'POST',
              url: '/api/v1/setup',
              payload: validBody({
                admin: {
                  email: `swarm-ops-${i}-${RUN_ID}@example.test`,
                  handle: `swarmops${i}${RUN_ID}`,
                  password: 'password-long-enough',
                },
                student: {
                  email: `swarm-stu-${i}-${RUN_ID}@example.test`,
                  handle: `swarmstu${i}${RUN_ID}`,
                  password: 'password-long-enough',
                },
              }),
            }),
          ),
        );

        const created = responses.filter((r) => r.statusCode === 201);
        expect(created).toHaveLength(1);
        // Everyone else lost the race or found it already closed.
        for (const r of responses.filter((r) => r.statusCode !== 201)) {
          expect([409, 410]).toContain(r.statusCode);
        }

        const { rows } = await pool.query<{ n: string }>(
          `select count(*)::text as n from user_roles ur
             join users u on u.id = ur.user_id
            where ur.role = 'admin' and u.email like $1`,
          [`%${RUN_ID}@example.test`],
        );
        expect(rows[0]!.n).toBe('1');
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });
  });
});
