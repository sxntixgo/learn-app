import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { DEV_ACTOR } from '../policy/can.ts';

// Same seam/rationale as progress.test.ts: these servers are built with an
// explicit `actor` so this suite tests quiz scoring, not authentication.

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run quiz.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors progress.test.ts's own copy — each DB-touching test file owns its
// migration bootstrap; no shared util exists in this codebase yet.
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
// Fixture: a course with a live 'quiz'-kind lesson (two questions, one
// track each, pass threshold 0.5) and a live 'lesson'-kind lesson (for the
// 409 wrong-endpoint test) — RUN_ID-suffixed so repeated runs don't collide
// with permanent activity_events history, same reasoning as
// progress.test.ts's afterAll comment.
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COURSE_SLUG = `quiz-route-test-course-${RUN_ID}`;
const QUIZ_SLUG = 'quiz-lesson-one';
const NON_QUIZ_SLUG = 'plain-lesson-one';

const QUIZ_BLOCKS = [
  { type: 'prose', html: '<p>A short check.</p>' },
  {
    type: 'quiz',
    pass: 0.5,
    questions: [
      {
        prompt: 'Which is a deep module?',
        track: 'cx',
        choices: [
          { text: 'A class with one method and a large interface' },
          { text: 'A class with a simple interface hiding real complexity', correct: true },
        ],
      },
      {
        prompt: 'What keeps twenty courses looking like one system?',
        choices: [
          { text: 'A fixed five-hue palette', correct: true },
          { text: 'Letting every author pick their own colors' },
        ],
      },
    ],
  },
];

let courseId: string;
let quizLessonId: string;

describe('quiz routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, visibility) values ($1, $2, 'open') returning id`,
      [COURSE_SLUG, 'Quiz Route Test Course'],
    );
    courseId = course.rows[0]!.id;

    const module = await pool.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, 'mod-a', 'Module A', 0) returning id`,
      [courseId],
    );
    const moduleId = module.rows[0]!.id;

    const quizLesson = await pool.query<{ id: string }>(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, 'quiz-one', $3, 'Quiz One', 'quiz', 0, 'quiz-one.md', 'hash-quiz-1', $4::jsonb)
       returning id`,
      [courseId, moduleId, QUIZ_SLUG, JSON.stringify(QUIZ_BLOCKS)],
    );
    quizLessonId = quizLesson.rows[0]!.id;

    await pool.query(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, 'plain-one', $3, 'Plain Lesson', 'lesson', 1, 'plain-one.md', 'hash-plain-1', '[]')`,
      [courseId, moduleId, NON_QUIZ_SLUG],
    );
  });

  afterAll(async () => {
    // Deliberately does NOT delete rows — see progress.test.ts's afterAll
    // for why (append-only activity_events, non-cascading FKs). The unique
    // per-run course slug is what keeps repeated runs from colliding.
    await closePool();
  });

  describe('GET /api/v1/courses/:courseSlug/lessons/:lessonSlug — quiz answers never reach the response', () => {
    it('strips `correct` from every choice (Task A)', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}`,
      });

      expect(response.statusCode).toBe(200);
      // The serialized response, byte for byte — not a re-parsed/re-walked
      // structural check, because the "explicitly assert the serialized API
      // response contains no correct key" bar means the actual wire bytes.
      expect(response.payload).not.toContain('correct');

      const body = JSON.parse(response.payload) as {
        blocks: Array<{ type: string; pass?: number; questions?: Array<{ choices: Array<Record<string, unknown>> }> }>;
      };
      const quizBlock = body.blocks.find((b) => b.type === 'quiz')!;
      expect(quizBlock.pass).toBe(0.5);
      expect(quizBlock.questions).toHaveLength(2);
      for (const question of quizBlock.questions!) {
        for (const choice of question.choices) {
          expect('correct' in choice).toBe(false);
          expect(typeof choice.text).toBe('string');
        }
      }

      await fastify.close();
    });
  });

  describe('POST /api/v1/courses/:courseSlug/lessons/:lessonSlug/quiz', () => {
    it('scores a passing attempt, marks the lesson complete, and emits one quiz_passed event', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const before = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'quiz_passed'`,
        [quizLessonId],
      );

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: {
          answers: [
            { questionIndex: 0, choiceIndex: 1 }, // correct
            { questionIndex: 1, choiceIndex: 0 }, // correct
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        score: number;
        passed: boolean;
        pass: number;
        results: Array<{ questionIndex: number; correct: boolean; correctChoiceIndex: number; track: string | null }>;
        trackScores: Record<string, { correct: number; total: number }>;
      };
      expect(body.score).toBe(1);
      expect(body.passed).toBe(true);
      expect(body.pass).toBe(0.5);
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toMatchObject({ questionIndex: 0, correct: true, correctChoiceIndex: 1, track: 'cx' });
      expect(body.results[1]).toMatchObject({ questionIndex: 1, correct: true, correctChoiceIndex: 0, track: null });
      expect(body.trackScores).toEqual({ cx: { correct: 1, total: 1 } });

      const attempts = await pool.query<{ c: string }>(
        `select count(*)::int as c from quiz_attempts where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, quizLessonId],
      );
      expect(attempts.rows[0].c).toBe(1);

      const progress = await pool.query<{ state: string }>(
        `select state from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, quizLessonId],
      );
      expect(progress.rows[0]?.state).toBe('complete');

      const after = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'quiz_passed'`,
        [quizLessonId],
      );
      expect(after.rows[0].c - before.rows[0].c).toBe(1);

      await fastify.close();
    });

    it('is idempotent: passing a second time adds an attempt row but not a second quiz_passed event or lesson_completed', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const beforeAttempts = await pool.query<{ c: string }>(
        `select count(*)::int as c from quiz_attempts where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, quizLessonId],
      );
      const beforeEvents = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'quiz_passed'`,
        [quizLessonId],
      );

      // Second passing attempt — a retake is allowed (design §9.1).
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: { answers: [{ questionIndex: 0, choiceIndex: 1 }, { questionIndex: 1, choiceIndex: 0 }] },
      });
      expect(response.statusCode).toBe(200);

      const afterAttempts = await pool.query<{ c: string }>(
        `select count(*)::int as c from quiz_attempts where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, quizLessonId],
      );
      // A new attempt row IS recorded — retaking is allowed.
      expect(afterAttempts.rows[0].c - beforeAttempts.rows[0].c).toBe(1);

      const afterEvents = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'quiz_passed'`,
        [quizLessonId],
      );
      // No NEW quiz_passed event — completion is recorded once.
      expect(afterEvents.rows[0].c - beforeEvents.rows[0].c).toBe(0);

      const progressRows = await pool.query<{ c: string }>(
        `select count(*)::int as c from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, quizLessonId],
      );
      expect(progressRows.rows[0].c).toBe(1);

      await fastify.close();
    });

    it('a failing attempt on a fresh lesson does not complete it or emit an event', async () => {
      const module = await pool.query<{ id: string }>(
        `select module_id as id from lessons where id = $1`,
        [quizLessonId],
      );
      const moduleId = module.rows[0]!.id;
      const failSlug = `quiz-lesson-fail-${RUN_ID}`;
      const failLesson = await pool.query<{ id: string }>(
        `insert into lessons
           (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
         values ($1, $2, $3, $3, 'Quiz Fail Fixture', 'quiz', 2, 'quiz-fail.md', 'hash-quiz-fail', $4::jsonb)
         returning id`,
        [courseId, moduleId, failSlug, JSON.stringify(QUIZ_BLOCKS)],
      );
      const failLessonId = failLesson.rows[0]!.id;

      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${failSlug}/quiz`,
        payload: { answers: [{ questionIndex: 0, choiceIndex: 0 }, { questionIndex: 1, choiceIndex: 1 }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { score: number; passed: boolean };
      expect(body.score).toBe(0);
      expect(body.passed).toBe(false);

      const attempts = await pool.query<{ c: string }>(
        `select count(*)::int as c from quiz_attempts where lesson_id = $1`,
        [failLessonId],
      );
      expect(attempts.rows[0].c).toBe(1);

      const progress = await pool.query<{ c: string }>(
        `select count(*)::int as c from lesson_progress where user_id = $1 and lesson_id = $2 and state = 'complete'`,
        [DEV_ACTOR.id, failLessonId],
      );
      expect(progress.rows[0].c).toBe(0);

      const events = await pool.query<{ c: string }>(
        `select count(*)::int as c from activity_events where lesson_id = $1 and type = 'quiz_passed'`,
        [failLessonId],
      );
      expect(events.rows[0].c).toBe(0);

      await fastify.close();
    });

    it('returns 409 for a non-quiz lesson kind', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${NON_QUIZ_SLUG}/quiz`,
        payload: { answers: [] },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload) as { message: string };
      expect(body.message.length).toBeGreaterThan(0);

      await fastify.close();
    });

    it('returns 404 for an unknown course slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/no-such-course-xyz/lessons/${QUIZ_SLUG}/quiz`,
        payload: { answers: [] },
      });
      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('returns 404 for an unknown lesson slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/no-such-lesson-xyz/quiz`,
        payload: { answers: [] },
      });
      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('returns 400 when answers is missing or malformed', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const missing = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const malformed = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: { answers: [{ questionIndex: 'zero', choiceIndex: 1 }] },
      });
      expect(malformed.statusCode).toBe(400);

      await fastify.close();
    });

    it('calls can() with a "lesson:quiz:submit" action and the lesson as resource — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: { answers: [] },
      });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('lesson:quiz:submit');
      expect(actorArg).toBeTruthy();
      expect(resourceArg).toMatchObject({ slug: QUIZ_SLUG });

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/${QUIZ_SLUG}/quiz`,
        payload: { answers: [] },
      });
      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });
});
