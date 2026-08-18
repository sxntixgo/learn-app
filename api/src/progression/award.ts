import type pg from 'pg';
import type { Criterion, Trigger } from './criteria.ts';
import { factsNeededFor, parseCriterion, triggerAffects } from './criteria.ts';
import { evaluateCriterion } from './evaluate.ts';
import type { DegreeDefinition } from './degrees.ts';
import { degreeSatisfied } from './degrees.ts';
import { completedCoursesOf, loadFacts } from './facts.ts';

// =============================================================================
// AWARDING (design §9.3).
//
//   "Evaluation is synchronous on every progress write, filtered to criteria
//    types the event could affect — so the award animation fires the moment
//    you finish, which is the entire point."
//
// This is the only module that writes `user_badges` / `user_degrees`, and it
// runs INSIDE the caller's open transaction, on the caller's client. Two
// consequences, both deliberate:
//
//   1. Facts are read after the progress write, so the lesson that just
//      completed counts. Passing a pool here would evaluate the world as it
//      was BEFORE the event and every badge would fire one write late.
//   2. An award rolls back with the progress that earned it. There is no
//      state in which a badge exists for a lesson that was never recorded.
//
// THE CONCURRENCY GUARANTEE is a single statement, not a lock:
//
//     insert into user_badges (user_id, badge_id) values ($1, $2)
//     on conflict (user_id, badge_id) do nothing
//     returning awarded_at
//
// Two simultaneous completions genuinely race here — that is what
// "synchronous on every progress write" means — and exactly one of the two
// statements returns a row. Only that one emits the `badge_awarded` activity
// event and only that one reports the award to its caller, so the animation
// fires once and the append-only feed says once. A read-then-write ("select,
// and if absent insert") has a window between its two statements and would
// double-award; there is deliberately no such code path here. Same lesson,
// same shape, as Phase 6's single-row bootstrap claim.
//
// The `not exists` filter in the candidate queries below is an OPTIMISATION
// ONLY — it keeps a learner with forty badges from re-evaluating forty
// criteria on every lesson. It is not the guarantee, and it is allowed to be
// wrong under a race precisely because the unique constraint is the one that
// is not.
// =============================================================================

/** A badge (or degree) awarded by the request being answered. Mirrors the OpenAPI `AwardedBadge`. */
export interface Award {
  slug: string;
  title: string;
  description: string | null;
  awardedAt: string;
}

/**
 * What THIS request earned — never what the actor already held (OpenAPI
 * `AwardNotice`). Empty on the overwhelming majority of writes, and empty on
 * a repeat of a request that already awarded, so a client may treat a
 * non-empty array as "animate this now" without tracking what it has shown.
 */
export interface AwardNotice {
  badges: Award[];
  degrees: Award[];
}

/** The notice for a write that could not have earned anything. */
export function noAwards(): AwardNotice {
  return { badges: [], degrees: [] };
}

interface CandidateBadge {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  criterion: Criterion;
}

interface CandidateDegree extends DegreeDefinition {
  id: string;
}

interface BadgeRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  criteria: unknown;
}

/**
 * The badges this trigger could newly award: not already held, with a
 * criterion this event could have moved.
 *
 * An unparseable `criteria` row is dropped rather than thrown on
 * (criteria.ts's parseCriterion returns null): this code runs inside every
 * progress write, so one malformed row must not become a 500 on every lesson
 * anybody completes.
 */
async function loadCandidateBadges(
  client: pg.PoolClient,
  userId: string,
  trigger: Trigger,
): Promise<CandidateBadge[]> {
  const { rows } = await client.query<BadgeRow>(
    `select b.id, b.slug, b.title, b.description, b.criteria
       from badges b
      where not exists (
              select 1 from user_badges ub where ub.badge_id = b.id and ub.user_id = $1
            )`,
    [userId],
  );

  const candidates: CandidateBadge[] = [];
  for (const row of rows) {
    const criterion = parseCriterion(row.criteria);
    if (criterion === null) continue;
    if (!triggerAffects(trigger, criterion.type)) continue;
    candidates.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      criterion,
    });
  }
  return candidates;
}

interface DegreeRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  required_slugs: string[];
  electives_choose: number;
  electives_from: string[];
}

async function loadCandidateDegrees(client: pg.PoolClient, userId: string): Promise<CandidateDegree[]> {
  const { rows } = await client.query<DegreeRow>(
    `select d.id, d.slug, d.title, d.description, d.required_slugs, d.electives_choose, d.electives_from
       from degrees d
      where not exists (
              select 1 from user_degrees ud where ud.degree_id = d.id and ud.user_id = $1
            )`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    requiredSlugs: row.required_slugs,
    electivesChoose: row.electives_choose,
    electivesFrom: row.electives_from,
  }));
}

/**
 * Awards one degree if the insert wins the race, and appends its activity
 * event. Returns null when somebody (or some other request) got there first.
 */
async function awardDegree(client: pg.PoolClient, userId: string, degree: CandidateDegree): Promise<Award | null> {
  const { rows } = await client.query<{ awarded_at: Date }>(
    `insert into user_degrees (user_id, degree_id) values ($1, $2)
     on conflict (user_id, degree_id) do nothing
     returning awarded_at`,
    [userId, degree.id],
  );
  const row = rows[0];
  if (row === undefined) return null;

  await client.query(
    `insert into activity_events (user_id, type, degree_id, meta)
     values ($1, 'degree_earned', $2, $3::jsonb)`,
    [userId, degree.id, JSON.stringify({ slug: degree.slug, title: degree.title })],
  );

  return {
    slug: degree.slug,
    title: degree.title,
    description: degree.description,
    awardedAt: row.awarded_at.toISOString(),
  };
}

async function awardBadge(client: pg.PoolClient, userId: string, badge: CandidateBadge): Promise<Award | null> {
  const { rows } = await client.query<{ awarded_at: Date }>(
    `insert into user_badges (user_id, badge_id) values ($1, $2)
     on conflict (user_id, badge_id) do nothing
     returning awarded_at`,
    [userId, badge.id],
  );
  const row = rows[0];
  if (row === undefined) return null;

  await client.query(
    `insert into activity_events (user_id, type, badge_id, meta)
     values ($1, 'badge_awarded', $2, $3::jsonb)`,
    [userId, badge.id, JSON.stringify({ slug: badge.slug, title: badge.title })],
  );

  return {
    slug: badge.slug,
    title: badge.title,
    description: badge.description,
    awardedAt: row.awarded_at.toISOString(),
  };
}

/**
 * Evaluates and awards everything `trigger` could have earned `userId`,
 * inside the caller's transaction.
 *
 * DEGREES ARE AWARDED FIRST, BADGES SECOND, and the order is load-bearing: a
 * `degree_earned` badge reads `user_degrees`, so a degree finished by this
 * very write has to be in the table before badge facts are loaded. Awarding
 * badges first would make such a badge fire one write late — the exact
 * "fires the moment you finish" failure design §9.3 is about. The two fact
 * loads that follow from this are why they are two calls and not one.
 *
 * `trigger` decides which criterion types are even considered
 * (criteria.ts's TRIGGER_AFFECTS) and, through them, which fact bundles are
 * queried — so a write that could not have moved anything costs one cheap
 * candidate query and nothing else.
 */
export async function evaluateAndAward(
  client: pg.PoolClient,
  userId: string,
  trigger: Trigger,
): Promise<AwardNotice> {
  const notice = noAwards();

  // Degrees are gated on the same table the badges are: `degree_earned` is
  // in a trigger's row exactly when that event could finish a course, which
  // is exactly when it could finish a degree. One vocabulary, not two.
  if (triggerAffects(trigger, 'degree_earned')) {
    const degrees = await loadCandidateDegrees(client, userId);
    if (degrees.length > 0) {
      const facts = await loadFacts(client, userId, new Set(['courseProgress']));
      const completed = completedCoursesOf(facts);
      for (const degree of degrees) {
        if (!degreeSatisfied(degree, completed)) continue;
        const award = await awardDegree(client, userId, degree);
        if (award !== null) notice.degrees.push(award);
      }
    }
  }

  const badges = await loadCandidateBadges(client, userId, trigger);
  if (badges.length === 0) return notice;

  const facts = await loadFacts(
    client,
    userId,
    factsNeededFor(badges.map((b) => b.criterion)),
  );

  for (const badge of badges) {
    if (!evaluateCriterion(badge.criterion, facts).satisfied) continue;
    const award = await awardBadge(client, userId, badge);
    if (award !== null) notice.badges.push(award);
  }

  return notice;
}
