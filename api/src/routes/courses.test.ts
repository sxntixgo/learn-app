import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { DEV_ACTOR } from '../policy/can.ts';

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
  throw new Error('TEST_DATABASE_URL is not set — required to run courses.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Applies db/migrations/*.sql that aren't already recorded in schema_migrations.
// Mirrors the technique used by (the now-removed) lessons.test.ts and
// tools/src/migrate.test.ts — see those for the rationale.
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
// Fixture: one course with two live modules (A, B), one archived module (C),
// and one archived lesson living inside a live module (A) — so archive
// invisibility is exercised at both the module level and the lesson level.
//
// Manifest order across the whole course (live rows only):
//   A1 -> A2 -> B1
// (mod-a-archived and everything in mod-c must never appear anywhere.)
// ---------------------------------------------------------------------------

const COURSE_SLUG = 'courses-route-test-course';
const BLOCKS = [{ type: 'prose', html: '<p>Hello</p>' }];

let courseId: string;

async function insertModule(
  key: string,
  title: string,
  position: number,
  archived: boolean,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position, archived_at)
     values ($1, $2, $3, $4, $5)
     on conflict (course_id, key) do update set title = excluded.title
     returning id`,
    [courseId, key, title, position, archived ? new Date() : null],
  );
  return rows[0]!.id;
}

async function insertLesson(args: {
  moduleId: string;
  lessonKey: string;
  slug: string;
  title: string;
  position: number;
  trackId?: string | null;
  estimateMinutes?: number | null;
  archived?: boolean;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into lessons
       (course_id, module_id, track_id, lesson_key, slug, title, kind, estimate_minutes, position,
        source_path, content_hash, blocks, archived_at)
     values ($1, $2, $3, $4, $5, $6, 'lesson', $7, $8, $9, $10, $11, $12)
     on conflict (module_id, lesson_key) do update set title = excluded.title
     returning id`,
    [
      courseId,
      args.moduleId,
      args.trackId ?? null,
      args.lessonKey,
      args.slug,
      args.title,
      args.estimateMinutes ?? null,
      args.position,
      `${args.slug}.md`,
      `hash-${args.slug}`,
      JSON.stringify(BLOCKS),
      args.archived ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

describe('courses routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, subtitle, description, tags)
       values ($1, $2, $3, $4, $5)
       on conflict (slug) do update set slug = excluded.slug
       returning id`,
      [COURSE_SLUG, 'Courses Route Test Course', 'A subtitle', 'A description', ['tag-a', 'tag-b']],
    );
    courseId = course.rows[0]!.id;

    const track = await pool.query<{ id: string }>(
      `insert into tracks (course_id, key, name, hue, blurb, position)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (course_id, key) do update set key = excluded.key
       returning id`,
      [courseId, 'setup', 'Setup', 'blue', 'Getting set up', 0],
    );
    const trackId = track.rows[0]!.id;

    const modA = await insertModule('mod-a', 'Module A', 0, false);
    const modB = await insertModule('mod-b', 'Module B', 1, false);
    await insertModule('mod-c', 'Module C', 2, true); // archived module

    await insertLesson({
      moduleId: modA,
      lessonKey: 'a1',
      slug: 'mod-a-lesson-1',
      title: 'Lesson A1',
      position: 0,
      trackId,
      estimateMinutes: 10,
    });
    await insertLesson({
      moduleId: modA,
      lessonKey: 'a2',
      slug: 'mod-a-lesson-2',
      title: 'Lesson A2',
      position: 1,
    });
    await insertLesson({
      moduleId: modA,
      lessonKey: 'a-archived',
      slug: 'mod-a-archived-lesson',
      title: 'Archived Lesson',
      position: 2,
      archived: true,
    });
    await insertLesson({
      moduleId: modB,
      lessonKey: 'b1',
      slug: 'mod-b-lesson-1',
      title: 'Lesson B1',
      position: 0,
    });
  });

  afterAll(async () => {
    await pool.query('delete from courses where slug = $1', [COURSE_SLUG]);
    await closePool();
  });

  describe('GET /api/v1/courses', () => {
    it('lists course summaries with counts that exclude archived modules/lessons', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as Array<Record<string, unknown>>;
      const summary = body.find((c) => c.slug === COURSE_SLUG);

      expect(summary).toBeDefined();
      expect(summary).toMatchObject({
        slug: COURSE_SLUG,
        title: 'Courses Route Test Course',
        subtitle: 'A subtitle',
        description: 'A description',
        tags: ['tag-a', 'tag-b'],
        moduleCount: 2,
        lessonCount: 3,
      });

      await fastify.close();
    });

    it('calls can() with a "course:list" action — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('course:list');
      expect(actorArg).toBeTruthy();

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.payload) as { message: string };
      expect(typeof body.message).toBe('string');

      await fastify.close();
    });
  });

  describe('GET /api/v1/courses/:courseSlug', () => {
    it('returns the course, its tracks, and only its non-archived modules/lessons in manifest order', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}` });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        slug: string;
        tracks: Array<Record<string, unknown>>;
        modules: Array<{ key: string; lessons: Array<{ slug: string }> }>;
      };

      expect(body.slug).toBe(COURSE_SLUG);
      expect(body.tracks).toHaveLength(1);
      expect(body.tracks[0]).toMatchObject({ key: 'setup', name: 'Setup', hue: 'blue', blurb: 'Getting set up' });

      // mod-c (archived) must be invisible.
      expect(body.modules.map((m) => m.key)).toEqual(['mod-a', 'mod-b']);

      const modA = body.modules.find((m) => m.key === 'mod-a')!;
      // the archived lesson in mod-a must be invisible.
      expect(modA.lessons.map((l) => l.slug)).toEqual(['mod-a-lesson-1', 'mod-a-lesson-2']);

      await fastify.close();
    });

    it('returns 404 with a message body for an unknown course slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses/no-such-course-xyz' });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { message: string };
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);

      await fastify.close();
    });

    it('calls can() with a "course:read" action and the course as resource — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}` });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('course:read');
      expect(actorArg).toBeTruthy();
      expect(resourceArg).toMatchObject({ slug: COURSE_SLUG });

      await fastify.close();
    });
  });

  describe('GET /api/v1/courses/:courseSlug/lessons/:lessonSlug', () => {
    it('returns the lesson with prev/next computed across the whole course, not just the module', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const a1 = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-1` });
      expect(a1.statusCode).toBe(200);
      const a1Body = JSON.parse(a1.payload);
      expect(a1Body).toMatchObject({
        slug: 'mod-a-lesson-1',
        title: 'Lesson A1',
        kind: 'lesson',
        track: 'setup',
        estimateMinutes: 10,
        prev: null,
        next: { slug: 'mod-a-lesson-2', title: 'Lesson A2' },
      });
      expect(Array.isArray(a1Body.blocks)).toBe(true);

      // Crosses the module boundary: A2's next is B1, in a different module.
      const a2 = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-2` });
      expect(a2.statusCode).toBe(200);
      const a2Body = JSON.parse(a2.payload);
      expect(a2Body.prev).toEqual({ slug: 'mod-a-lesson-1', title: 'Lesson A1' });
      expect(a2Body.next).toEqual({ slug: 'mod-b-lesson-1', title: 'Lesson B1' });
      expect(a2Body.track).toBeNull();

      const b1 = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-b-lesson-1` });
      expect(b1.statusCode).toBe(200);
      const b1Body = JSON.parse(b1.payload);
      expect(b1Body.prev).toEqual({ slug: 'mod-a-lesson-2', title: 'Lesson A2' });
      expect(b1Body.next).toBeNull();

      await fastify.close();
    });

    it('includes the actor\'s progress (null when none exists, populated once a row does)', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const before = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-b-lesson-1` });
      expect(before.statusCode).toBe(200);
      expect(JSON.parse(before.payload).progress).toBeNull();

      const lessonRow = await pool.query<{ id: string }>(
        `select id from lessons where course_id = $1 and slug = 'mod-b-lesson-1'`,
        [courseId],
      );
      await pool.query(
        `insert into lesson_progress (user_id, lesson_id, state, last_position)
         values ($1, $2, 'in_progress', 'block-2')`,
        [DEV_ACTOR.id, lessonRow.rows[0]!.id],
      );

      const after = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-b-lesson-1` });
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.payload).progress).toMatchObject({ state: 'in_progress', lastPosition: 'block-2' });

      await pool.query('delete from lesson_progress where user_id = $1 and lesson_id = $2', [
        DEV_ACTOR.id,
        lessonRow.rows[0]!.id,
      ]);

      await fastify.close();
    });

    it('returns 404 for an archived lesson requested directly', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-archived-lesson`,
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { message: string };
      expect(typeof body.message).toBe('string');

      await fastify.close();
    });

    it('returns 404 for a lesson whose module is archived', async () => {
      // mod-c has no lessons in this fixture, but a lesson living in an
      // archived module must not be reachable even if the lesson row itself
      // is not archived. Insert one directly to prove the join, not just the
      // lesson-level archived_at, gates visibility.
      const modC = await pool.query<{ id: string }>(`select id from modules where course_id = $1 and key = 'mod-c'`, [
        courseId,
      ]);
      await insertLesson({
        moduleId: modC.rows[0]!.id,
        lessonKey: 'c1',
        slug: 'mod-c-lesson-1',
        title: 'Lesson C1',
        position: 0,
      });

      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-c-lesson-1`,
      });

      expect(response.statusCode).toBe(404);

      await fastify.close();
    });

    it('returns 404 for an unknown lesson slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/no-such-lesson-xyz`,
      });

      expect(response.statusCode).toBe(404);

      await fastify.close();
    });

    it('returns 404 for an unknown course slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/courses/no-such-course-xyz/lessons/mod-a-lesson-1',
      });

      expect(response.statusCode).toBe(404);

      await fastify.close();
    });

    it('calls can() with a "lesson:read" action and the lesson as resource — the seam guard', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-1`,
      });

      expect(response.statusCode).toBe(200);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('lesson:read');
      expect(actorArg).toBeTruthy();
      expect(resourceArg).toMatchObject({ slug: 'mod-a-lesson-1' });

      await fastify.close();
    });

    it('returns 403 when the injected policy denies access', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-1`,
      });

      expect(response.statusCode).toBe(403);

      await fastify.close();
    });
  });
});
