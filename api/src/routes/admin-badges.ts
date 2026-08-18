import type { FastifyInstance } from 'fastify';
import { stringify as stringifyYaml } from 'yaml';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { actorWithFreshRoles } from '../auth/roles.ts';
import { validateBadge, validateBadgeCriteria } from '../content/validate.ts';
import { computeDegreeProgress } from '../progression/degrees.ts';
import type { DegreeDefinition } from '../progression/degrees.ts';

// =============================================================================
// ADMIN BADGE CRUD AND EXPORT (design §9.3), plus the admin degree list
// (§6.1).
//
// THE TWO SOURCES ARE THE WHOLE SHAPE OF THIS MODULE. Git-sourced badges are
// derived state, rewritten by the next sync of their repo; admin-sourced ones
// are source of truth. So:
//
//   * A git badge is READ-ONLY here (409 on PATCH and on DELETE). Editing one
//     would be silently undone by the next import, which is worse than being
//     told no — the operator would believe a threshold had changed.
//   * The importer refuses the mirror image, an admin badge with a slug a
//     manifest claims (content/import.ts's upsertBadges). Between the two,
//     neither source can quietly overwrite the other.
//   * EXPORT is the bridge design §9.3 asks for: "an admin action exports a
//     badge to YAML so a threshold tuned against real data can be promoted
//     into git." It works on both sources — exporting a git badge is how you
//     diff what the instance has against what the repo says.
//
// DELETING is refused for any badge somebody has earned, and that refusal is
// the DATABASE's (`user_badges.badge_id` is `on delete restrict`, migration
// 0013). The pre-check below turns it into a 409 with a count in the message;
// if the pre-check ever raced, the constraint still refuses. Design §9.3:
// badges are never revoked, and deleting a definition must not become a way
// to do it.
// =============================================================================

export interface AdminBadgeRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as every other
  // route module.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface BadgeRow {
  slug: string;
  title: string;
  description: string | null;
  source: string;
  course_slug: string | null;
  criteria: unknown;
  award_count: number;
  created_at: Date;
  updated_at: Date;
}

const BADGE_SELECT = `
  select b.slug, b.title, b.description, b.source, c.slug as course_slug, b.criteria,
         (select count(*)::int from user_badges ub where ub.badge_id = b.id) as award_count,
         b.created_at, b.updated_at
    from badges b
    left join courses c on c.id = b.course_id`;

function serializeBadge(row: BadgeRow): unknown {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    source: row.source,
    courseSlug: row.course_slug,
    criteria: row.criteria,
    awardCount: row.award_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The one place a validation failure becomes a 400 body, so every write path words it the same. */
function badRequest(prefix: string, errors: Array<{ path: string; message: string }>): { message: string } {
  return { message: `${prefix}: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}` };
}

/**
 * A badge as a `course.yaml` `badges:` list item (design §9.3's export).
 *
 * Key order is the schema's own reading order rather than insertion-random,
 * and the result is validated against schemas/badge.schema.json before it
 * goes out: an export that does not validate is an export that would fail on
 * the next import of the repo it was pasted into, and the operator would only
 * find out then.
 */
function badgeToYaml(row: BadgeRow): { yaml: string } | { error: string } {
  const item: Record<string, unknown> = {
    slug: row.slug,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.course_slug === null ? {} : { course: row.course_slug }),
    criteria: row.criteria,
  };

  const result = validateBadge(item);
  if (!result.valid) {
    return {
      error:
        `Badge "${row.slug}" does not validate against schemas/badge.schema.json and cannot be exported: ` +
        result.errors.map((e) => `${e.path} ${e.message}`).join('; '),
    };
  }

  // A LIST of one, INDENTED TWO SPACES, so the output pastes straight under
  // a `badges:` key — the fragment design §9.3 describes, not a document the
  // operator has to re-indent by hand. Two spaces is not cosmetic: every
  // manifest in this repo (and design §6.1's own examples) indents sequence
  // items under a key, and a list whose items disagree about indentation is
  // a YAML parse error, so an unindented fragment pasted into a manifest
  // that already has one badge would not load at all.
  const indented = stringifyYaml([item])
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
  return { yaml: indented };
}

interface DegreeRow {
  slug: string;
  title: string;
  description: string | null;
  repo_url: string | null;
  required_slugs: string[];
  electives_choose: number;
  electives_from: string[];
  award_count: number;
}

/** Registers the admin badge CRUD/export and degree list routes (design §9.2, §9.3). */
export function registerAdminBadgeRoutes(fastify: FastifyInstance, deps: AdminBadgeRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  /**
   * Privileged mutations re-read roles from the database before asking
   * `can()` (design §13, the same rule POST /api/v1/admin/imports follows):
   * an admin demoted two minutes ago must not get one last badge edit in on
   * a still-valid 15-minute token.
   */
  async function mutatingActor(request: Parameters<typeof actorFor>[0]): Promise<Actor> {
    return actorWithFreshRoles(getPool(), actorFor(request, deps));
  }

  fastify.get('/api/v1/admin/badges', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'badge:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { rows } = await getPool().query<BadgeRow>(`${BADGE_SELECT} order by b.title`);
    return reply.code(200).send(rows.map(serializeBadge));
  });

  fastify.post<{ Body: { slug?: unknown; title?: unknown; description?: unknown; course?: unknown; criteria?: unknown } }>(
    '/api/v1/admin/badges',
    async (request, reply) => {
      const actor = await mutatingActor(request);
      if (!can(actor, 'badge:global:define')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const body = request.body ?? {};
      // Validated as a WHOLE badge, against the same schema the importer
      // uses — so slug shape, title, and the closed criteria vocabulary are
      // one check with one wording, not three hand-rolled ones.
      const candidate = {
        slug: body.slug,
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.course === undefined ? {} : { course: body.course }),
        criteria: body.criteria,
      };
      const result = validateBadge(candidate);
      if (!result.valid) {
        return reply.code(400).send(badRequest('Invalid badge', result.errors));
      }
      const badge = candidate as { slug: string; title: string; description?: string; course?: string; criteria: unknown };

      // Design §9.3: slugs are globally unique ACROSS BOTH SOURCES, so a
      // collision with a git badge is a 409 here just as an admin badge is a
      // refusal there.
      const existing = await getPool().query('select 1 from badges where slug = $1', [badge.slug]);
      if ((existing.rowCount ?? 0) > 0) {
        return reply.code(409).send({ message: `A badge with slug "${badge.slug}" already exists.` });
      }

      // A course scope naming a course this instance has not imported is a
      // 400 here, unlike in the importer: an admin typing a slug into a form
      // has made a mistake, where a manifest naming another repo's course
      // has not (design §8's cross-repo rule is about IMPORTS).
      let courseId: string | null = null;
      if (badge.course !== undefined) {
        const course = await getPool().query<{ id: string }>('select id from courses where slug = $1', [badge.course]);
        courseId = course.rows[0]?.id ?? null;
        if (courseId === null) {
          return reply.code(400).send({ message: `No course with slug "${badge.course}" on this instance.` });
        }
      }

      const { rows } = await getPool().query<{ slug: string }>(
        `insert into badges (slug, title, description, source, course_id, criteria, created_by)
         values ($1, $2, $3, 'admin', $4, $5::jsonb, $6)
         returning slug`,
        [badge.slug, badge.title, badge.description ?? null, courseId, JSON.stringify(badge.criteria), actor.id],
      );

      const created = await getPool().query<BadgeRow>(`${BADGE_SELECT} where b.slug = $1`, [rows[0]!.slug]);
      return reply.code(201).send(serializeBadge(created.rows[0]!));
    },
  );

  fastify.patch<{
    Params: { badgeSlug: string };
    Body: { title?: unknown; description?: unknown; course?: unknown; criteria?: unknown };
  }>('/api/v1/admin/badges/:badgeSlug', async (request, reply) => {
    const actor = await mutatingActor(request);
    if (!can(actor, 'badge:update')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { badgeSlug } = request.params;
    const body = request.body ?? {};

    const existing = await getPool().query<{ id: string; source: string }>(
      'select id, source from badges where slug = $1',
      [badgeSlug],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return reply.code(404).send({ message: `Badge not found: ${badgeSlug}` });
    }
    if (row.source === 'git') {
      return reply.code(409).send({
        message:
          `Badge "${badgeSlug}" is git-sourced and read-only here: the next sync of its repo would silently ` +
          `undo any edit. Change it in the curriculum repo, or export this badge to YAML and promote the ` +
          `change there.`,
      });
    }

    if (body.criteria !== undefined) {
      const result = validateBadgeCriteria(body.criteria);
      if (!result.valid) {
        return reply.code(400).send(badRequest('Invalid criteria', result.errors));
      }
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
      return reply.code(400).send({ message: 'title must be a non-empty string.' });
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return reply.code(400).send({ message: 'description must be a string or null.' });
    }

    // `course: null` unscopes the badge; omitting `course` leaves the scope
    // alone. The two are different requests and must not collapse.
    let courseId: string | null = null;
    if (body.course !== undefined && body.course !== null) {
      if (typeof body.course !== 'string') {
        return reply.code(400).send({ message: 'course must be a course slug or null.' });
      }
      const course = await getPool().query<{ id: string }>('select id from courses where slug = $1', [body.course]);
      courseId = course.rows[0]?.id ?? null;
      if (courseId === null) {
        return reply.code(400).send({ message: `No course with slug "${body.course}" on this instance.` });
      }
    }

    // COALESCE per column, so a partial body edits only what it names. Note
    // what is NOT here: nothing touches `user_badges`. Design §9.3 — editing
    // criteria changes who will earn this badge next, never who has earned
    // it.
    await getPool().query(
      `update badges
          set title = coalesce($2, title),
              description = case when $3::boolean then $4 else description end,
              course_id = case when $5::boolean then $6 else course_id end,
              criteria = coalesce($7::jsonb, criteria),
              updated_at = now()
        where id = $1`,
      [
        row.id,
        body.title === undefined ? null : (body.title as string),
        body.description !== undefined,
        body.description === undefined || body.description === null ? null : (body.description as string),
        body.course !== undefined,
        courseId,
        body.criteria === undefined ? null : JSON.stringify(body.criteria),
      ],
    );

    const updated = await getPool().query<BadgeRow>(`${BADGE_SELECT} where b.slug = $1`, [badgeSlug]);
    return reply.code(200).send(serializeBadge(updated.rows[0]!));
  });

  fastify.delete<{ Params: { badgeSlug: string } }>('/api/v1/admin/badges/:badgeSlug', async (request, reply) => {
    const actor = await mutatingActor(request);
    if (!can(actor, 'badge:delete')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { badgeSlug } = request.params;
    const existing = await getPool().query<{ id: string; source: string; award_count: number }>(
      `select b.id, b.source,
              (select count(*)::int from user_badges ub where ub.badge_id = b.id) as award_count
         from badges b where b.slug = $1`,
      [badgeSlug],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return reply.code(404).send({ message: `Badge not found: ${badgeSlug}` });
    }
    if (row.source === 'git') {
      return reply.code(409).send({
        message: `Badge "${badgeSlug}" is git-sourced: remove it from the curriculum repo and re-sync instead.`,
      });
    }
    if (row.award_count > 0) {
      return reply.code(409).send({
        message:
          `Badge "${badgeSlug}" has been earned by ${row.award_count} ` +
          `${row.award_count === 1 ? 'person' : 'people'} and cannot be deleted — deleting a definition would ` +
          `revoke every award of it, and badges are never revoked (design §9.3).`,
      });
    }

    await getPool().query('delete from badges where id = $1', [row.id]);
    return reply.code(204).send();
  });

  fastify.get<{ Params: { badgeSlug: string } }>(
    '/api/v1/admin/badges/:badgeSlug/export',
    async (request, reply) => {
      const actor = actorFor(request, deps);
      if (!can(actor, 'badge:export')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const { badgeSlug } = request.params;
      const { rows } = await getPool().query<BadgeRow>(`${BADGE_SELECT} where b.slug = $1`, [badgeSlug]);
      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({ message: `Badge not found: ${badgeSlug}` });
      }

      const exported = badgeToYaml(row);
      if ('error' in exported) {
        return reply.code(422).send({ message: exported.error });
      }

      return reply.code(200).type('application/yaml').send(exported.yaml);
    },
  );

  // ---------------------------------------------------------------------------
  // Design §6.1: "a degree whose requirements are not all imported shows as
  // UNSATISFIABLE IN ADMIN rather than appearing broken to students." This is
  // that screen's data. `computeDegreeProgress` is reused with an EMPTY set of
  // completed courses — the admin question is about the instance, not about
  // one learner, and `satisfiable`/`missingCourses` do not depend on progress.
  // ---------------------------------------------------------------------------
  fastify.get('/api/v1/admin/degrees', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'degree:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { rows } = await getPool().query<DegreeRow>(
      `select d.slug, d.title, d.description, r.url as repo_url,
              d.required_slugs, d.electives_choose, d.electives_from,
              (select count(*)::int from user_degrees ud where ud.degree_id = d.id) as award_count
         from degrees d
         left join content_repos r on r.id = d.repo_id
        order by d.title`,
    );

    const courses = await getPool().query<{ slug: string; title: string }>('select slug, title from courses');
    const importedCourses = new Map(courses.rows.map((c) => [c.slug, c.title]));

    const degrees = rows.map((row) => {
      const definition: DegreeDefinition = {
        slug: row.slug,
        title: row.title,
        description: row.description,
        requiredSlugs: row.required_slugs,
        electivesChoose: row.electives_choose,
        electivesFrom: row.electives_from,
      };
      const view = computeDegreeProgress(definition, {
        importedCourses,
        completedCourses: new Set<string>(),
        awardedAt: null,
      });

      return {
        slug: row.slug,
        title: row.title,
        description: row.description,
        repoUrl: row.repo_url,
        required: row.required_slugs,
        electives:
          row.electives_choose > 0 || row.electives_from.length > 0
            ? { choose: row.electives_choose, from: row.electives_from }
            : null,
        satisfiable: view.satisfiable,
        missingCourses: view.missingCourses,
        awardCount: row.award_count,
      };
    });

    return reply.code(200).send(degrees);
  });
}
