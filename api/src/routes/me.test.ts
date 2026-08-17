import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import type { Actor } from '../policy/can.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run me.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors progress.test.ts / courses.test.ts's own copy — see those for the
// rationale (each DB-touching test file owns its migration bootstrap).
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
// Fixture: a dedicated actor (own users row, own uuid) instead of the shared
// DEV_ACTOR — the routes accept an injectable `actor` (same seam as
// progress.test.ts's canSpy), and courses.test.ts / progress.test.ts write
// activity_events under DEV_ACTOR in this same physical TEST_DATABASE_URL
// (vitest.config.ts: fileParallelism false, one shared DB). Heatmap/streak
// assertions need exact counts over an actor's full history, so this file
// gets its own actor no other test file ever touches.
//
// A second, timezone-less actor exists for the "default" timezoneSource
// path, since the first actor's timezone gets set by the PATCH tests.
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COURSE_SLUG = `me-route-test-course-${RUN_ID}`;
const LESSON_SLUG = 'me-lesson-one';

let actor: Actor;
let defaultTzActor: Actor;
let courseId: string;
let lessonId: string;

describe('me routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const user = await pool.query<{ id: string }>(
      `insert into users (display_name, timezone) values ($1, null) returning id`,
      [`Me Route Test User ${RUN_ID}`],
    );
    // STUDENT, not admin. These fixtures own lesson_progress and
    // activity_events rows, and design §5.1 is explicit that operator
    // accounts have "no enrollments, no progress, no badges" — so an admin
    // fixture with an activity history is a state the platform must not
    // have. It read as harmless only while `can()` returned true for
    // everything; the §5 matrix in policy/can.ts now says so out loud.
    actor = { id: user.rows[0]!.id, roles: ['student'] };

    const defaultUser = await pool.query<{ id: string }>(
      `insert into users (display_name, timezone) values ($1, null) returning id`,
      [`Me Route Test Default-TZ User ${RUN_ID}`],
    );
    defaultTzActor = { id: defaultUser.rows[0]!.id, roles: ['student'] };

    const course = await pool.query<{ id: string }>(`insert into courses (slug, title) values ($1, $2) returning id`, [
      COURSE_SLUG,
      'Me Route Test Course',
    ]);
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
  });

  afterAll(async () => {
    // Same reasoning as progress.test.ts's afterAll: activity_events rows
    // referencing lessonId/courseId are permanent (append-only trigger, no
    // cascading FK), so nothing here is deleted; unique per-run slugs and a
    // dedicated actor keep repeated runs from colliding.
    await closePool();
  });

  describe('GET /api/v1/me', () => {
    it('returns the actor with timezoneSource "default" when timezone is unset', async () => {
      const fastify = await buildServer({ actor: defaultTzActor });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        id: string;
        displayName: string | null;
        timezone: string;
        timezoneSource: string;
      };
      expect(body.id).toBe(defaultTzActor.id);
      expect(body.timezone).toBe('UTC');
      expect(body.timezoneSource).toBe('default');

      await fastify.close();
    });

    it('calls can() with a "me:read" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ actor, can: canSpy });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me' });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('me:read');
      expect(actorArg).toBeTruthy();

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ actor, can: () => false });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me' });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });

  describe('PATCH /api/v1/me', () => {
    it('sets a valid IANA timezone: 200, timezoneSource "set"', async () => {
      const fastify = await buildServer({ actor });
      const response = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'America/Denver' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { timezone: string; timezoneSource: string };
      expect(body.timezone).toBe('America/Denver');
      expect(body.timezoneSource).toBe('set');

      const row = await pool.query<{ timezone: string }>('select timezone from users where id = $1', [actor.id]);
      expect(row.rows[0]!.timezone).toBe('America/Denver');

      await fastify.close();
    });

    it('rejects a non-IANA timezone with 400 and does not write it', async () => {
      const fastify = await buildServer({ actor });
      const response = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'Not/A_Zone' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { message: string };
      expect(body.message.length).toBeGreaterThan(0);

      // Unchanged from the previous test's successful write.
      const row = await pool.query<{ timezone: string }>('select timezone from users where id = $1', [actor.id]);
      expect(row.rows[0]!.timezone).toBe('America/Denver');

      await fastify.close();
    });

    it('rejects a missing timezone field with 400', async () => {
      const fastify = await buildServer({ actor });
      const response = await fastify.inject({ method: 'PATCH', url: '/api/v1/me', payload: {} });

      expect(response.statusCode).toBe(400);
      await fastify.close();
    });

    it('rejects a bare UTC offset like "+05:00" with 400', async () => {
      const fastify = await buildServer({ actor });
      const response = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: '+05:00' },
      });

      expect(response.statusCode).toBe(400);
      await fastify.close();
    });

    it('calls can() with a "me:update" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ actor, can: canSpy });

      const response = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'UTC' },
      });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('me:update');
      expect(actorArg).toBeTruthy();

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ actor, can: () => false });
      const response = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'UTC' },
      });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });

  describe('GET /api/v1/me/activity', () => {
    it('lists events newest-first with joined course/lesson context', async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `insert into activity_events (user_id, type, course_id, lesson_id, occurred_at)
           values
             ($1, 'lesson_completed', $2, $3, now() - interval '2 hours'),
             ($1, 'course_enrolled', $2, null, now() - interval '1 hour')`,
          [actor.id, courseId, lessonId],
        );
      } finally {
        client.release();
      }

      const fastify = await buildServer({ actor });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/activity?limit=2' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as Array<{
        type: string;
        occurredAt: string;
        course: { slug: string; title: string } | null;
        lesson: { slug: string; title: string } | null;
      }>;

      expect(body).toHaveLength(2);
      // Newest first: course_enrolled (1 hour ago) before lesson_completed (2 hours ago).
      expect(body[0]!.type).toBe('course_enrolled');
      expect(body[0]!.course).toEqual({ slug: COURSE_SLUG, title: 'Me Route Test Course' });
      expect(body[0]!.lesson).toBeNull();

      expect(body[1]!.type).toBe('lesson_completed');
      expect(body[1]!.course).toEqual({ slug: COURSE_SLUG, title: 'Me Route Test Course' });
      expect(body[1]!.lesson).toEqual({ slug: LESSON_SLUG, title: 'Lesson One' });

      await fastify.close();
    });

    it('clamps an out-of-range limit rather than erroring', async () => {
      const fastify = await buildServer({ actor });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/activity?limit=99999' });

      expect(response.statusCode).toBe(200);
      await fastify.close();
    });

    it('calls can() with a "me:activity:read" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ actor, can: canSpy });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/activity' });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('me:activity:read');

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ actor, can: () => false });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/activity' });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });

  describe('GET /api/v1/me/heatmap', () => {
    it('reflects the actor timezone, pads zero days, and buckets a fresh event on the correct local date', async () => {
      // A fresh actor isolates this from the activity_events already
      // inserted for `actor` in the feed tests above.
      const user = await pool.query<{ id: string }>(
        `insert into users (display_name, timezone) values ($1, 'America/Denver') returning id`,
        [`Me Route Heatmap User ${RUN_ID}`],
      );
      const heatmapActor: Actor = { id: user.rows[0]!.id, roles: ['student'] };

      const client = await pool.connect();
      let occurredAt: Date;
      try {
        const inserted = await client.query<{ occurred_at: Date }>(
          `insert into activity_events (user_id, type, occurred_at)
           values ($1, 'lesson_completed', now())
           returning occurred_at`,
          [heatmapActor.id],
        );
        occurredAt = inserted.rows[0]!.occurred_at;
      } finally {
        client.release();
      }

      // Independently computed expected local date — this is the
      // integration-level half of the "bucket in the student's zone, not
      // UTC" proof; streaks.test.ts covers the pure-function half with a
      // synthetic America/Denver case that disagrees with UTC by a day.
      const expectedLocalDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(occurredAt);

      const fastify = await buildServer({ actor: heatmapActor });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/heatmap?weeks=2' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        timezone: string;
        timezoneSource: string;
        days: Array<{ date: string; count: number }>;
        maxCount: number;
        currentStreak: number;
        longestStreak: number;
      };

      expect(body.timezone).toBe('America/Denver');
      expect(body.timezoneSource).toBe('set');
      expect(body.days).toHaveLength(14);

      const dayByDate = new Map(body.days.map((d) => [d.date, d.count]));
      expect(dayByDate.get(expectedLocalDate)).toBe(1);
      // This actor has exactly one event, ever — every other day is 0.
      const totalCount = body.days.reduce((sum, d) => sum + d.count, 0);
      expect(totalCount).toBe(1);
      expect(body.maxCount).toBe(1);
      expect(body.currentStreak).toBe(1);
      expect(body.longestStreak).toBe(1);

      await fastify.close();
    });

    it('the timezone-bucketing proof: the same instant lands on a different local date after PATCHing to a far-opposite zone', async () => {
      const user = await pool.query<{ id: string }>(
        `insert into users (display_name, timezone) values ($1, null) returning id`,
        [`Me Route TZ-Proof User ${RUN_ID}`],
      );
      const proofActor: Actor = { id: user.rows[0]!.id, roles: ['student'] };

      // A fixed instant near "now" so it reliably falls inside a wide
      // weeks= window regardless of when the suite runs.
      const client = await pool.connect();
      try {
        await client.query(
          `insert into activity_events (user_id, type, occurred_at) values ($1, 'lesson_completed', now())`,
          [proofActor.id],
        );
      } finally {
        client.release();
      }

      const fastifyKiritimati = await buildServer({ actor: proofActor });
      await fastifyKiritimati.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'Pacific/Kiritimati' }, // UTC+14
      });
      const kiritimatiResponse = await fastifyKiritimati.inject({
        method: 'GET',
        url: '/api/v1/me/heatmap?weeks=1',
      });
      const kiritimatiBody = JSON.parse(kiritimatiResponse.payload) as { days: Array<{ date: string; count: number }> };
      await fastifyKiritimati.close();

      const fastifyNiue = await buildServer({ actor: proofActor });
      await fastifyNiue.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { timezone: 'Pacific/Niue' }, // UTC-11
      });
      const niueResponse = await fastifyNiue.inject({ method: 'GET', url: '/api/v1/me/heatmap?weeks=1' });
      const niueBody = JSON.parse(niueResponse.payload) as { days: Array<{ date: string; count: number }> };
      await fastifyNiue.close();

      const kiritimatiDate = kiritimatiBody.days.find((d) => d.count > 0)?.date;
      const niueDate = niueBody.days.find((d) => d.count > 0)?.date;

      expect(kiritimatiDate).toBeDefined();
      expect(niueDate).toBeDefined();
      // Kiritimati is UTC+14 and Niue is UTC-11 — a 25-hour spread, so the
      // SAME UTC instant reliably lands on different local calendar dates.
      expect(kiritimatiDate).not.toBe(niueDate);
    });

    it('calls can() with a "me:heatmap:read" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ actor, can: canSpy });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/heatmap' });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('me:heatmap:read');

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ actor, can: () => false });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/heatmap' });

      expect(response.statusCode).toBe(403);
      await fastify.close();
    });
  });
});
