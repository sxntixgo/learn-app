import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * The append-only carve-out that makes account deletion possible at all
 * (db/migrations/0017_activity_events_erasure.sql).
 *
 * Before 0017 an account that had ever completed a lesson could not be
 * deleted by any code path: `activity_events.user_id` cascades, and the
 * append-only trigger rejected the delete Postgres issues to satisfy its own
 * cascade. These tests pin both halves — that erasure now works, and that the
 * exception stayed as narrow as it was meant to be.
 */
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run erasure.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'erasure-test';
let alice: string;
let bob: string;

async function makeUserWithHistory(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`insert into users (id, display_name) values ($1, $2)`, [id, `${TAG} ${label}`]);
  await pool.query(`insert into activity_events (user_id, type) values ($1, 'lesson_completed')`, [id]);
  return id;
}

async function eventCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from activity_events where user_id = $1`, [
    userId,
  ]);
  return Number(rows[0]!.n);
}

async function userExists(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from users where id = $1`, [userId]);
  return rows.length > 0;
}

describe('erasing an account with activity history', () => {
  beforeAll(async () => {
    await pool.query(`delete from users where display_name like $1`, [`${TAG}%`]);
  });

  beforeEach(async () => {
    alice = await makeUserWithHistory('alice');
    bob = await makeUserWithHistory('bob');
  });

  afterAll(async () => {
    // Best-effort: anything a failing test left behind still has history, so
    // it needs the same carve-out to clean up.
    const { rows } = await pool.query<{ id: string }>(`select id from users where display_name like $1`, [`${TAG}%`]);
    for (const row of rows) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local app.erasing_user = '${row.id}'`);
        await client.query(`delete from users where id = $1`, [row.id]);
        await client.query('commit');
      } catch {
        await client.query('rollback');
      } finally {
        client.release();
      }
    }
    await pool.end();
  });

  it('is impossible without the carve-out — the bug this fixes', async () => {
    await expect(pool.query(`delete from users where id = $1`, [alice])).rejects.toThrow(/append-only/);
    expect(await userExists(alice)).toBe(true);
  });

  it('succeeds inside a transaction that names the user being erased', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local app.erasing_user = '${alice}'`);
      await client.query(`delete from users where id = $1`, [alice]);
      await client.query('commit');
    } finally {
      client.release();
    }

    expect(await userExists(alice)).toBe(false);
    expect(await eventCount(alice)).toBe(0);
  });

  /**
   * The one that keeps this a carve-out rather than an off switch. If the flag
   * merely meant "deletes are allowed now", a bug in the deletion path could
   * take out everyone's history along with its target.
   */
  it('cannot erase anyone else, even while the flag is set', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local app.erasing_user = '${alice}'`);
      await expect(client.query(`delete from activity_events where user_id = $1`, [bob])).rejects.toThrow(
        /append-only/,
      );
      await client.query('rollback');
    } finally {
      client.release();
    }

    expect(await eventCount(bob)).toBe(1);
  });

  it('does not leak past the transaction that set it', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local app.erasing_user = '${alice}'`);
      await client.query('commit');

      // Same pooled connection, new transaction: `set local` died with the
      // previous one, so the table is append-only again.
      await expect(client.query(`delete from activity_events where user_id = $1`, [alice])).rejects.toThrow(
        /append-only/,
      );
    } finally {
      client.release();
    }
  });

  it('still refuses UPDATE unconditionally — history is not rewritable', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local app.erasing_user = '${alice}'`);
      await expect(
        client.query(`update activity_events set type = 'quiz_passed' where user_id = $1`, [alice]),
      ).rejects.toThrow(/append-only/);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('leaves ordinary appends working', async () => {
    await expect(
      pool.query(`insert into activity_events (user_id, type) values ($1, 'course_enrolled')`, [bob]),
    ).resolves.toBeDefined();
    expect(await eventCount(bob)).toBe(2);
  });
});
