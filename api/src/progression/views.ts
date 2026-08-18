import type pg from 'pg';
import type { Criterion } from './criteria.ts';
import { factsNeededFor, parseCriterion } from './criteria.ts';
import type { CriterionProgress } from './evaluate.ts';
import { evaluateCriterion } from './evaluate.ts';
import type { DegreeDefinition, DegreeProgressView } from './degrees.ts';
import { computeDegreeProgress } from './degrees.ts';
import { completedCoursesOf, loadFacts } from './facts.ts';

// =============================================================================
// THE READ SIDE of progression: what /api/v1/me/badges and /api/v1/me/degrees
// return.
//
// Locked badges are returned alongside earned ones rather than hidden — a
// badge nobody can see is not a goal (design §9.3) — and each carries the same
// scalar progress pair the evaluator used to decide it, so the progress bar
// and the award can never disagree.
//
// `earned` ALWAYS comes from `user_badges` / `user_degrees` and is never
// recomputed from criteria. Design §9.3: an award is a fact about a moment,
// so a badge may legitimately read `earned: true` with `progress.current`
// below `progress.target` after a course was edited, a lesson archived, or a
// threshold retuned. That combination is a correct answer here, not a bug.
// =============================================================================

/** One badge as a learner sees it. Mirrors the OpenAPI `BadgeProgress`. */
export interface BadgeProgressView {
  slug: string;
  title: string;
  description: string | null;
  courseSlug: string | null;
  criteria: Criterion;
  earned: boolean;
  awardedAt: string | null;
  progress: CriterionProgress;
}

interface BadgeViewRow {
  slug: string;
  title: string;
  description: string | null;
  course_slug: string | null;
  criteria: unknown;
  awarded_at: Date | null;
}

interface DegreeViewRow {
  slug: string;
  title: string;
  description: string | null;
  required_slugs: string[];
  electives_choose: number;
  electives_from: string[];
  awarded_at: Date | null;
}

/**
 * Every badge, with this learner's progress toward it.
 *
 * A badge whose `criteria` cannot be parsed is OMITTED rather than rendered
 * with a nonsense progress bar — same reasoning as criteria.ts's
 * `parseCriterion` returning null: an unearnable badge is a visible bug in
 * the admin screen (which lists every row, parseable or not), and showing it
 * to a learner as a goal they can never reach is worse than not showing it.
 */
export async function listBadgeProgress(client: pg.PoolClient, userId: string): Promise<BadgeProgressView[]> {
  const { rows } = await client.query<BadgeViewRow>(
    `select b.slug, b.title, b.description, c.slug as course_slug, b.criteria, ub.awarded_at
       from badges b
       left join courses c on c.id = b.course_id
       left join user_badges ub on ub.badge_id = b.id and ub.user_id = $1
      order by b.title`,
    [userId],
  );

  const parsed = rows.flatMap((row) => {
    const criterion = parseCriterion(row.criteria);
    return criterion === null ? [] : [{ row, criterion }];
  });
  if (parsed.length === 0) return [];

  const facts = await loadFacts(client, userId, factsNeededFor(parsed.map((p) => p.criterion)));

  const views = parsed.map(({ row, criterion }) => {
    // `satisfied` is deliberately dropped: it answers "would this be awarded
    // now", which is NOT what a learner is told. `earned` below comes from
    // `user_badges` and nothing else (design §9.3).
    const evaluation = evaluateCriterion(criterion, facts);
    const progress: CriterionProgress = {
      current: evaluation.current,
      target: evaluation.target,
      percent: evaluation.percent,
      unit: evaluation.unit,
    };
    return {
      slug: row.slug,
      title: row.title,
      description: row.description,
      courseSlug: row.course_slug,
      criteria: criterion,
      earned: row.awarded_at !== null,
      awardedAt: row.awarded_at === null ? null : row.awarded_at.toISOString(),
      progress,
    };
  });

  // Earned first (most recent first), then locked by how close they are —
  // which is the order the dashboard renders in, decided here so the client
  // never has to know what "close" means.
  return views.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    if (a.earned && b.earned) return (b.awardedAt ?? '').localeCompare(a.awardedAt ?? '');
    if (a.progress.percent !== b.progress.percent) return b.progress.percent - a.progress.percent;
    return a.title.localeCompare(b.title);
  });
}

/** Every course this instance has imported: slug -> title. */
async function loadImportedCourses(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ slug: string; title: string }>('select slug, title from courses');
  return new Map(rows.map((r) => [r.slug, r.title]));
}

/** Every degree, with this learner's progress toward it (design §9.2). */
export async function listDegreeProgress(client: pg.PoolClient, userId: string): Promise<DegreeProgressView[]> {
  const { rows } = await client.query<DegreeViewRow>(
    `select d.slug, d.title, d.description, d.required_slugs, d.electives_choose, d.electives_from,
            ud.awarded_at
       from degrees d
       left join user_degrees ud on ud.degree_id = d.id and ud.user_id = $1
      order by d.title`,
    [userId],
  );
  if (rows.length === 0) return [];

  const facts = await loadFacts(client, userId, new Set(['courseProgress']));
  const completedCourses = completedCoursesOf(facts);
  const importedCourses = await loadImportedCourses(client);

  return rows.map((row) => {
    const definition: DegreeDefinition = {
      slug: row.slug,
      title: row.title,
      description: row.description,
      requiredSlugs: row.required_slugs,
      electivesChoose: row.electives_choose,
      electivesFrom: row.electives_from,
    };
    return computeDegreeProgress(definition, {
      importedCourses,
      completedCourses,
      awardedAt: row.awarded_at,
    });
  });
}
