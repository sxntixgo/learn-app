import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { deleteAccount } from './delete-account.ts';

/**
 * Account erasure (plan: "Account deletion and data export").
 *
 * The tests that matter here are not "the account is gone" — that part is one
 * DELETE. They are the two halves of "removes personal data WHILE PRESERVING
 * REFERENTIAL INTEGRITY":
 *
 *   1. everything personal to the account really goes, including the
 *      append-only activity history (migration 0017's carve-out); and
 *   2. nothing belonging to anyone ELSE goes with it. A teacher closing their
 *      account must not delete the grades and feedback on their students'
 *      submitted work (migration 0018), and must not delete the courses they
 *      owned.
 */
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run delete-account.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'del-acct';

interface World {
  studentId: string;
  teacherId: string;
  courseId: string;
  lessonId: string;
  submissionId: string;
  annotationId: string;
  rubricScoreId: string;
  badgeId: string;
}

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`insert into users (id, display_name, handle, email) values ($1, $2, $3, $4)`, [
    id,
    `${TAG} ${label}`,
    `${TAG}-${label}-${id.slice(0, 8)}`,
    `${TAG}-${label}-${id.slice(0, 8)}@example.test`,
  ]);
  return id;
}

/** A student with a full trail, and a teacher who graded their work. */
async function buildWorld(): Promise<World> {
  const studentId = await makeUser('student');
  const teacherId = await makeUser('teacher');
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student'), ($2, 'teacher')`, [
    studentId,
    teacherId,
  ]);

  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title, visibility, owner_id) values ($1, 'Del Course', 'open', $2) returning id`,
    [`${TAG}-course-${randomUUID().slice(0, 8)}`, teacherId],
  );
  const courseId = course.rows[0]!.id;

  const module = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position) values ($1, $2, 'M', 0) returning id`,
    [courseId, `${TAG}-m`],
  );
  const lesson = await pool.query<{ id: string }>(
    `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks, position)
     values ($1, $2, $3, $3, 'L', 'x', $4, '[]'::jsonb, 0) returning id`,
    [courseId, module.rows[0]!.id, `${TAG}-l-${randomUUID().slice(0, 8)}`, randomUUID()],
  );
  const lessonId = lesson.rows[0]!.id;

  await pool.query(`insert into enrollments (user_id, course_id) values ($1, $2)`, [studentId, courseId]);
  await pool.query(`insert into lesson_progress (user_id, lesson_id, state) values ($1, $2, 'complete')`, [
    studentId,
    lessonId,
  ]);
  await pool.query(`insert into activity_events (user_id, type) values ($1, 'lesson_completed')`, [studentId]);

  const badge = await pool.query<{ id: string }>(
    `insert into badges (slug, title, source, criteria, created_by)
     values ($1, 'B', 'admin', '{}'::jsonb, $2) returning id`,
    [`${TAG}-badge-${randomUUID().slice(0, 8)}`, teacherId],
  );
  const badgeId = badge.rows[0]!.id;
  await pool.query(`insert into user_badges (user_id, badge_id) values ($1, $2)`, [studentId, badgeId]);

  const submission = await pool.query<{ id: string }>(
    `insert into exercise_submissions (user_id, lesson_id, status, snapshot, snapshot_hash, submitted_at)
     values ($1, $2, 'submitted', '[]'::jsonb, 'h', now()) returning id`,
    [studentId, lessonId],
  );
  const submissionId = submission.rows[0]!.id;

  // The teacher's output, attached to the student's work.
  const annotation = await pool.query<{ id: string }>(
    `insert into annotations (submission_id, snapshot_hash, author_id, block_index, start_line, end_line, body)
     values ($1, 'h', $2, 0, 1, 1, 'good work') returning id`,
    [submissionId, teacherId],
  );
  const rubric = await pool.query<{ id: string }>(
    `insert into rubric_scores (submission_id, criterion, points, max, scored_by)
     values ($1, 'clarity', 4, 5, $2) returning id`,
    [submissionId, teacherId],
  );

  return {
    studentId,
    teacherId,
    courseId,
    lessonId,
    submissionId,
    annotationId: annotation.rows[0]!.id,
    rubricScoreId: rubric.rows[0]!.id,
    badgeId,
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}

async function scrub(): Promise<void> {
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
  await pool.query(`delete from courses where slug like $1`, [`${TAG}-%`]);
  await pool.query(`delete from badges where slug like $1`, [`${TAG}-%`]);
}

let world: World;

describe('deleting an account', () => {
  beforeAll(scrub);
  beforeEach(async () => {
    world = await buildWorld();
  });
  afterAll(async () => {
    await scrub();
    await pool.end();
  });

  it('removes the account itself', async () => {
    await deleteAccount(pool, world.studentId);
    expect(await count(`select count(*) as n from users where id = $1`, [world.studentId])).toBe(0);
  });

  it('removes everything personal to it, including append-only activity history', async () => {
    await deleteAccount(pool, world.studentId);

    for (const [label, sql] of [
      ['activity_events', `select count(*) as n from activity_events where user_id = $1`],
      ['lesson_progress', `select count(*) as n from lesson_progress where user_id = $1`],
      ['enrollments', `select count(*) as n from enrollments where user_id = $1`],
      ['exercise_submissions', `select count(*) as n from exercise_submissions where user_id = $1`],
      ['user_badges', `select count(*) as n from user_badges where user_id = $1`],
      ['user_roles', `select count(*) as n from user_roles where user_id = $1`],
      ['refresh_tokens', `select count(*) as n from refresh_tokens where user_id = $1`],
    ] as const) {
      expect(await count(sql, [world.studentId]), `${label} should be empty`).toBe(0);
    }
  });

  /**
   * The half that makes this "preserving referential integrity" rather than
   * just "delete". Before migration 0018 both of these vanished, taking a
   * student's grade and feedback with a teacher who closed their account.
   */
  it('does NOT delete the grades and feedback the account left on other people’s work', async () => {
    await deleteAccount(pool, world.teacherId);

    expect(await count(`select count(*) as n from annotations where id = $1`, [world.annotationId])).toBe(1);
    expect(await count(`select count(*) as n from rubric_scores where id = $1`, [world.rubricScoreId])).toBe(1);

    // Survives de-attributed, exactly as audit_log.actor_id does.
    const annotation = await pool.query<{ author_id: string | null }>(
      `select author_id from annotations where id = $1`,
      [world.annotationId],
    );
    expect(annotation.rows[0]!.author_id).toBeNull();
    const score = await pool.query<{ scored_by: string | null }>(
      `select scored_by from rubric_scores where id = $1`,
      [world.rubricScoreId],
    );
    expect(score.rows[0]!.scored_by).toBeNull();
  });

  it('leaves the student’s submission intact when the teacher leaves', async () => {
    await deleteAccount(pool, world.teacherId);
    expect(await count(`select count(*) as n from exercise_submissions where id = $1`, [world.submissionId])).toBe(1);
    expect(await count(`select count(*) as n from users where id = $1`, [world.studentId])).toBe(1);
  });

  it('leaves courses standing, merely unowned', async () => {
    await deleteAccount(pool, world.teacherId);
    const course = await pool.query<{ owner_id: string | null }>(`select owner_id from courses where id = $1`, [
      world.courseId,
    ]);
    expect(course.rows).toHaveLength(1);
    expect(course.rows[0]!.owner_id).toBeNull();
  });

  it('takes the annotations with the submission when the STUDENT leaves', async () => {
    // Through the submission — which is the student's own data — rather than
    // through the author, which is someone else's identity.
    await deleteAccount(pool, world.studentId);
    expect(await count(`select count(*) as n from exercise_submissions where id = $1`, [world.submissionId])).toBe(0);
    expect(await count(`select count(*) as n from annotations where id = $1`, [world.annotationId])).toBe(0);
    expect(await count(`select count(*) as n from users where id = $1`, [world.teacherId])).toBe(1);
  });

  it('touches nobody else’s activity history', async () => {
    await pool.query(`insert into activity_events (user_id, type) values ($1, 'course_enrolled')`, [world.teacherId]);
    await deleteAccount(pool, world.studentId);
    expect(await count(`select count(*) as n from activity_events where user_id = $1`, [world.teacherId])).toBe(1);
  });

  it('is a no-op for an id that does not exist, rather than an error', async () => {
    await expect(deleteAccount(pool, randomUUID())).resolves.toBe(false);
  });

  it('reports whether it actually deleted anything', async () => {
    await expect(deleteAccount(pool, world.studentId)).resolves.toBe(true);
  });
});
