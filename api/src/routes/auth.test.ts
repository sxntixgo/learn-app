import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/cookies.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run auth.test.ts');
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
      if ((err as { code?: string }).code !== '42P07') throw err;
    }
  }
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const PASSWORD = 'correct-horse-battery-staple';

const STUDENT_EMAIL = `student-${RUN_ID}@example.test`;
const TEACHER_EMAIL = `teacher-${RUN_ID}@example.test`;
/** The inherited constraint made flesh: an account with password_hash = NULL. */
const NO_CREDENTIAL_EMAIL = `nocred-${RUN_ID}@example.test`;
const UNKNOWN_EMAIL = `ghost-${RUN_ID}@example.test`;

let studentId: string;
let teacherId: string;
let noCredentialId: string;
let server: FastifyInstance;

/** Reads a Set-Cookie back off an inject() response. */
function cookieOf(response: { cookies: unknown[] }, name: string): Record<string, unknown> | undefined {
  return (response.cookies as Array<Record<string, unknown>>).find((c) => c.name === name);
}

function cookieValue(response: { cookies: unknown[] }, name: string): string {
  return String(cookieOf(response, name)?.value ?? '');
}

async function login(
  target: FastifyInstance,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return target.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body });
}

describe('auth routes (design §13)', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const hash = await hashPassword(PASSWORD);
    const inserted = await pool.query<{ id: string; email: string }>(
      `insert into users (email, handle, display_name, password_hash) values
         ($1, $2, 'Auth Student', $3),
         ($4, $5, 'Auth Teacher', $3),
         ($6, $7, 'No Credential', null)
       returning id, email`,
      [
        STUDENT_EMAIL,
        `authstu${RUN_ID}`,
        hash,
        TEACHER_EMAIL,
        `authtch${RUN_ID}`,
        NO_CREDENTIAL_EMAIL,
        `authnil${RUN_ID}`,
      ],
    );
    const byEmail = new Map(inserted.rows.map((r) => [r.email, r.id]));
    studentId = byEmail.get(STUDENT_EMAIL)!;
    teacherId = byEmail.get(TEACHER_EMAIL)!;
    noCredentialId = byEmail.get(NO_CREDENTIAL_EMAIL)!;

    await pool.query('insert into user_roles (user_id, role) values ($1, $2), ($3, $4)', [
      studentId,
      'student',
      teacherId,
      'teacher',
    ]);
  });

  afterAll(async () => {
    // refresh_tokens and user_roles cascade from users. audit_log rows are
    // append-only by trigger (0005) and deliberately outlive the account they
    // describe, so they are left where they are.
    await pool.query('delete from users where id in ($1, $2, $3)', [studentId, teacherId, noCredentialId]);
    await closePool();
  });

  beforeEach(async () => {
    server = await buildServer();
    await pool.query('delete from refresh_tokens where user_id in ($1, $2, $3)', [
      studentId,
      teacherId,
      noCredentialId,
    ]);
    await pool.query('insert into user_roles (user_id, role) values ($1, $2) on conflict do nothing', [
      teacherId,
      'teacher',
    ]);
  });

  describe('POST /api/v1/auth/login', () => {
    it('signs a real account in and sets both session cookies', async () => {
      const response = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: { id: studentId, email: STUDENT_EMAIL, roles: ['student'] },
      });

      const access = cookieOf(response, ACCESS_COOKIE)!;
      const refresh = cookieOf(response, REFRESH_COOKIE)!;

      // Design §13: httpOnly + Secure + SameSite.
      for (const cookie of [access, refresh]) {
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.secure).toBe(true);
        expect(cookie.sameSite).toBe('Lax');
      }
      expect(access.path).toBe('/');
      // The refresh token is scoped to the routes that can use it, so it is
      // not attached to every ordinary request.
      expect(refresh.path).toBe('/api/v1/auth');

      // Neither cookie is the password, and the refresh token is stored hashed.
      expect(String(access.value)).not.toContain(PASSWORD);
      const { rows } = await pool.query('select token_hash from refresh_tokens where user_id = $1', [studentId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toBe(String(refresh.value));
    });

    it('is case-insensitive on the email and ignores surrounding whitespace', async () => {
      const response = await login(server, { email: `  ${STUDENT_EMAIL.toUpperCase()} `, password: PASSWORD });
      expect(response.statusCode).toBe(200);
    });

    it('rejects the wrong password with no session', async () => {
      const response = await login(server, { email: STUDENT_EMAIL, password: 'not-the-password' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ message: 'Invalid email or password.' });
      expect(cookieOf(response, ACCESS_COOKIE)).toBeUndefined();
    });

    it('answers an unknown email exactly as it answers a wrong password (no account oracle)', async () => {
      const unknown = await login(server, { email: UNKNOWN_EMAIL, password: PASSWORD });
      const wrong = await login(server, { email: STUDENT_EMAIL, password: 'not-the-password' });

      expect(unknown.statusCode).toBe(wrong.statusCode);
      expect(unknown.json()).toEqual(wrong.json());
      expect(unknown.cookies).toEqual([]);
    });

    // =====================================================================
    // THE INHERITED CONSTRAINT (db/migrations/0005_identity.sql):
    // password_hash IS NULL means "no credential, authentication is
    // impossible" — an unconditional failure, for every possible input.
    // =====================================================================
    describe('an account whose password_hash is NULL', () => {
      const inputs = [
        '',
        ' ',
        PASSWORD,
        'null',
        'NULL',
        'undefined',
        '{}',
        "' or 1=1 --",
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ];

      for (const password of inputs) {
        it(`cannot log in with ${JSON.stringify(password)}`, async () => {
          const response = await login(server, { email: NO_CREDENTIAL_EMAIL, password });

          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({ message: 'Invalid email or password.' });
          expect(response.cookies).toEqual([]);

          const { rows } = await pool.query('select id from refresh_tokens where user_id = $1', [noCredentialId]);
          expect(rows).toHaveLength(0);
        });
      }

      it('is indistinguishable from an email that does not exist at all', async () => {
        const noCredential = await login(server, { email: NO_CREDENTIAL_EMAIL, password: PASSWORD });
        const unknown = await login(server, { email: UNKNOWN_EMAIL, password: PASSWORD });

        expect(noCredential.statusCode).toBe(unknown.statusCode);
        expect(noCredential.json()).toEqual(unknown.json());
      });
    });

    it('rejects a missing email or password with 400 before any lookup', async () => {
      expect((await login(server, { password: PASSWORD })).statusCode).toBe(400);
      expect((await login(server, { email: STUDENT_EMAIL })).statusCode).toBe(400);
      expect((await login(server, {})).statusCode).toBe(400);
    });

    it('refuses an over-long password rather than hashing it', async () => {
      const response = await login(server, { email: STUDENT_EMAIL, password: 'x'.repeat(5000) });
      expect(response.statusCode).toBe(400);
    });

    it('supersedes the previous session on the same device (design §13: one per device)', async () => {
      const first = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      const firstRefresh = cookieValue(first, REFRESH_COOKIE);

      const second = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      expect(second.statusCode).toBe(200);

      // The old device session is dead; the new one works.
      const replay = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: firstRefresh },
      });
      expect(replay.statusCode).toBe(401);

      const fresh = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: cookieValue(second, REFRESH_COOKIE) },
      });
      expect(fresh.statusCode).toBe(200);
    });

    it('leaves a different device signed in', async () => {
      const iPad = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'laptop' });

      const stillGood = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: cookieValue(iPad, REFRESH_COOKIE) },
      });
      expect(stillGood.statusCode).toBe(200);
    });
  });

  describe('rate limiting (design §13: per IP and per account, with backoff)', () => {
    it('returns 429 once the configured attempt count is spent', async () => {
      const limited = await buildServer({
        loginRateLimiter: new LoginRateLimiter({
          maxAttempts: 3,
          windowMs: 60_000,
          baseLockoutMs: 30_000,
          maxLockoutMs: 60_000,
        }),
      });

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
        expect(response.statusCode).toBe(401);
      }

      const blocked = await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('30');

      // And the lockout is not a password check: the RIGHT password is
      // refused too, which is what makes it a brute-force defence rather
      // than a nuisance.
      const correct = await login(limited, { email: STUDENT_EMAIL, password: PASSWORD });
      expect(correct.statusCode).toBe(429);

      await limited.close();
    });

    it('does not count a successful login against the limit', async () => {
      const limited = await buildServer({
        loginRateLimiter: new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 }),
      });

      await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
      await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
      expect((await login(limited, { email: STUDENT_EMAIL, password: PASSWORD })).statusCode).toBe(200);

      // The counter was cleared, so three more failures are needed again.
      await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
      await login(limited, { email: STUDENT_EMAIL, password: 'wrong' });
      expect((await login(limited, { email: STUDENT_EMAIL, password: 'wrong' })).statusCode).toBe(401);

      await limited.close();
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('rotates the refresh token and mints a new access token', async () => {
      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      const firstRefresh = cookieValue(session, REFRESH_COOKIE);

      const refreshed = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: firstRefresh },
      });

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({ user: { id: studentId } });
      expect(cookieValue(refreshed, REFRESH_COOKIE)).not.toBe(firstRefresh);
      expect(cookieValue(refreshed, ACCESS_COOKIE)).not.toBe('');
    });

    it('refuses a request with no refresh cookie', async () => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
      expect(response.statusCode).toBe(401);
    });

    // =====================================================================
    // THE MOST IMPORTANT BEHAVIOUR IN THIS TASK (design §13):
    // "presenting a spent token revokes the whole family".
    // =====================================================================
    it('REPLAY: a spent refresh token revokes the entire family and kills the session', async () => {
      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      const spent = cookieValue(session, REFRESH_COOKIE);

      const rotated = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: spent },
      });
      expect(rotated.statusCode).toBe(200);
      const live = cookieValue(rotated, REFRESH_COOKIE);

      // The thief replays the token the honest client already exchanged.
      const replay = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: spent },
      });
      expect(replay.statusCode).toBe(401);
      // The failed refresh clears the cookies rather than leaving a dead one
      // that the client would retry forever.
      expect(cookieValue(replay, REFRESH_COOKIE)).toBe('');

      // The whole family is revoked in the database...
      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from refresh_tokens where user_id = $1',
        [studentId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

      // ...so the honest client's still-unspent token is dead too: the
      // session cannot continue, and only a fresh password login gets back in.
      const afterKill = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: live },
      });
      expect(afterKill.statusCode).toBe(401);

      // Recorded for the audit log (design §12).
      const audit = await pool.query(
        "select action from audit_log where actor_id = $1 and action = 'auth.refresh_reuse_detected'",
        [studentId],
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);

      // A fresh login still works — the account is not locked, the family is.
      expect((await login(server, { email: STUDENT_EMAIL, password: PASSWORD })).statusCode).toBe(200);
    });

    it('does not disclose WHY a refresh failed', async () => {
      const unknown = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: 'a-token-that-never-existed' },
      });

      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD });
      const token = cookieValue(session, REFRESH_COOKIE);
      await server.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { [REFRESH_COOKIE]: token } });
      const revoked = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: token },
      });

      expect(unknown.statusCode).toBe(revoked.statusCode);
      expect(unknown.json()).toEqual(revoked.json());
    });
  });

  describe('logout', () => {
    it('revokes this device and clears the cookies', async () => {
      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      const token = cookieValue(session, REFRESH_COOKIE);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { [REFRESH_COOKIE]: token },
      });

      expect(response.statusCode).toBe(204);
      expect(cookieValue(response, ACCESS_COOKIE)).toBe('');
      expect(cookieValue(response, REFRESH_COOKIE)).toBe('');

      const after = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: token },
      });
      expect(after.statusCode).toBe(401);
    });

    it('succeeds with no cookie at all, so signing out is never an error', async () => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(response.statusCode).toBe(204);
    });

    it('logout-all kills every device', async () => {
      const iPad = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'iPad' });
      const laptop = await login(server, { email: STUDENT_EMAIL, password: PASSWORD, deviceLabel: 'laptop' });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout-all',
        cookies: { [ACCESS_COOKIE]: cookieValue(laptop, ACCESS_COOKIE) },
      });
      expect(response.statusCode).toBe(204);

      for (const session of [iPad, laptop]) {
        const after = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          cookies: { [REFRESH_COOKIE]: cookieValue(session, REFRESH_COOKIE) },
        });
        expect(after.statusCode).toBe(401);
      }
    });

    it('logout-all is refused for an unauthenticated caller — by can(), not by an ad-hoc check', async () => {
      const response = await server.inject({ method: 'POST', url: '/api/v1/auth/logout-all' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ message: 'Forbidden' });
    });
  });

  describe('the access token is what authenticates ordinary requests', () => {
    it('an unauthenticated request to a protected route is refused by can()', async () => {
      const response = await server.inject({ method: 'GET', url: '/api/v1/me' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ message: 'Forbidden' });
    });

    it('the same request with the login cookie succeeds as that user', async () => {
      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/me',
        cookies: { [ACCESS_COOKIE]: cookieValue(session, ACCESS_COOKIE) },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: studentId });
    });

    it('a forged or corrupted access token is anonymous, not an error', async () => {
      const session = await login(server, { email: STUDENT_EMAIL, password: PASSWORD });
      const token = cookieValue(session, ACCESS_COOKIE);
      const tampered = `${token.slice(0, -3)}aaa`;

      for (const value of [tampered, 'not-a-jwt', '']) {
        const response = await server.inject({
          method: 'GET',
          url: '/api/v1/me',
          cookies: { [ACCESS_COOKIE]: value },
        });
        expect(response.statusCode).toBe(403);
      }
    });

    it('the public routes stay reachable while unauthenticated', async () => {
      expect((await server.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/api/v1/setup' })).statusCode).toBe(200);
    });
  });

  // ==========================================================================
  // Design §13: "role is in the token for cheap reads; privileged mutations
  // re-check the database, so a demotion takes effect immediately rather than
  // at next refresh."
  // ==========================================================================
  describe('a demotion takes effect immediately', () => {
    it('refuses the next privileged mutation on a token that still claims the role', async () => {
      const session = await login(server, { email: TEACHER_EMAIL, password: PASSWORD });
      const accessToken = cookieValue(session, ACCESS_COOKIE);
      expect(session.json()).toMatchObject({ user: { roles: ['teacher'] } });

      // The import is refused by the pipeline (file:// URLs never reach the
      // filesystem — see admin.ts), but it got PAST can(), which is what this
      // asserts: 200 + a progress stream rather than 403.
      const allowed = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { url: 'file:///etc/passwd' },
        cookies: { [ACCESS_COOKIE]: accessToken },
      });
      expect(allowed.statusCode).toBe(200);

      // Demote mid-session. The access token is untouched and still says
      // "teacher" — it has fourteen more minutes to live.
      await pool.query('delete from user_roles where user_id = $1', [teacherId]);

      const refused = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { url: 'file:///etc/passwd' },
        cookies: { [ACCESS_COOKIE]: accessToken },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ message: 'Forbidden' });
    });

    it('and the role is gone from the next refreshed access token too', async () => {
      const session = await login(server, { email: TEACHER_EMAIL, password: PASSWORD });
      await pool.query('delete from user_roles where user_id = $1', [teacherId]);

      const refreshed = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: cookieValue(session, REFRESH_COOKIE) },
      });

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({ user: { roles: [] } });
    });
  });
});
