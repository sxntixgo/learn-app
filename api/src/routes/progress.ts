import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';

export interface ProgressRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as courses.ts.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface ProgressUpsertBody {
  state?: 'in_progress' | 'complete';
  lastPosition?: string | null;
  secondsSpent?: number;
}

interface LiveLessonRow {
  id: string;
  slug: string;
  kind: string;
}

interface ProgressWriteRow {
  state: string;
  lastPosition: string | null;
  secondsSpent: number;
  completedAt: string | null;
  updatedAt: string;
}

interface CourseProgressLessonRow {
  slug: string;
  kind: string;
  state: string | null;
}

const VALID_STATES = new Set(['in_progress', 'complete']);

/** Loads a course id by slug, or null if no such course exists. */
async function findCourseId(courseSlug: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>('select id from courses where slug = $1', [courseSlug]);
  return result.rows[0]?.id ?? null;
}

/**
 * Loads a live (non-archived, non-archived-module) lesson by slug within a
 * course — the same visibility rule as the lesson GET route in courses.ts,
 * so a lesson invisible there is equally unreachable for progress writes.
 */
async function findLiveLesson(courseId: string, lessonSlug: string): Promise<LiveLessonRow | null> {
  const result = await getPool().query<LiveLessonRow>(
    `select l.id, l.slug, l.kind
     from lessons l
     join modules m on m.id = l.module_id
     where l.course_id = $1 and l.slug = $2 and l.archived_at is null and m.archived_at is null`,
    [courseId, lessonSlug],
  );
  return result.rows[0] ?? null;
}

/** Registers the progress routes (design §9.1, §10) on `fastify`. */
export function registerProgressRoutes(fastify: FastifyInstance, deps: ProgressRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.post<{ Params: { courseSlug: string; lessonSlug: string }; Body: ProgressUpsertBody }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/progress',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug, lessonSlug } = request.params;
      const body = request.body ?? {};

      if (body.state !== undefined && !VALID_STATES.has(body.state)) {
        return reply.code(400).send({ message: `Invalid state: ${String(body.state)}` });
      }
      if (body.secondsSpent !== undefined && (!Number.isInteger(body.secondsSpent) || body.secondsSpent < 0)) {
        return reply.code(400).send({ message: 'secondsSpent must be a non-negative integer' });
      }

      const courseId = await findCourseId(courseSlug);
      if (!courseId) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      const lessonRow = await findLiveLesson(courseId, lessonSlug);
      if (!lessonRow) {
        return reply.code(404).send({ message: `Lesson not found: ${lessonSlug}` });
      }

      if (!can(actor, 'lesson:progress:write', lessonRow)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      // Design §9.1: one rule per kind, never two competing notions of
      // "done". Only `kind: 'lesson'` completes by direct student action;
      // exercises complete on submission and quizzes on passing, in later
      // phases.
      if (body.state === 'complete' && lessonRow.kind !== 'lesson') {
        return reply.code(409).send({
          message: `Only lessons of kind "lesson" can be marked complete directly; this lesson is kind "${lessonRow.kind}", which completes through its own mechanism, not this endpoint.`,
        });
      }

      const client = await getPool().connect();
      let row: ProgressWriteRow;
      let becameComplete: boolean;
      try {
        await client.query('BEGIN');

        // Lock (if present) and read the current state first — this is
        // what makes marking a lesson complete idempotent (design §6):
        // a second identical request sees `wasComplete = true` and skips
        // emitting a second activity_events row, while the upsert below
        // still leaves exactly one lesson_progress row either way.
        const existing = await client.query<{ state: string }>(
          'select state from lesson_progress where user_id = $1 and lesson_id = $2 for update',
          [actor.id, lessonRow.id],
        );
        const wasComplete = existing.rows[0]?.state === 'complete';
        const newState = body.state ?? existing.rows[0]?.state ?? 'in_progress';

        // seconds_spent intentionally REPLACES the stored value rather than
        // accumulating it — accumulation would make repeating an identical
        // request change the result, which is exactly the non-idempotent
        // behavior design §6 rules out. Two separate params are needed
        // because 0 (the insert default when omitted) is not a safe
        // `coalesce` fallback on the update branch — coalesce(0, existing)
        // would always overwrite existing with 0.
        const lastPositionParam = body.lastPosition ?? null;
        const secondsSpentInsertParam = body.secondsSpent ?? 0;
        const secondsSpentUpdateParam = body.secondsSpent ?? null;

        const result = await client.query<ProgressWriteRow>(
          `insert into lesson_progress
             (user_id, lesson_id, state, last_position, seconds_spent, completed_at, updated_at)
           values
             ($1, $2, $3, $4, $5, case when $3 = 'complete' then now() else null end, now())
           on conflict (user_id, lesson_id) do update set
             state = excluded.state,
             last_position = coalesce($4, lesson_progress.last_position),
             seconds_spent = coalesce($6, lesson_progress.seconds_spent),
             completed_at = case
               when excluded.state = 'complete' then coalesce(lesson_progress.completed_at, now())
               else null
             end,
             updated_at = now()
           returning
             state,
             last_position as "lastPosition",
             seconds_spent as "secondsSpent",
             completed_at as "completedAt",
             updated_at as "updatedAt"`,
          [actor.id, lessonRow.id, newState, lastPositionParam, secondsSpentInsertParam, secondsSpentUpdateParam],
        );
        row = result.rows[0]!;
        becameComplete = newState === 'complete' && !wasComplete;

        if (becameComplete) {
          await client.query(
            `insert into activity_events (user_id, type, course_id, lesson_id, meta)
             values ($1, 'lesson_completed', $2, $3, '{}'::jsonb)`,
            [actor.id, courseId, lessonRow.id],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return reply.code(200).send(row);
    },
  );

  fastify.get<{ Params: { courseSlug: string } }>('/api/v1/courses/:courseSlug/progress', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    const { courseSlug } = request.params;

    const courseId = await findCourseId(courseSlug);
    if (!courseId) {
      return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
    }

    if (!can(actor, 'course:progress:read', { slug: courseSlug })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Archived lessons excluded by the WHERE clause; a lesson whose module
    // is archived is excluded by the JOIN condition — same visibility rule
    // as the course/lesson GET routes.
    const result = await getPool().query<CourseProgressLessonRow>(
      `select l.slug, l.kind, lp.state
       from lessons l
       join modules m on m.id = l.module_id
       left join lesson_progress lp on lp.lesson_id = l.id and lp.user_id = $2
       where l.course_id = $1 and l.archived_at is null and m.archived_at is null
       order by m.position, l.position`,
      [courseId, actor.id],
    );

    const lessons = result.rows.map((row) => ({ slug: row.slug, kind: row.kind, state: row.state ?? 'not_started' }));
    const totalLessons = lessons.length;
    const completedLessons = lessons.filter((l) => l.state === 'complete').length;
    const percent = totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100);

    return reply.code(200).send({ totalLessons, completedLessons, percent, lessons });
  });
}
