import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';

export interface CourseRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as lessons.ts
  // used in Phase 1: defaults to the real `can`; tests override it to
  // exercise the 403 path and to spy on calls without needing `can()` to
  // ever actually return false in Phase 2.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface CourseSummaryRow {
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tags: string[];
  module_count: number;
  lesson_count: number;
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tags: string[];
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

/** Registers the course + course-scoped-lesson routes on `fastify`. */
export function registerCourseRoutes(fastify: FastifyInstance, deps: CourseRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.get('/api/v1/courses', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    const result = await getPool().query<CourseSummaryRow>(`
      select
        c.slug, c.title, c.subtitle, c.description, c.tags,
        (select count(*) from modules m where m.course_id = c.id and m.archived_at is null)::int as module_count,
        (select count(*) from lessons l where l.course_id = c.id and l.archived_at is null)::int as lesson_count
      from courses c
      order by c.title
    `);

    const summaries = result.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      tags: row.tags,
      moduleCount: row.module_count,
      lessonCount: row.lesson_count,
    }));

    // The seam: resolve actor, then ask before returning content. Phase 2
    // `can()` always returns true; the check still runs on every request so
    // Phase 6 can tighten the rule without touching this handler. A list
    // response has no single natural resource, so `resource` is omitted.
    if (!can(actor, 'course:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    return reply.code(200).send(summaries);
  });

  fastify.get<{ Params: { courseSlug: string } }>('/api/v1/courses/:courseSlug', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    const { courseSlug } = request.params;

    const courseResult = await getPool().query<CourseRow>(
      'select id, slug, title, subtitle, description, tags from courses where slug = $1',
      [courseSlug],
    );
    const courseRow = courseResult.rows[0];
    if (!courseRow) {
      return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
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

    const course = {
      slug: courseRow.slug,
      title: courseRow.title,
      subtitle: courseRow.subtitle,
      description: courseRow.description,
      tags: courseRow.tags,
      tracks,
      modules,
    };

    if (!can(actor, 'course:read', course)) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    return reply.code(200).send(course);
  });

  fastify.get<{ Params: { courseSlug: string; lessonSlug: string } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug, lessonSlug } = request.params;

      const courseResult = await getPool().query<{ id: string }>('select id from courses where slug = $1', [
        courseSlug,
      ]);
      const courseRow = courseResult.rows[0];
      if (!courseRow) {
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

      if (!can(actor, 'lesson:read', lesson)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      return reply.code(200).send(lesson);
    },
  );
}
