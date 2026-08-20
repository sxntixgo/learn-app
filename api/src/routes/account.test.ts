import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/cookies.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run account.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'acct-route';
let userId: string;
let handle: string;

async function makeUser(): Promise<{ id: string; handle: string }> {
  const id = randomUUID();
  const h = `${TAG}-${id.slice(0, 8)}`;
  await pool.query(`insert into users (id, display_name, handle, email) values ($1, $2, $3, $4)`, [
    id,
    `${TAG} user`,
    h,
    `${h}@example.test`,
  ]);
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [id]);
  await pool.query(`insert into activity_events (user_id, type) values ($1, 'lesson_completed')`, [id]);
  return { id, handle: h };
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

describe('GET /api/v1/me/export and DELETE /api/v1/me/account', () => {
  beforeAll(async () => {
    setPool(pool);
    await scrub();
  });

  beforeEach(async () => {
    const made = await makeUser();
    userId = made.id;
    handle = made.handle;
  });

  afterAll(async () => {
    await scrub();
    await closePool();
  });

  it('exports the signed-in account as JSON, as an attachment', async () => {
    const server = await buildServer({ actor: actorFor(userId) });
    const response = await server.inject({ method: 'GET', url: '/api/v1/me/export' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    const body = response.json() as { profile: { id: string; email: string } };
    expect(body.profile.id).toBe(userId);
    expect(body.profile.email).toContain('@example.test');
    await server.close();
  });

  it('refuses to export for an anonymous caller', async () => {
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'GET', url: '/api/v1/me/export' });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('refuses to export for an admin — an admin holds no learner record', async () => {
    const server = await buildServer({ actor: actorFor(userId, ['admin']) });
    const response = await server.inject({ method: 'GET', url: '/api/v1/me/export' });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  /**
   * The confirmation is checked SERVER-side. A destructive, irreversible
   * action must not be reachable by a stray DELETE — the client cannot be the
   * only thing between a live session and permanent erasure.
   */
  it('refuses to delete without a matching confirmHandle', async () => {
    const server = await buildServer({ actor: actorFor(userId) });

    for (const payload of [{}, { confirmHandle: '' }, { confirmHandle: 'someone-else' }]) {
      const response = await server.inject({ method: 'DELETE', url: '/api/v1/me/account', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const still = await pool.query(`select 1 from users where id = $1`, [userId]);
    expect(still.rows).toHaveLength(1);
    await server.close();
  });

  it('deletes the account when the handle matches, and clears the session', async () => {
    const server = await buildServer({ actor: actorFor(userId) });
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/me/account',
      payload: { confirmHandle: handle },
    });

    expect(response.statusCode).toBe(204);

    const gone = await pool.query(`select 1 from users where id = $1`, [userId]);
    expect(gone.rows).toHaveLength(0);

    // The account had activity history — the case that was impossible before
    // migration 0017.
    const events = await pool.query(`select 1 from activity_events where user_id = $1`, [userId]);
    expect(events.rows).toHaveLength(0);

    // The REAL session cookies (auth/cookies.ts's ACCESS_COOKIE/
    // REFRESH_COOKIE — `learn_at`/`learn_rt`, not the made-up names a
    // hand-rolled `reply.clearCookie` call previously targeted), and
    // actually cleared (Max-Age=0), not merely mentioned somewhere in the
    // header — a stray Set-Cookie without Max-Age=0 would leave the
    // browser's copy live.
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const accessCookie = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
    const refreshCookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    expect(accessCookie, JSON.stringify(cookies)).toMatch(/max-age=0/i);
    expect(refreshCookie, JSON.stringify(cookies)).toMatch(/max-age=0/i);
    await server.close();
  });

  it('refuses to delete for an anonymous caller', async () => {
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/me/account',
      payload: { confirmHandle: handle },
    });
    expect(response.statusCode).toBe(403);

    const still = await pool.query(`select 1 from users where id = $1`, [userId]);
    expect(still.rows).toHaveLength(1);
    await server.close();
  });

  it('refuses to delete an admin account — that belongs in admin tooling', async () => {
    const server = await buildServer({ actor: actorFor(userId, ['admin']) });
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/me/account',
      payload: { confirmHandle: handle },
    });
    expect(response.statusCode).toBe(403);

    const still = await pool.query(`select 1 from users where id = $1`, [userId]);
    expect(still.rows).toHaveLength(1);
    await server.close();
  });
});
