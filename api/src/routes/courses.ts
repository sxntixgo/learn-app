import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor, CourseVisibility } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { actorWithFreshRoles } from '../auth/roles.ts';

export interface CourseRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as lessons.ts
  // used in Phase 1: defaults to the real `can`; tests override it to
  // exercise the 403 path and to spy on calls without needing `can()` to
  // ever actually return false in Phase 2.
  can?: typeof defaultCan;
  actor?: Actor;
}

const KNOWN_VISIBILITIES: ReadonlySet<string> = new Set(['open', 'restricted', 'hidden']);

interface CourseSummaryRow {
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tags: string[];
  module_count: number;
  lesson_count: number;
  owner_id: string | null;
  visibility: CourseVisibility;
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tags: string[];
  // Migration 0007. Selected on every route that asks a course-scoped policy
  // question, because `can()` cannot query for it and treats a missing
  // ownership context as a denial (policy/can.ts, property 2).
  owner_id: string | null;
  // Migration 0008. Selected alongside owner_id for the same reason — see
  // policyContext/isDiscoverable below.
  visibility: CourseVisibility;
}

interface TrackRow {
  key: string;
  name: string;
  hue: string;
  blurb: string | null;
}

interface ModuleLessonRow {
  module_key: string;
  module_title: string;
  module_position: number;
  lesson_slug: string | null;
  lesson_title: string | null;
  lesson_kind: string | null;
  lesson_position: number | null;
  estimate_minutes: number | null;
  track_key: string | null;
}

interface CourseLessonRow {
  id: string;
  slug: string;
  title: string;
  kind: string;
  estimate_minutes: number | null;
  track_key: string | null;
  blocks: unknown;
}

interface LessonProgressRow {
  state: string;
  last_position: string | null;
}

/** The two database facts every visibility-aware policy question needs (design §12, migrations 0007/0008). */
function policyContext(row: { owner_id: string | null; visibility: CourseVisibility }): {
  ownerId: string | null;
  visibility: CourseVisibility;
} {
  return { ownerId: row.owner_id, visibility: row.visibility };
}

/**
 * Whether this course's EXISTENCE may be disclosed to `actor` at all — the
 * 404-vs-403 line design §12 draws: "hidden — absent from the catalog...
 * a direct fetch 404s (not 403 — a 403 confirms it exists)".
 *
 * True through either of two independent doors: `course:read` (a browsing
 * student — open/restricted are listed, and the predicate bypasses
 * visibility entirely for the course's own owner) or `course:manage:read`
 * (the owner's/admin's settings view, unconditional on visibility). A
 * course visible through neither door does not exist as far as `actor` is
 * concerned, hidden or not.
 */
function isDiscoverable(
  can: typeof defaultCan,
  actor: Actor,
  slug: string,
  row: { owner_id: string | null; visibility: CourseVisibility },
): boolean {
  // `slug` rides along on both calls (not read by can(), which only reads
  // `course`) so a denial is legible in a log — the same convention every
  // other can() call in this file follows.
  const resource = { slug, course: policyContext(row) };
  return can(actor, 'course:read', resource) || can(actor, 'course:manage:read', resource);
}

/** Registers the course + course-scoped-lesson routes on `fastify`. */
export function registerCourseRoutes(fastify: FastifyInstance, deps: CourseRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.get('/api/v1/courses', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    // The seam: resolve actor, then ask before returning anything. A list
    // response has no single natural resource, so `resource` is omitted —
    // this is the FLOOR check (design §5: "reading is a student power"), not
    // the per-row visibility filter below. An actor who fails this never
    // reaches the query at all.
    if (!can(actor, 'course:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // enrolled is a LEFT JOIN against $1 (the actor's own id): the nil uuid
    // of an anonymous actor matches no row, so this is safe with no actor
    // branch (policy/can.ts's own ANONYMOUS_ACTOR doc comment applies here
    // too), though an anonymous actor never reaches this query — course:list
    // above already refused them.
    const result = await getPool().query<CourseSummaryRow>(
      `select
        c.slug, c.title, c.subtitle, c.description, c.tags, c.owner_id, c.visibility,
        (select count(*) from modules m where m.course_id = c.id and m.archived_at is null)::int as module_count,
        (select count(*) from lessons l where l.course_id = c.id and l.archived_at is null)::int as lesson_count
      from courses c
      order by c.title`,
    );

    // §12's catalog filter, row by row: `open`/`restricted` are listed for
    // any student; `hidden` only for the course's own owner (course:read's
    // ownership bypass — see policy/can.ts). An admin does not reach this
    // route at all (course:list has no admin cell, by design: §5.1, "an
    // admin ... cannot enrol" — the catalog is the browse-to-enrol surface).
    // An admin's "sees everything" is the DETAIL route below, through
    // course:manage:read, which has no visibility gate.
    const visible = result.rows.filter((row) =>
      can(actor, 'course:read', { slug: row.slug, course: policyContext(row) }),
    );

    const summaries = visible.map((row) => ({
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      tags: row.tags,
      moduleCount: row.module_count,
      lessonCount: row.lesson_count,
      visibility: row.visibility,
    }));

    return reply.code(200).send(summaries);
  });

  fastify.get<{ Params: { courseSlug: string } }>('/api/v1/courses/:courseSlug', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    const { courseSlug } = request.params;

    const courseResult = await getPool().query<CourseRow>(
      'select id, slug, title, subtitle, description, tags, owner_id, visibility from courses where slug = $1',
      [courseSlug],
    );
    const courseRow = courseResult.rows[0];
    if (!courseRow) {
      return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
    }

    // The 404-vs-403 line (design §12): a hidden course that `actor` cannot
    // discover reports 404, identical to an unknown slug — a 403 here would
    // confirm the course exists. A listed (open/restricted) course actor
    // cannot read (e.g. anonymous) still 403s, because listing already made
    // its existence public.
    const discoverable = isDiscoverable(can, actor, courseSlug, courseRow);
    if (!discoverable) {
      if (courseRow.visibility === 'hidden') {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const tracksResult = await getPool().query<TrackRow>(
      'select key, name, hue, blurb from tracks where course_id = $1 order by position',
      [courseRow.id],
    );
    const tracks = tracksResult.rows.map((t) => ({ key: t.key, name: t.name, hue: t.hue, blurb: t.blurb }));

    // Modules joined to their non-archived lessons in one query, in manifest
    // order (module position, then lesson position). Archived modules are
    // excluded by the WHERE clause; archived lessons by the JOIN condition —
    // a module left with zero live lessons still keeps its row (left join),
    // it just gets an empty `lessons` array.
    const rowsResult = await getPool().query<ModuleLessonRow>(
      `select
         m.key as module_key, m.title as module_title, m.position as module_position,
         l.slug as lesson_slug, l.title as lesson_title, l.kind as lesson_kind,
         l.position as lesson_position, l.estimate_minutes, t.key as track_key
       from modules m
       left join lessons l on l.module_id = m.id and l.archived_at is null
       left join tracks t on t.id = l.track_id
       where m.course_id = $1 and m.archived_at is null
       order by m.position, l.position`,
      [courseRow.id],
    );

    const modulesByKey = new Map<
      string,
      { key: string; title: string; position: number; lessons: Array<Record<string, unknown>> }
    >();
    for (const row of rowsResult.rows) {
      let mod = modulesByKey.get(row.module_key);
      if (!mod) {
        mod = { key: row.module_key, title: row.module_title, position: row.module_position, lessons: [] };
        modulesByKey.set(row.module_key, mod);
      }
      if (row.lesson_slug !== null) {
        mod.lessons.push({
          slug: row.lesson_slug,
          title: row.lesson_title,
          kind: row.lesson_kind,
          position: row.lesson_position,
          track: row.track_key,
          estimateMinutes: row.estimate_minutes,
        });
      }
    }
    const modules = [...modulesByKey.values()].sort((a, b) => a.position - b.position);

    // Whether THIS actor is enrolled (design §12/Task D: "the catalog must
    // respect enrolment") — only 'active' counts; a withdrawn row reads the
    // same as never having enrolled.
    const enrolledResult = await getPool().query<{ exists: boolean }>(
      `select exists(
         select 1 from enrollments where user_id = $1 and course_id = $2 and status = 'active'
       ) as exists`,
      [actor.id, courseRow.id],
    );
    const enrolled = enrolledResult.rows[0]?.exists ?? false;

    const course = {
      slug: courseRow.slug,
      title: courseRow.title,
      subtitle: courseRow.subtitle,
      description: courseRow.description,
      tags: courseRow.tags,
      tracks,
      modules,
      visibility: courseRow.visibility,
      enrolled,
      // Drives the web publish control (Task E): the server, not the
      // client, decides who may see it — the client never re-derives
      // ownership/role logic of its own.
      canPublish: can(actor, 'course:visibility:set', { course: { ownerId: courseRow.owner_id } }),
    };

    return reply.code(200).send(course);
  });

  fastify.get<{ Params: { courseSlug: string } }>(
    '/api/v1/courses/:courseSlug/manage',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug } = request.params;

      const courseResult = await getPool().query<CourseRow>(
        'select id, slug, title, subtitle, description, tags, owner_id, visibility from courses where slug = $1',
        [courseSlug],
      );
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // This is the owner's/admin's course-settings screen (design §5's
      // "course:manage:read" cell) — reachable through no door but that one,
      // so a denial here is always reported as 404, never 403: this endpoint
      // has nothing to disclose to anyone it is not the settings screen for,
      // hidden course or not.
      if (!can(actor, 'course:manage:read', { course: { ownerId: courseRow.owner_id } })) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      return reply.code(200).send({
        slug: courseRow.slug,
        title: courseRow.title,
        subtitle: courseRow.subtitle,
        description: courseRow.description,
        ownerId: courseRow.owner_id,
        visibility: courseRow.visibility,
      });
    },
  );

  fastify.patch<{ Params: { courseSlug: string }; Body: { visibility?: unknown; ownerId?: unknown } }>(
    '/api/v1/courses/:courseSlug',
    async (request, reply) => {
      const { courseSlug } = request.params;
      const body = request.body ?? {};

      // Design §13: "privileged mutations re-check the database" — publishing
      // and transferring ownership are exactly that (admin.ts's repo:import
      // is the other example in this codebase). A role revoked a minute ago
      // must not still be able to publish on a still-valid access token.
      const actor = await actorWithFreshRoles(getPool(), actorFor(request, deps));

      const courseResult = await getPool().query<CourseRow>(
        'select id, slug, title, subtitle, description, tags, owner_id, visibility from courses where slug = $1',
        [courseSlug],
      );
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // Same 404-vs-403 reasoning as GET /courses/:slug: a hidden course this
      // actor cannot even discover must not leak its existence through a 403
      // on a totally different verb.
      if (courseRow.visibility === 'hidden' && !isDiscoverable(can, actor, courseSlug, courseRow)) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      const hasVisibility = 'visibility' in body && body.visibility !== undefined;
      const hasOwnerId = 'ownerId' in body && body.ownerId !== undefined;
      if (!hasVisibility && !hasOwnerId) {
        return reply.code(400).send({ message: 'Provide at least one of: visibility, ownerId.' });
      }

      let nextVisibility = courseRow.visibility;
      if (hasVisibility) {
        if (typeof body.visibility !== 'string' || !KNOWN_VISIBILITIES.has(body.visibility)) {
          return reply.code(400).send({ message: 'visibility must be one of: open, restricted, hidden.' });
        }
        // can() called with the CURRENT ownership, never the route's own role
        // check (Task C) — the whole reason course:visibility:set exists.
        if (!can(actor, 'course:visibility:set', { course: { ownerId: courseRow.owner_id } })) {
          return reply.code(403).send({ message: 'Forbidden' });
        }
        nextVisibility = body.visibility as CourseVisibility;
      }

      let nextOwnerId = courseRow.owner_id;
      if (hasOwnerId) {
        if (body.ownerId !== null && typeof body.ownerId !== 'string') {
          return reply.code(400).send({ message: 'ownerId must be a string user id or null.' });
        }
        if (!can(actor, 'course:ownership:transfer', { course: { ownerId: courseRow.owner_id } })) {
          return reply.code(403).send({ message: 'Forbidden' });
        }
        if (body.ownerId !== null) {
          const userResult = await getPool().query('select 1 from users where id = $1', [body.ownerId]);
          if (userResult.rowCount === 0) {
            return reply.code(400).send({ message: `No such user: ${String(body.ownerId)}` });
          }
        }
        nextOwnerId = body.ownerId;
      }

      await getPool().query('update courses set visibility = $2, owner_id = $3, updated_at = now() where id = $1', [
        courseRow.id,
        nextVisibility,
        nextOwnerId,
      ]);

      return reply.code(200).send({ slug: courseRow.slug, visibility: nextVisibility, ownerId: nextOwnerId });
    },
  );

  fastify.post<{ Params: { courseSlug: string } }>(
    '/api/v1/courses/:courseSlug/enrolments',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug } = request.params;

      const courseResult = await getPool().query<CourseRow>(
        'select id, owner_id, visibility from courses where slug = $1',
        [courseSlug],
      );
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      if (courseRow.visibility === 'hidden' && !isDiscoverable(can, actor, courseSlug, courseRow)) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // §12/Task D: gated by can() AND by visibility — course:enrol's
      // STUDENT_ENROLLABLE predicate (policy/can.ts) IS the visibility gate:
      // `open` allows any student, the course's own owner enrols regardless
      // of visibility, and `restricted` denies everyone else (an invite is
      // Phase 13, not built yet). An admin has no cell here at all (§5.1: an
      // admin cannot enrol) — this is what proves that refusal.
      if (!can(actor, 'course:enrol', { course: policyContext(courseRow) })) {
        if (courseRow.visibility === 'restricted') {
          return reply.code(403).send({ message: 'This course requires an invite to join.' });
        }
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const result = await getPool().query<{ enrolled_at: string }>(
        `insert into enrollments (user_id, course_id, status)
         values ($1, $2, 'active')
         on conflict (user_id, course_id) do update set status = 'active', updated_at = now()
         returning enrolled_at`,
        [actor.id, courseRow.id],
      );

      return reply.code(200).send({ enrolled: true, enrolledAt: result.rows[0]!.enrolled_at });
    },
  );

  fastify.delete<{ Params: { courseSlug: string } }>(
    '/api/v1/courses/:courseSlug/enrolments',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug } = request.params;

      const courseResult = await getPool().query<CourseRow>(
        'select id, owner_id, visibility from courses where slug = $1',
        [courseSlug],
      );
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // KNOWN GAP, stated rather than papered over (same style as
      // policy/can.ts's repo:import comment): this reuses course:enrol as
      // the gate for leaving too, since the closed action vocabulary has no
      // separate "un-enrol" action and this route's job is to build routes
      // for the actions that already exist, not add new ones. That means a
      // student enrolled while a course was `open`, which later became
      // `restricted` or was un-published to `hidden`, cannot self-service
      // leave through this route until it (or they) are made eligible again
      // — course:enrol's STUDENT_ENROLLABLE predicate does not know "you
      // already have a row here, so leaving is always fine". Closing that
      // is a policy change (a dedicated course:unenrol action with a SELF-
      // shaped predicate), not a route workaround.
      if (!can(actor, 'course:enrol', { course: policyContext(courseRow) })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      // Soft delete (design §7: user tables are source of truth, nothing
      // under `users` is recoverable) — the enrollment FACT survives as
      // 'withdrawn', never hard-deleted. Re-enrolling (the POST handler
      // above) flips it back to 'active' on the same row.
      await getPool().query(
        `update enrollments set status = 'withdrawn', updated_at = now()
         where user_id = $1 and course_id = $2 and status = 'active'`,
        [actor.id, courseRow.id],
      );

      return reply.code(200).send({ enrolled: false });
    },
  );

  fastify.get<{ Params: { courseSlug: string; lessonSlug: string } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug, lessonSlug } = request.params;

      const courseResult = await getPool().query<{ id: string; owner_id: string | null; visibility: CourseVisibility }>(
        'select id, owner_id, visibility from courses where slug = $1',
        [courseSlug],
      );
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // Same 404-vs-403 line as the course detail route, checked BEFORE the
      // lesson lookup below: a hidden course's lessons must not be
      // discoverable by slug-guessing even when the specific lesson exists.
      if (courseRow.visibility === 'hidden' && !isDiscoverable(can, actor, courseSlug, courseRow)) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      // The whole course's live lessons, in manifest order (module position,
      // then lesson position) — this is what makes prev/next span module
      // boundaries rather than wrapping within one module. Archived lessons
      // and lessons whose module is archived are excluded by the JOIN/WHERE,
      // so an archived lesson is invisible here even when requested by its
      // exact slug.
      const lessonsResult = await getPool().query<CourseLessonRow>(
        `select l.id, l.slug, l.title, l.kind, l.estimate_minutes, t.key as track_key, l.blocks
         from lessons l
         join modules m on m.id = l.module_id
         left join tracks t on t.id = l.track_id
         where l.course_id = $1 and l.archived_at is null and m.archived_at is null
         order by m.position, l.position`,
        [courseRow.id],
      );

      const lessons = lessonsResult.rows;
      const index = lessons.findIndex((l) => l.slug === lessonSlug);
      if (index === -1) {
        return reply.code(404).send({ message: `Lesson not found: ${lessonSlug}` });
      }

      const row = lessons[index]!;
      const prevRow = index > 0 ? lessons[index - 1]! : null;
      const nextRow = index < lessons.length - 1 ? lessons[index + 1]! : null;

      // The actor's own progress on this lesson, so the reader can resume
      // (design §9.1 / Phase 3 progress API). Null if the actor has never
      // interacted with it — no lesson_progress row exists yet.
      const progressResult = await getPool().query<LessonProgressRow>(
        'select state, last_position from lesson_progress where user_id = $1 and lesson_id = $2',
        [actor.id, row.id],
      );
      const progressRow = progressResult.rows[0];
      const progress = progressRow ? { state: progressRow.state, lastPosition: progressRow.last_position } : null;

      const lesson = {
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        track: row.track_key,
        estimateMinutes: row.estimate_minutes,
        blocks: row.blocks,
        prev: prevRow ? { slug: prevRow.slug, title: prevRow.title } : null,
        next: nextRow ? { slug: nextRow.slug, title: nextRow.title } : null,
        progress,
      };

      // Lesson content is course-scoped: the course this lesson belongs to is
      // what visibility and ownership are decided against, so its full
      // context (not just ownerId) is what `can()` is handed. Design §12:
      // "lesson content always requires authentication" — nothing more, so
      // this does NOT check enrollment; an authenticated student reads any
      // lesson in an open/restricted course, or their own course regardless
      // of visibility, exactly like course:read.
      if (!can(actor, 'lesson:read', { slug: row.slug, course: policyContext(courseRow) })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      return reply.code(200).send(lesson);
    },
  );
}
