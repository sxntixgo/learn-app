import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exportAccount } from './export.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run export.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'exp-acct';
let mineId: string;
let theirsId: string;
let courseSlug: string;
let lessonSlug: string;

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into users (id, display_name, handle, email, bio, timezone, password_hash)
     values ($1, $2, $3, $4, 'about me', 'Europe/Madrid', '$argon2id$never-leaves')`,
    [id, `${TAG} ${label}`, `${TAG}-${label}-${id.slice(0, 8)}`, `${TAG}-${label}-${id.slice(0, 8)}@example.test`],
  );
  return id;
}

describe('exporting an account', () => {
  beforeAll(async () => {
    mineId = await makeUser('mine');
    theirsId = await makeUser('theirs');
    await pool.query(`insert into user_roles (user_id, role) values ($1, 'student'), ($2, 'student')`, [
      mineId,
      theirsId,
    ]);

    courseSlug = `${TAG}-course-${randomUUID().slice(0, 8)}`;
    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, visibility) values ($1, 'Export Course', 'open') returning id`,
      [courseSlug],
    );
    const module = await pool.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, $2, 'M', 0) returning id`,
      [course.rows[0]!.id, `${TAG}-m`],
    );
    lessonSlug = `${TAG}-lesson-${randomUUID().slice(0, 8)}`;
    const lesson = await pool.query<{ id: string }>(
      `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks, position)
       values ($1, $2, $3, $3, 'Export Lesson', 'x', $4, '[]'::jsonb, 0) returning id`,
      [course.rows[0]!.id, module.rows[0]!.id, lessonSlug, randomUUID()],
    );

    // Data for both accounts, so "only mine" is a real assertion.
    for (const id of [mineId, theirsId]) {
      await pool.query(`insert into enrollments (user_id, course_id) values ($1, $2)`, [id, course.rows[0]!.id]);
      await pool.query(`insert into lesson_progress (user_id, lesson_id, state) values ($1, $2, 'complete')`, [
        id,
        lesson.rows[0]!.id,
      ]);
      await pool.query(`insert into activity_events (user_id, type) values ($1, 'lesson_completed')`, [id]);
    }
  });

  afterAll(async () => {
    for (const id of [mineId, theirsId]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.erasing_user', $1, true)`, [id]);
        await client.query(`delete from users where id = $1`, [id]);
        await client.query('commit');
      } catch {
        await client.query('rollback');
      } finally {
        client.release();
      }
    }
    await pool.query(`delete from courses where slug like $1`, [`${TAG}-%`]);
    await pool.end();
  });

  it('returns the account’s own profile, including the email', async () => {
    const result = await exportAccount(pool, mineId);
    expect(result).not.toBeNull();
    expect(result!.profile.id).toBe(mineId);
    expect(result!.profile.email).toContain('@example.test');
    expect(result!.profile.bio).toBe('about me');
    expect(result!.profile.timezone).toBe('Europe/Madrid');
    expect(result!.profile.roles).toContain('student');
  });

  /**
   * `users` also holds `password_hash`. A `select *` here would put it in a
   * file the account holder downloads and might well forward to someone.
   */
  it('never includes the password hash, anywhere in the document', async () => {
    const result = await exportAccount(pool, mineId);
    expect(JSON.stringify(result)).not.toContain('argon2id');
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('includes the account’s enrolments, progress and activity', async () => {
    const result = await exportAccount(pool, mineId);
    expect(result!.enrolments.map((e) => e.course_slug)).toContain(courseSlug);
    expect(result!.progress.map((p) => p.lesson_slug)).toContain(lessonSlug);
    expect(result!.activity).toHaveLength(1);
  });

  /** The whole point of scoping: one person's export is one person's data. */
  it('contains nothing belonging to any other account', async () => {
    const mine = await exportAccount(pool, mineId);
    const theirs = await exportAccount(pool, theirsId);

    expect(mine!.profile.id).not.toBe(theirs!.profile.id);
    expect(JSON.stringify(mine)).not.toContain(theirsId);
    expect(mine!.enrolments).toHaveLength(1);
    expect(mine!.activity).toHaveLength(1);
  });

  it('has every collection the contract promises, even when empty', async () => {
    const result = await exportAccount(pool, mineId);
    for (const key of ['enrolments', 'progress', 'quizAttempts', 'submissions', 'badges', 'degrees', 'activity'] as const) {
      expect(Array.isArray(result![key]), `${key} should be an array`).toBe(true);
    }
    expect(typeof result!.exportedAt).toBe('string');
  });

  it('is null for an account that does not exist, not an empty document', async () => {
    await expect(exportAccount(pool, randomUUID())).resolves.toBeNull();
  });
});
