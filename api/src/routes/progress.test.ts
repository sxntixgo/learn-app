import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { DEV_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';

// Phase 6 note: these servers are built with an explicit `actor`. Until now
// the route modules defaulted to DEV_ACTOR when none was injected; they now
// default to the actor resolved from the access-token cookie, which is the
// ANONYMOUS actor for an unauthenticated inject() — and `can()` refuses that,
// as api/src/routes/auth.test.ts asserts. Injecting the same DEV_ACTOR these
// tests always ran as keeps them testing what they are about (courses,
// progress) rather than re-testing authentication.

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run progress.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors courses.test.ts's own copy — see that file for the rationale
// (each DB-touching test file owns its migration bootstrap; no shared
// util exists in this codebase yet).
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

// ---------------------------------------------------------------------------
// Fixture: a course with one live module holding a live 'lesson'-kind
// lesson, a live 'exercise'-kind lesson (for the 409 direct-completion
// test), and an archived lesson (excluded from progress totals). The course
// slug is unique per test run (not a fixed constant like courses.test.ts
// uses) rather than deleted in afterAll — see the comment on afterAll for
// why: once a lesson accrues activity_events history, the append-only
// trigger and the deliberately-non-cascading course_id/lesson_id FKs mean
// this fixture cannot be torn down, so each run gets a fresh one instead.
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COURSE_SLUG = `progress-route-test-course-${RUN_ID}`;
const LESSON_SLUG = 'progress-lesson-one';
const EXERCISE_SLUG = 'progress-exercise-one';
const ARCHIVED_SLUG = 'progress-archived-lesson';

let courseId: string;
let lessonId: string;
let exerciseId: string;

describe('progress routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title) values ($1, $2) returning id`,
      [COURSE_SLUG, 'Progress Route Test Course'],
    );
    courseId = course.rows[0]!.id;

    const module = await pool.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, 'mod-a', 'Module A', 0) returning id`,
      [courseId],
    );
    const moduleId = module.rows[0]!.id;

    const lesson = await pool.query<{ id: string }>(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, 'lesson-one', $3, 'Lesson One', 'lesson', 0, 'lesson-one.md', 'hash-1', '[]')
       returning id`,
      [courseId, moduleId, LESSON_SLUG],
    );
    lessonId = lesson.rows[0]!.id;

    const exercise = await pool.query<{ id: string }>(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, 'exercise-one', $3, 'Exercise One', 'exercise', 1, 'exercise-one.md', 'hash-2', '[]')
       returning id`,
      [courseId, moduleId, EXERCISE_SLUG],
    );
    exerciseId = exercise.rows[0]!.id;

    await pool.query(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks, archived_at)
       values ($1, $2, 'archived-one', $3, 'Archived Lesson', 'lesson', 2, 'archived-one.md', 'hash-3', '[]', now())`,
      [courseId, moduleId, ARCHIVED_SLUG],
    );
  });

  afterAll(async () => {
    // Deliberately does NOT delete the course/module/lesson rows: any
    // activity_events created against `lessonId` during this suite are
    // permanent (append-only, design §10), and activity_events.lesson_id /
    // .course_id are NOT ON DELETE CASCADE — cascading a delete into an
    // append-only table would require Postgres to issue an UPDATE/DELETE
    // against it, which the trigger rejects unconditionally. The unique
    // per-run course slug is what keeps repeated runs from colliding
    // instead.
    await closePool();
  });

  describe('POST /api/v1/courses/:courseSlug/lessons/:lessonSlug/progress', () => {
    it('marks a lesson complete: 200, one lesson_progress row, one lesson_completed event', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const before = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'lesson_completed'`,
        [lessonId],
      );

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: { state: 'complete' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { state: string; completedAt: string | null };
      expect(body.state).toBe('complete');
      expect(body.completedAt).not.toBeNull();

      const progressRows = await pool.query(
        `select count(*)::int as c from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, lessonId],
      );
      expect(progressRows.rows[0].c).toBe(1);

      const after = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'lesson_completed'`,
        [lessonId],
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(1);

      await fastify.close();
    });

    it('is idempotent: completing the same lesson a second time leaves one row and one event', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const before = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'lesson_completed'`,
        [lessonId],
      );

      // Second call — the fixture lesson was already marked complete by the
      // previous test in this file, exercising the true "call it twice"
      // path within a single run too.
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: { state: 'complete' },
      });

      expect(response.statusCode).toBe(200);

      const progressRows = await pool.query(
        `select count(*)::int as c from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, lessonId],
      );
      expect(progressRows.rows[0].c).toBe(1);

      const after = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'lesson_completed'`,
        [lessonId],
      );
      // No NEW event from this second call.
      expect(after.rows[0].c - before.rows[0].c).toBe(0);

      await fastify.close();
    });

    it('stores lastPosition and secondsSpent, resumable via the lesson endpoint', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${EXERCISE_SLUG}/progress`,
        payload: { lastPosition: 'block-3', secondsSpent: 42 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { lastPosition: string; secondsSpent: number; state: string };
      expect(body.lastPosition).toBe('block-3');
      expect(body.secondsSpent).toBe(42);
      expect(body.state).toBe('in_progress');

      const lessonResponse = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${EXERCISE_SLUG}`,
      });
      const lessonBody = JSON.parse(lessonResponse.payload) as {
        progress: { state: string; lastPosition: string } | null;
      };
      expect(lessonBody.progress).toMatchObject({ state: 'in_progress', lastPosition: 'block-3' });

      await fastify.close();
    });

    it('returns 409 attempting to mark an exercise-kind lesson complete directly', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${EXERCISE_SLUG}/progress`,
        payload: { state: 'complete' },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload) as { message: string };
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);

      const progressRows = await pool.query(
        `select state from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, exerciseId],
      );
      expect(progressRows.rows[0]?.state).not.toBe('complete');

      await fastify.close();
    });

    it('returns 404 for an unknown course slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/no-such-course-xyz/lessons/${LESSON_SLUG}/progress`,
        payload: { state: 'complete' },
      });

      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('returns 404 for an archived lesson', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${ARCHIVED_SLUG}/progress`,
        payload: { state: 'complete' },
      });

      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('calls can() with a "lesson:progress:write" action and the lesson as resource — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('lesson:progress:write');
      expect(actorArg).toBeTruthy();
      expect(resourceArg).toMatchObject({ slug: LESSON_SLUG });

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });

  describe('GET /api/v1/courses/:courseSlug/progress', () => {
    it('reports totals, percent, and per-lesson states, excluding archived lessons', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/progress`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        totalLessons: number;
        completedLessons: number;
        percent: number;
        lessons: Array<{ slug: string; kind: string; state: string }>;
      };

      // Archived lesson excluded: only the live lesson + exercise count.
      expect(body.totalLessons).toBe(2);
      expect(body.lessons.map((l) => l.slug)).toEqual([LESSON_SLUG, EXERCISE_SLUG]);
      expect(body.lessons.find((l) => l.slug === ARCHIVED_SLUG)).toBeUndefined();

      // The fixture lesson was marked complete earlier in this file.
      expect(body.completedLessons).toBe(1);
      expect(body.percent).toBe(50);

      const lessonEntry = body.lessons.find((l) => l.slug === LESSON_SLUG);
      expect(lessonEntry).toMatchObject({ kind: 'lesson', state: 'complete' });

      const exerciseEntry = body.lessons.find((l) => l.slug === EXERCISE_SLUG);
      expect(exerciseEntry).toMatchObject({ kind: 'exercise', state: 'in_progress' });

      await fastify.close();
    });

    it('returns 404 for an unknown course slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses/no-such-course-xyz/progress' });

      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('calls can() with a "course:progress:read" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/progress` });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('course:progress:read');
      expect(actorArg).toBeTruthy();

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/progress` });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });

  // ===========================================================================
  // The route half of the chokepoint.
  //
  // §5 grants a student "track OWN progress", and policy/can.ts enforces the
  // "own" by comparing `resource.userId` to the actor — denying when it is
  // absent. These assert that both progress routes name the subject, so the
  // ownership rule is reachable rather than theoretical.
  // ===========================================================================
  describe('the subject the progress routes hand can()', () => {
    it('names the actor as the subject of a progress write', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: {},
      });

      const [, , resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(resourceArg).toMatchObject({ userId: DEV_ACTOR.id });

      await fastify.close();
    });

    it('names the actor as the subject of a course progress read', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/progress` });

      const [, , resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(resourceArg).toMatchObject({ userId: DEV_ACTOR.id });

      await fastify.close();
    });

    it('under the REAL policy, an admin actor cannot write progress (§5.1: no progress)', async () => {
      const admin: Actor = { id: DEV_ACTOR.id, roles: ['admin'] };
      const fastify = await buildServer({ actor: admin });

      const write = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_SLUG}/progress`,
        payload: { state: 'complete' },
      });
      const read = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/progress` });

      expect([write.statusCode, read.statusCode]).toEqual([403, 403]);

      await fastify.close();
    });
  });
});
