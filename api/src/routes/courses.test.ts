import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { DEV_ACTOR, ANONYMOUS_ACTOR } from '../policy/can.ts';
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

    // visibility: 'open' explicitly — this fixture exists to exercise
    // archived-module/lesson visibility, prev/next, and progress, none of
    // which are about course visibility (§12). Leaving it at the column's
    // real default ('hidden', migration 0008) would 404 every test below
    // for DEV_ACTOR, an unowned-course non-owner. The dedicated visibility
    // behavior gets its own fixtures further down.
    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, subtitle, description, tags, visibility)
       values ($1, $2, $3, $4, $5, 'open')
       on conflict (slug) do update set slug = excluded.slug, visibility = 'open'
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

    it('calls can() with a "course:list" action as the floor check, then "course:read" per row for the §12 filter', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });

      expect(response.statusCode).toBe(200);
      // The FIRST call is always the whole-list floor check, before a single
      // row is even queried — this is what lets a denied actor never reach
      // the database at all.
      const [actorArg, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('course:list');
      expect(actorArg).toBeTruthy();
      // Every call after the first is the per-row §12 visibility filter
      // (course:read), one per course currently in the table.
      const rowChecks = canSpy.mock.calls.slice(1);
      expect(rowChecks.length).toBeGreaterThan(0);
      for (const call of rowChecks) {
        expect(call[1]).toBe('course:read');
      }

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
      // The FIRST call is always the discoverability check (course:read,
      // short-circuiting before course:manage:read since canSpy allows it).
      // A second call, course:visibility:set, computes the response's
      // `canPublish` flag (Task C/E) — the seam this test is about is the
      // first call, so that is the one asserted in full.
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

  // ===========================================================================
  // The route half of the chokepoint.
  //
  // policy/can.ts denies any course-scoped decision made without an ownership
  // context, which is only a safety property if the routes actually SUPPLY
  // one. These assert the wiring: the resource handed to can() carries
  // `course.ownerId` straight from `courses.owner_id` (migration 0007), so a
  // future ownership rule cannot be silently defeated by a route that forgot
  // to select the column.
  // ===========================================================================
  describe('the ownership context the routes hand can()', () => {
    it('GET /courses/:slug passes the course owner', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}` });

      const [, , resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      // Imported by the fixture, so unowned — and `null` is a real answer
      // here, distinct from the key being absent, which can() reads as "the
      // caller forgot" and denies.
      expect(resourceArg).toMatchObject({ slug: COURSE_SLUG, course: { ownerId: null } });

      await fastify.close();
    });

    it('GET /courses/:slug/lessons/:slug passes the OWNING COURSE of the lesson', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-1` });

      const [, , resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(resourceArg).toMatchObject({ slug: 'mod-a-lesson-1', course: { ownerId: null } });

      await fastify.close();
    });

    it('reflects a real owner_id, not a hardcoded null', async () => {
      const owner = await pool.query<{ id: string }>(
        `insert into users (display_name) values ($1) returning id`,
        [`Courses Route Test Owner ${Date.now()}`],
      );
      const ownerId = owner.rows[0]!.id;
      await pool.query('update courses set owner_id = $2 where slug = $1', [COURSE_SLUG, ownerId]);

      try {
        const canSpy = vi.fn().mockReturnValue(true);
        const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

        await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}` });

        const [, , resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
        expect(resourceArg).toMatchObject({ course: { ownerId } });

        await fastify.close();
      } finally {
        await pool.query('update courses set owner_id = null where slug = $1', [COURSE_SLUG]);
        await pool.query('delete from users where id = $1', [ownerId]);
      }
    });

    it('under the REAL policy, reading is a student power — a teacher-only actor is refused', async () => {
      // Design §5: a teacher "can author a course only they can read —
      // register a repo, let the course land hidden, self-enroll". The
      // self-enrollment is how a teacher reads; the teacher role alone does
      // not open the lesson.
      const teacher: Actor = { id: DEV_ACTOR.id, roles: ['teacher'] };
      const fastify = await buildServer({ actor: teacher });

      const course = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_SLUG}` });
      const lesson = await fastify.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_SLUG}/lessons/mod-a-lesson-1`,
      });
      const list = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });

      expect([course.statusCode, lesson.statusCode, list.statusCode]).toEqual([403, 403, 403]);

      await fastify.close();
    });
  });

  // ===========================================================================
  // Task A-D: course visibility (design §12), catalog filtering, publish/
  // ownership, and enrolment. Four fixture courses, one owner, real can().
  //
  //   vis-open       unowned, open        — any student reads + self-enrols
  //   vis-restricted unowned, restricted  — listed, self-enrol refused
  //   vis-hidden     unowned, hidden      — absent everywhere except admin
  //   vis-owned-hidden owned, hidden      — absent except its owner + admin
  //
  // OUTSIDER is DEV_ACTOR (plain student, owns nothing here). OWNER_STUDENT
  // holds BOTH roles on the SAME id that owns vis-owned-hidden — the dual-role
  // shape design §5 actually describes ("a teacher holding both roles can
  // author a course only they can read... self-enroll"), not a teacher-only
  // actor, which is deliberately covered separately (it gets none of this).
  // ===========================================================================
  describe('course visibility, publishing, and enrolment (design §12, Phase 6)', () => {
    const OUTSIDER = DEV_ACTOR;
    const ADMIN: Actor = { id: '99999999-9999-9999-9999-999999999999', roles: ['admin'] };

    const OPEN_SLUG = 'vis-open-course';
    const RESTRICTED_SLUG = 'vis-restricted-course';
    const HIDDEN_SLUG = 'vis-hidden-course';
    const OWNED_HIDDEN_SLUG = 'vis-owned-hidden-course';
    const OWNED_HIDDEN_LESSON_SLUG = 'vis-owned-hidden-lesson-1';

    let ownerId: string;
    let ownerStudent: Actor;
    let ownedHiddenCourseId: string;

    async function insertVisCourse(slug: string, visibility: string, owner: string | null): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `insert into courses (slug, title, visibility, owner_id)
         values ($1, $2, $3, $4)
         on conflict (slug) do update set visibility = excluded.visibility, owner_id = excluded.owner_id
         returning id`,
        [slug, slug, visibility, owner],
      );
      return rows[0]!.id;
    }

    beforeAll(async () => {
      const owner = await pool.query<{ id: string }>(
        `insert into users (display_name) values ($1) returning id`,
        [`Vis Owner ${Date.now()}`],
      );
      ownerId = owner.rows[0]!.id;
      ownerStudent = { id: ownerId, roles: ['teacher', 'student'] };

      // Real DB roles for ownerId only — the PATCH route re-checks the
      // database (design §13, actorWithFreshRoles), so a PATCH test that
      // wants the REAL can() to authorize ownerStudent needs a real row
      // here, not just an in-memory Actor. Cascades away with the user row
      // in afterAll.
      await pool.query(`insert into user_roles (user_id, role) values ($1, 'teacher') on conflict do nothing`, [
        ownerId,
      ]);
      await pool.query(`insert into user_roles (user_id, role) values ($1, 'student') on conflict do nothing`, [
        ownerId,
      ]);

      await insertVisCourse(OPEN_SLUG, 'open', null);
      await insertVisCourse(RESTRICTED_SLUG, 'restricted', null);
      await insertVisCourse(HIDDEN_SLUG, 'hidden', null);
      ownedHiddenCourseId = await insertVisCourse(OWNED_HIDDEN_SLUG, 'hidden', ownerId);

      const mod = await pool.query<{ id: string }>(
        `insert into modules (course_id, key, title, position) values ($1, 'm', 'M', 0)
         on conflict (course_id, key) do update set title = excluded.title
         returning id`,
        [ownedHiddenCourseId],
      );
      await pool.query(
        `insert into lessons
           (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
         values ($1, $2, 'l1', $3, 'Hidden Lesson', 'lesson', 0, 'l1.md', 'hash-hidden-1', $4::jsonb)
         on conflict (module_id, lesson_key) do update set title = excluded.title`,
        [ownedHiddenCourseId, mod.rows[0]!.id, OWNED_HIDDEN_LESSON_SLUG, JSON.stringify(BLOCKS)],
      );
    });

    afterAll(async () => {
      await pool.query('delete from courses where slug = any($1)', [
        [OPEN_SLUG, RESTRICTED_SLUG, HIDDEN_SLUG, OWNED_HIDDEN_SLUG],
      ]);
      await pool.query('delete from users where id = $1', [ownerId]);
    });

    // -------------------------------------------------------------------
    // GET /api/v1/courses — the catalog filter, one cell per actor
    // -------------------------------------------------------------------
    describe('GET /api/v1/courses filters by visibility and actor', () => {
      it('anonymous: refused outright — course:list has no anonymous/admin cell, only student', async () => {
        const fastify = await buildServer({ actor: ANONYMOUS_ACTOR });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });
        expect(response.statusCode).toBe(403);
        await fastify.close();
      });

      it('a student: sees open + restricted, never hidden (owned or not)', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });
        expect(response.statusCode).toBe(200);
        const slugs = (JSON.parse(response.payload) as Array<{ slug: string }>).map((c) => c.slug);
        expect(slugs).toContain(OPEN_SLUG);
        expect(slugs).toContain(RESTRICTED_SLUG);
        expect(slugs).not.toContain(HIDDEN_SLUG);
        expect(slugs).not.toContain(OWNED_HIDDEN_SLUG);
        await fastify.close();
      });

      it('the owner: additionally sees their own hidden course, but still not someone else’s', async () => {
        const fastify = await buildServer({ actor: ownerStudent });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });
        expect(response.statusCode).toBe(200);
        const slugs = (JSON.parse(response.payload) as Array<{ slug: string }>).map((c) => c.slug);
        expect(slugs).toContain(OPEN_SLUG);
        expect(slugs).toContain(RESTRICTED_SLUG);
        expect(slugs).toContain(OWNED_HIDDEN_SLUG);
        expect(slugs).not.toContain(HIDDEN_SLUG);
        await fastify.close();
      });

      it('admin: refused at the catalog floor too — §5.1, admin cannot enrol, and browsing IS the enrol surface', async () => {
        // This is not a gap: an admin's "sees everything" is the DETAIL route
        // below (course:manage:read, unconditional on visibility), which
        // has no course:list-shaped floor at all. See can.test.ts's
        // "admin is exclusive of student and teacher" describe block.
        const fastify = await buildServer({ actor: ADMIN });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });
        expect(response.statusCode).toBe(403);
        await fastify.close();
      });

      it('every returned summary carries its visibility (Task E: shown to the owner)', async () => {
        const fastify = await buildServer({ actor: ownerStudent });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/courses' });
        const body = JSON.parse(response.payload) as Array<{ slug: string; visibility: string }>;
        expect(body.find((c) => c.slug === OPEN_SLUG)?.visibility).toBe('open');
        expect(body.find((c) => c.slug === OWNED_HIDDEN_SLUG)?.visibility).toBe('hidden');
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // GET /api/v1/courses/:slug — the 404-vs-403 line
    // -------------------------------------------------------------------
    describe('GET /api/v1/courses/:slug — 404 (not 403) is what hides a course', () => {
      it('open: readable by a student, refused (403, not 404) for anonymous — it is publicly LISTED', async () => {
        const asStudent = await buildServer({ actor: OUTSIDER });
        const studentRes = await asStudent.inject({ method: 'GET', url: `/api/v1/courses/${OPEN_SLUG}` });
        expect(studentRes.statusCode).toBe(200);
        await asStudent.close();

        const asAnon = await buildServer({ actor: ANONYMOUS_ACTOR });
        const anonRes = await asAnon.inject({ method: 'GET', url: `/api/v1/courses/${OPEN_SLUG}` });
        expect(anonRes.statusCode).toBe(403);
        await asAnon.close();
      });

      it('restricted: still readable (listed) by any student — only enrolment is gated', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${RESTRICTED_SLUG}` });
        expect(response.statusCode).toBe(200);
        await fastify.close();
      });

      it('hidden, unowned: 404 for a student — indistinguishable from a course that does not exist', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${HIDDEN_SLUG}` });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });

      it('hidden, owned: 404 for an outsider, 200 for the owner', async () => {
        const asOutsider = await buildServer({ actor: OUTSIDER });
        const outsiderRes = await asOutsider.inject({ method: 'GET', url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}` });
        expect(outsiderRes.statusCode).toBe(404);
        await asOutsider.close();

        const asOwner = await buildServer({ actor: ownerStudent });
        const ownerRes = await asOwner.inject({ method: 'GET', url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}` });
        expect(ownerRes.statusCode).toBe(200);
        const body = JSON.parse(ownerRes.payload) as { visibility: string; canPublish: boolean };
        expect(body.visibility).toBe('hidden');
        expect(body.canPublish).toBe(true);
        await asOwner.close();
      });

      it('admin sees every course’s detail regardless of visibility — the "sees everything" cell', async () => {
        const fastify = await buildServer({ actor: ADMIN });
        for (const slug of [OPEN_SLUG, RESTRICTED_SLUG, HIDDEN_SLUG, OWNED_HIDDEN_SLUG]) {
          const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${slug}` });
          expect([slug, response.statusCode]).toEqual([slug, 200]);
        }
        await fastify.close();
      });

      it('canPublish is false for an outsider, true for the owner', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${OPEN_SLUG}` });
        expect((JSON.parse(response.payload) as { canPublish: boolean }).canPublish).toBe(false);
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // GET /api/v1/courses/:slug/lessons/:slug — same 404 line, plus: admin
    // can see a hidden course exists (200 at the course level) but still
    // cannot read a lesson's content (§5.1 — admin holds no progress).
    // -------------------------------------------------------------------
    describe('GET .../lessons/:slug on a hidden course', () => {
      it('outsider: 404, before even a lesson lookup happens', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({
          method: 'GET',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/lessons/${OWNED_HIDDEN_LESSON_SLUG}`,
        });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });

      it('owner: reads it — the self-enrollment reading design §5 describes', async () => {
        const fastify = await buildServer({ actor: ownerStudent });
        const response = await fastify.inject({
          method: 'GET',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/lessons/${OWNED_HIDDEN_LESSON_SLUG}`,
        });
        expect(response.statusCode).toBe(200);
        await fastify.close();
      });

      it('admin: the course is discoverable (not 404) but the lesson content itself is still refused (403)', async () => {
        const fastify = await buildServer({ actor: ADMIN });
        const response = await fastify.inject({
          method: 'GET',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/lessons/${OWNED_HIDDEN_LESSON_SLUG}`,
        });
        // Not 404 (admin can see this course exists) and not 200 (admin
        // does not get to read lesson content — lesson:read has no admin
        // cell in policy/can.ts, by design).
        expect(response.statusCode).toBe(403);
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // GET /api/v1/courses/:slug/manage — the owner's settings screen
    // -------------------------------------------------------------------
    describe('GET /api/v1/courses/:slug/manage', () => {
      it('a TEACHER-ONLY actor (no student role) still reaches it — this is how they read their own course', async () => {
        const teacherOnly: Actor = { id: ownerId, roles: ['teacher'] };
        const fastify = await buildServer({ actor: teacherOnly });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/manage` });
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload) as { visibility: string; ownerId: string };
        expect(body.visibility).toBe('hidden');
        expect(body.ownerId).toBe(ownerId);
        await fastify.close();
      });

      it('an outsider gets 404, never 403 — this endpoint has nothing to disclose to them', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/manage` });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });

      it('admin reaches any course’s manage screen, owned or not', async () => {
        const fastify = await buildServer({ actor: ADMIN });
        const response = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${HIDDEN_SLUG}/manage` });
        expect(response.statusCode).toBe(200);
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // PATCH /api/v1/courses/:slug — publish / ownership transfer (Task C)
    // -------------------------------------------------------------------
    describe('PATCH /api/v1/courses/:slug', () => {
      it('calls can() with course:visibility:set and {course:{ownerId}} — never its own role check', async () => {
        const canSpy = vi.fn().mockReturnValue(true);
        const fastify = await buildServer({ can: canSpy, actor: ownerStudent });

        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}`,
          payload: { visibility: 'open' },
        });

        expect(response.statusCode).toBe(200);
        const call = canSpy.mock.calls.find((c) => c[1] === 'course:visibility:set');
        expect(call).toBeDefined();
        expect(call![2]).toMatchObject({ course: { ownerId } });

        await fastify.close();
      });

      it('calls can() with course:ownership:transfer when ownerId is in the body', async () => {
        const canSpy = vi.fn().mockReturnValue(true);
        const fastify = await buildServer({ can: canSpy, actor: ADMIN });

        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${OPEN_SLUG}`,
          payload: { ownerId: ownerId },
        });

        expect(response.statusCode).toBe(200);
        const call = canSpy.mock.calls.find((c) => c[1] === 'course:ownership:transfer');
        expect(call).toBeDefined();
        expect(call![2]).toMatchObject({ course: { ownerId: null } });

        // Revert — this route call really did write owner_id.
        await pool.query('update courses set owner_id = null where slug = $1', [OPEN_SLUG]);
        await fastify.close();
      });

      it('403s when the injected policy denies — and writes nothing', async () => {
        const fastify = await buildServer({ can: () => false, actor: ownerStudent });
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${OPEN_SLUG}`,
          payload: { visibility: 'hidden' },
        });
        expect(response.statusCode).toBe(403);

        const row = await pool.query<{ visibility: string }>('select visibility from courses where slug = $1', [
          OPEN_SLUG,
        ]);
        expect(row.rows[0]!.visibility).toBe('open');
        await fastify.close();
      });

      it('400s on an unrecognised visibility value', async () => {
        const fastify = await buildServer({ can: () => true, actor: ownerStudent });
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${OPEN_SLUG}`,
          payload: { visibility: 'public' },
        });
        expect(response.statusCode).toBe(400);
        await fastify.close();
      });

      it('400s on an empty body', async () => {
        const fastify = await buildServer({ can: () => true, actor: ownerStudent });
        const response = await fastify.inject({ method: 'PATCH', url: `/api/v1/courses/${OPEN_SLUG}`, payload: {} });
        expect(response.statusCode).toBe(400);
        await fastify.close();
      });

      it('404s on a hidden course an outsider cannot discover, rather than 403', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${HIDDEN_SLUG}`,
          payload: { visibility: 'open' },
        });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });

      it('under the REAL policy: the owner (fresh DB roles) publishes their own hidden course', async () => {
        // No `can` override here — this exercises actorWithFreshRoles end to
        // end (design §13), reading the user_roles rows inserted in
        // beforeAll, and the real course:visibility:set/OWN_COURSE decision.
        const fastify = await buildServer({ actor: { id: ownerId, roles: [] } });

        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}`,
          payload: { visibility: 'restricted' },
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toMatchObject({ visibility: 'restricted' });

        const row = await pool.query<{ visibility: string }>('select visibility from courses where slug = $1', [
          OWNED_HIDDEN_SLUG,
        ]);
        expect(row.rows[0]!.visibility).toBe('restricted');

        // Restore for any test after this one in the file.
        await pool.query(`update courses set visibility = 'hidden' where slug = $1`, [OWNED_HIDDEN_SLUG]);
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // POST/DELETE /api/v1/courses/:slug/enrolments (Task D)
    // -------------------------------------------------------------------
    describe('POST /api/v1/courses/:slug/enrolments', () => {
      afterAll(async () => {
        await pool.query('delete from enrollments where user_id = any($1)', [[OUTSIDER.id, ownerId]]);
      });

      it('a student self-enrols in an open course', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toMatchObject({ enrolled: true });

        const row = await pool.query('select status from enrollments where user_id = $1 and course_id = $2', [
          OUTSIDER.id,
          (await pool.query('select id from courses where slug = $1', [OPEN_SLUG])).rows[0].id,
        ]);
        expect(row.rows[0]!.status).toBe('active');
        await fastify.close();
      });

      it('is idempotent: enrolling twice leaves exactly one row', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        const response = await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        expect(response.statusCode).toBe(200);

        const courseId = (await pool.query('select id from courses where slug = $1', [OPEN_SLUG])).rows[0].id;
        const rows = await pool.query('select * from enrollments where user_id = $1 and course_id = $2', [
          OUTSIDER.id,
          courseId,
        ]);
        expect(rows.rowCount).toBe(1);
        await fastify.close();
      });

      it('a restricted course refuses self-enrolment for anyone but the owner', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({
          method: 'POST',
          url: `/api/v1/courses/${RESTRICTED_SLUG}/enrolments`,
        });
        expect(response.statusCode).toBe(403);
        expect((JSON.parse(response.payload) as { message: string }).message).toMatch(/invite/i);
        await fastify.close();
      });

      it('the owner self-enrols in their OWN hidden course — the design §5 scenario', async () => {
        const fastify = await buildServer({ actor: ownerStudent });
        const response = await fastify.inject({
          method: 'POST',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/enrolments`,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toMatchObject({ enrolled: true });
        await fastify.close();
      });

      it('an outsider cannot even discover a hidden course to try enrolling — 404, not 403', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({
          method: 'POST',
          url: `/api/v1/courses/${OWNED_HIDDEN_SLUG}/enrolments`,
        });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });

      it('an admin is refused — §5.1: admin cannot enrol, ever, even in an open course', async () => {
        const fastify = await buildServer({ actor: ADMIN });
        const response = await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        expect(response.statusCode).toBe(403);
        await fastify.close();
      });

      it('404s for an unknown course slug', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({ method: 'POST', url: '/api/v1/courses/no-such-course-xyz/enrolments' });
        expect(response.statusCode).toBe(404);
        await fastify.close();
      });
    });

    describe('DELETE /api/v1/courses/:slug/enrolments', () => {
      afterAll(async () => {
        await pool.query('delete from enrollments where user_id = $1', [OUTSIDER.id]);
      });

      it('un-enrols (soft: status flips to withdrawn, the row survives)', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });

        const response = await fastify.inject({
          method: 'DELETE',
          url: `/api/v1/courses/${OPEN_SLUG}/enrolments`,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toMatchObject({ enrolled: false });

        const courseId = (await pool.query('select id from courses where slug = $1', [OPEN_SLUG])).rows[0].id;
        const row = await pool.query('select status from enrollments where user_id = $1 and course_id = $2', [
          OUTSIDER.id,
          courseId,
        ]);
        expect(row.rows[0]!.status).toBe('withdrawn');
        await fastify.close();
      });

      it('re-enrolling after withdrawing flips the same row back to active', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });
        await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        await fastify.inject({ method: 'DELETE', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });
        await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });

        const courseId = (await pool.query('select id from courses where slug = $1', [OPEN_SLUG])).rows[0].id;
        const rows = await pool.query('select status from enrollments where user_id = $1 and course_id = $2', [
          OUTSIDER.id,
          courseId,
        ]);
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0]!.status).toBe('active');
        await fastify.close();
      });

      it('is a harmless no-op when the actor was never enrolled (but is still eligible to enrol)', async () => {
        // OPEN_SLUG, not RESTRICTED_SLUG: the DELETE handler reuses
        // course:enrol as its gate (documented KNOWN GAP in courses.ts), so
        // it only reaches the "was there a row" no-op question for a course
        // the actor could actually enrol in.
        const fastify = await buildServer({ actor: OUTSIDER });
        const response = await fastify.inject({
          method: 'DELETE',
          url: `/api/v1/courses/${OPEN_SLUG}/enrolments`,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toMatchObject({ enrolled: false });
        await fastify.close();
      });
    });

    // -------------------------------------------------------------------
    // The catalog respects enrolment (Task D)
    // -------------------------------------------------------------------
    describe('the catalog reflects enrolment', () => {
      afterAll(async () => {
        await pool.query('delete from enrollments where user_id = $1', [OUTSIDER.id]);
      });

      it('GET /courses/:slug reports enrolled: false, then true after enrolling', async () => {
        const fastify = await buildServer({ actor: OUTSIDER });

        const before = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${OPEN_SLUG}` });
        expect((JSON.parse(before.payload) as { enrolled: boolean }).enrolled).toBe(false);

        await fastify.inject({ method: 'POST', url: `/api/v1/courses/${OPEN_SLUG}/enrolments` });

        const after = await fastify.inject({ method: 'GET', url: `/api/v1/courses/${OPEN_SLUG}` });
        expect((JSON.parse(after.payload) as { enrolled: boolean }).enrolled).toBe(true);

        await fastify.close();
      });
    });
  });
});
