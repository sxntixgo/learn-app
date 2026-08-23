import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';
import { hashPassword } from '../auth/password.ts';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/cookies.ts';

/**
 * Changing your own password — the ONLY credential-change path in this
 * system. §2 excludes password-reset mail and SMTP, so there is no "forgot
 * password" and no admin override: an account that cannot use this route can
 * never change its password at all.
 *
 * That makes two properties load-bearing beyond "it works":
 *
 *   - the current password is required even WITH a valid session, or an
 *     unlocked laptop can lock its owner out of their own instance
 *   - every other session dies, or changing a password because someone else
 *     may know it accomplishes nothing
 */
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run password.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'pw-route';
const CURRENT = 'current-password-abc';
const NEXT = 'a-brand-new-password';

let userId: string;
let email: string;

async function makeUser(password: string | null = CURRENT): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const handle = `${TAG}-${id.slice(0, 8)}`;
  const address = `${handle}@example.test`;
  await pool.query(
    `insert into users (id, display_name, handle, email, password_hash) values ($1, $2, $3, $4, $5)`,
    [id, `${TAG} user`, handle, address, password === null ? null : await hashPassword(password)],
  );
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [id]);
  return { id, email: address };
}

async function scrub(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(`select id from users where display_name like $1`, [`${TAG}%`]);
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.erasing_user', $1, true)`, [row.id]);
      await client.query(`delete from users where id = $1`, [row.id]);
      await client.query('commit');
    } catch {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}

function actorFor(id: string, roles: string[] = ['student']): Actor {
  return { id, roles } as Actor;
}

/** Each call gets its own server, so each gets its own rate limiter. */
async function change(actor: Actor, payload: unknown) {
  const server = await buildServer({ actor });
  try {
    return await server.inject({ method: 'POST', url: '/api/v1/auth/password', payload: payload as object });
  } finally {
    await server.close();
  }
}

async function storedHash(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ password_hash: string | null }>(
    'select password_hash from users where id = $1',
    [id],
  );
  return rows[0]?.password_hash ?? null;
}

async function liveFamilies(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'select count(*)::text as n from refresh_tokens where user_id = $1 and revoked_at is null',
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

describe('POST /api/v1/auth/password', () => {
  beforeAll(async () => {
    setPool(pool);
    await scrub();
  });

  beforeEach(async () => {
    const made = await makeUser();
    userId = made.id;
    email = made.email;
  });

  afterAll(async () => {
    await scrub();
    await closePool();
  });

  // ---- happy path -----------------------------------------------------------

  it('changes the password and answers 204', async () => {
    const before = await storedHash(userId);
    const response = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: NEXT });

    expect(response.statusCode, response.body).toBe(204);
    expect(await storedHash(userId)).not.toBe(before);
  });

  it('makes the old password stop working and the new one start', async () => {
    // The behaviour, asserted through the door a person actually uses, rather
    // than by inspecting a hash.
    await change(actorFor(userId), { currentPassword: CURRENT, newPassword: NEXT });

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    try {
      const withOld = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: CURRENT },
      });
      const withNew = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: NEXT },
      });
      expect(withOld.statusCode).toBe(401);
      expect(withNew.statusCode, withNew.body).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('re-issues both session cookies, so the person who just did it stays signed in', async () => {
    const response = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: NEXT });
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);

    const access = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
    const refresh = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    expect(access, JSON.stringify(cookies)).toBeDefined();
    expect(refresh, JSON.stringify(cookies)).toBeDefined();
    // Live, not cleared — a max-age of 0 here would sign them out instead.
    expect(access).not.toMatch(/max-age=0(;|$)/i);
    expect(refresh).not.toMatch(/max-age=0(;|$)/i);
  });

  it('revokes every other session, leaving exactly the new one', async () => {
    // The point of changing a password you think somebody else knows.
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    for (const device of ['laptop', 'phone', 'tablet']) {
      await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: CURRENT, deviceLabel: device },
      });
    }
    await server.close();
    expect(await liveFamilies(userId), 'three logins should leave three families').toBe(3);

    await change(actorFor(userId), { currentPassword: CURRENT, newPassword: NEXT });

    expect(await liveFamilies(userId)).toBe(1);
  });

  // ---- boundaries -----------------------------------------------------------

  it('accepts a new password of exactly the minimum length', async () => {
    const twelve = 'a'.repeat(12);
    const response = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: twelve });
    expect(response.statusCode, response.body).toBe(204);
  });

  it('refuses one character below the minimum', async () => {
    const response = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: 'a'.repeat(11) });
    expect(response.statusCode).toBe(400);
    expect(await storedHash(userId)).not.toBeNull();
  });

  it('accepts the maximum length and refuses one character above it', async () => {
    // The upper bound is not pedantry: Argon2id on an unbounded input is a
    // free CPU sink for anyone holding a session.
    const ok = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: 'b'.repeat(200) });
    expect(ok.statusCode, ok.body).toBe(204);

    const fresh = await makeUser();
    const tooLong = await change(actorFor(fresh.id), { currentPassword: CURRENT, newPassword: 'b'.repeat(201) });
    expect(tooLong.statusCode).toBe(400);
  });

  // ---- edges ----------------------------------------------------------------

  it('refuses a new password identical to the current one', async () => {
    // Rotating to the same secret is not a rotation, and it would revoke
    // every other session for nothing.
    const response = await change(actorFor(userId), { currentPassword: CURRENT, newPassword: CURRENT });
    expect(response.statusCode).toBe(400);
    expect(await liveFamilies(userId)).toBe(0);
  });

  it('refuses a missing body, missing fields, and non-string values', async () => {
    for (const payload of [
      {},
      { currentPassword: CURRENT },
      { newPassword: NEXT },
      { currentPassword: 1234, newPassword: NEXT },
      { currentPassword: CURRENT, newPassword: 12345678901234 },
      { currentPassword: CURRENT, newPassword: null },
    ]) {
      const response = await change(actorFor(userId), payload);
      expect([400, 401], JSON.stringify(payload)).toContain(response.statusCode);
      expect(response.statusCode, JSON.stringify(payload)).not.toBe(204);
    }
  });

  it('refuses an account with no password at all, rather than crashing', async () => {
    // password_hash is NULL for an account created by an invite that has not
    // set one yet. There is nothing to verify against, so there is nothing to
    // change — and `verifyPassword` treats NULL as not-a-credential.
    const noCredential = await makeUser(null);
    const response = await change(actorFor(noCredential.id), { currentPassword: '', newPassword: NEXT });

    expect(response.statusCode).toBe(401);
    expect(await storedHash(noCredential.id)).toBeNull();
  });

  // ---- error paths ----------------------------------------------------------

  it('refuses a wrong current password and changes nothing', async () => {
    const before = await storedHash(userId);
    const response = await change(actorFor(userId), { currentPassword: 'not-the-password', newPassword: NEXT });

    expect(response.statusCode).toBe(401);
    expect(await storedHash(userId)).toBe(before);
  });

  it('leaves other sessions alive when the current password is wrong', async () => {
    // No partial application: a failed attempt must not have the side effect
    // that a successful one does.
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: CURRENT, deviceLabel: 'laptop' },
    });
    await server.close();

    await change(actorFor(userId), { currentPassword: 'wrong', newPassword: NEXT });

    expect(await liveFamilies(userId)).toBe(1);
  });

  it('refuses an anonymous caller', async () => {
    const before = await storedHash(userId);
    const response = await change(ANONYMOUS_ACTOR, { currentPassword: CURRENT, newPassword: NEXT });

    expect(response.statusCode).toBe(403);
    expect(await storedHash(userId)).toBe(before);
  });

  it('locks out repeated wrong attempts', async () => {
    // Otherwise this is an unlimited password-guessing oracle for anyone who
    // gets hold of a session — strictly easier than the login route, which
    // has been rate-limited since Phase 6.
    const server = await buildServer({ actor: actorFor(userId) });
    try {
      let sawLockout = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { currentPassword: `wrong-${attempt}`, newPassword: NEXT },
        });
        if (response.statusCode === 429) {
          expect(response.headers['retry-after']).toBeDefined();
          sawLockout = true;
          break;
        }
        expect(response.statusCode).toBe(401);
      }
      expect(sawLockout, 'twelve wrong attempts never tripped the limiter').toBe(true);
    } finally {
      await server.close();
    }
  });

  it('does not hold a typo against you once the change succeeds', async () => {
    // A limiter that counts a corrected mistake forever would lock people out
    // of the only credential-change path there is.
    const server = await buildServer({ actor: actorFor(userId) });
    try {
      await server.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { currentPassword: 'typo', newPassword: NEXT },
      });
      const good = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { currentPassword: CURRENT, newPassword: NEXT },
      });
      expect(good.statusCode, good.body).toBe(204);

      // And the counter is clear afterwards: a later mistake starts from zero.
      const after = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { currentPassword: 'typo-again', newPassword: 'another-new-password' },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  // ---- ordering -------------------------------------------------------------

  it('validates the new password BEFORE verifying the current one', async () => {
    // A property, not a value. The fixture is wrong in two ways at once: if
    // shape is checked first the answer is 400, and if the Argon2id verify
    // runs first it is 401. Checking shape first is what stops this route
    // being a password oracle that also burns a hash per guess.
    const response = await change(actorFor(userId), { currentPassword: 'definitely-wrong', newPassword: 'short' });
    expect(response.statusCode).toBe(400);
  });
});
