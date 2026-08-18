import type pg from 'pg';
import { computeStreaks } from '../activity/streaks.ts';
import { DEFAULT_TIMEZONE } from '../time/timezone.ts';
import type { FactKey } from './criteria.ts';
import type { PooledTrack, TrackTally } from './track-score.ts';
import { poolTrackTallies } from './track-score.ts';

// =============================================================================
// THE LEARNER FACTS a criterion is evaluated against.
//
// Criteria evaluation is synchronous, inside the transaction of the progress
// write that triggered it (design §9.3: "so the award animation fires the
// moment you finish, which is the entire point"). That has one consequence
// worth stating up front: every query in this file runs on the CALLER'S
// CLIENT, inside the caller's open transaction, and therefore sees the
// lesson_progress row / quiz attempt / activity event that write just made.
// Passing a pool here instead of the transaction's client would evaluate the
// world as it was BEFORE the event — and the badge would fire one lesson
// late, every time.
//
// Five bundles, one per FactKey. A pass loads only the ones its candidate
// badges declare a need for (criteria.ts's CRITERION_FACTS), so a set of
// badges that are all `streak_days` costs one query, not five.
//
// ARCHIVED CONTENT IS EXCLUDED, EVERYWHERE. A lesson removed from a manifest
// is archived rather than deleted (design §7) and vanishes from the catalog;
// every progress query in this codebase already excludes it (see
// routes/progress.ts), and these do too, so "3 of 5 lessons" means the same
// thing on the dashboard and in a badge. This does mean archiving a lesson
// can move a learner's PROGRESS number. It can never move an AWARD: awards
// live in user_badges and nothing here reads or writes that table.
// =============================================================================

/** One course's completion state for this learner. */
export interface CourseProgressFact {
  courseSlug: string;
  /** Live lessons in the course. Zero means an empty (or fully archived) course. */
  totalLessons: number;
  completedLessons: number;
  /** Of those, the ones whose `kind` is `exercise` (design §9.1: complete on submit). */
  completedExercises: number;
}

/** One quiz the learner has scored 100 % on at least once. */
export interface PerfectQuizFact {
  courseSlug: string;
  lessonSlug: string;
}

export interface LearnerFacts {
  courseProgress: readonly CourseProgressFact[];
  /** Slugs of degrees in `user_degrees` for this learner. */
  degrees: ReadonlySet<string>;
  /** Pooled quiz + rubric result, keyed `courseSlug\ntrack`. */
  trackScores: ReadonlyMap<string, PooledTrack>;
  /** Current streak in the learner's own timezone (design §10, §15). */
  currentStreak: number;
  perfectQuizzes: readonly PerfectQuizFact[];
}

/**
 * All-empty facts.
 *
 * Bundles a pass did not ask for keep these values, which read as "nothing
 * achieved" — so a mis-wired CRITERION_FACTS row produces a badge that does
 * not fire rather than one that fires wrongly. The former is caught by this
 * module's own per-criterion tests; the latter would be an award that cannot
 * be taken back (design §9.3).
 */
export function emptyFacts(): LearnerFacts {
  return {
    courseProgress: [],
    degrees: new Set<string>(),
    trackScores: new Map<string, PooledTrack>(),
    currentStreak: 0,
    perfectQuizzes: [],
  };
}

async function loadCourseProgress(client: pg.PoolClient, userId: string): Promise<CourseProgressFact[]> {
  const { rows } = await client.query<{
    course_slug: string;
    total_lessons: string;
    completed_lessons: string;
    completed_exercises: string;
  }>(
    `select c.slug                                                        as course_slug,
            count(*)                                                      as total_lessons,
            count(*) filter (where lp.state = 'complete')                 as completed_lessons,
            count(*) filter (where lp.state = 'complete'
                               and l.kind = 'exercise')                   as completed_exercises
       from courses c
       join lessons l on l.course_id = c.id
       join modules m on m.id = l.module_id
       left join lesson_progress lp on lp.lesson_id = l.id and lp.user_id = $1
      where l.archived_at is null and m.archived_at is null
      group by c.slug`,
    [userId],
  );

  return rows.map((row) => ({
    courseSlug: row.course_slug,
    totalLessons: Number(row.total_lessons),
    completedLessons: Number(row.completed_lessons),
    completedExercises: Number(row.completed_exercises),
  }));
}

async function loadDegrees(client: pg.PoolClient, userId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ slug: string }>(
    `select d.slug from user_degrees ud join degrees d on d.id = ud.degree_id where ud.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.slug));
}

/**
 * The quiz half of a track score: the LATEST attempt per lesson, expanded
 * out of `quiz_attempts.track_scores` into one (course, track) tally each.
 *
 * `distinct on (lesson_id) ... order by lesson_id, created_at desc, id desc`
 * is what implements track-score.ts's rule 1 (one attempt per lesson, the
 * latest). `id desc` is the tiebreaker for two attempts sharing a
 * `created_at` to the microsecond — without it the choice would be
 * arbitrary, and an arbitrary choice in a scoring query is a number that
 * changes between two identical reads.
 */
async function loadQuizTallies(client: pg.PoolClient, userId: string): Promise<TrackTally[]> {
  const { rows } = await client.query<{ course_slug: string; track: string; earned: string; possible: string }>(
    `with latest as (
       select distinct on (qa.lesson_id) qa.lesson_id, qa.track_scores
         from quiz_attempts qa
        where qa.user_id = $1
        order by qa.lesson_id, qa.created_at desc, qa.id desc
     )
     select c.slug                                          as course_slug,
            ts.key                                          as track,
            sum(coalesce((ts.value ->> 'correct')::numeric, 0)) as earned,
            sum(coalesce((ts.value ->> 'total')::numeric, 0))   as possible
       from latest
       join lessons l on l.id = latest.lesson_id
       join modules m on m.id = l.module_id
       join courses c on c.id = l.course_id
       cross join lateral jsonb_each(latest.track_scores) as ts(key, value)
      where l.archived_at is null and m.archived_at is null
      group by c.slug, ts.key`,
    [userId],
  );

  return rows.map((row) => ({
    courseSlug: row.course_slug,
    track: row.track,
    earned: Number(row.earned),
    possible: Number(row.possible),
  }));
}

/**
 * The rubric half: every scored criterion carrying a track, on a RETURNED
 * submission (track-score.ts's rule 2).
 */
async function loadRubricTallies(client: pg.PoolClient, userId: string): Promise<TrackTally[]> {
  const { rows } = await client.query<{ course_slug: string; track: string; earned: string; possible: string }>(
    `select c.slug        as course_slug,
            rs.track      as track,
            sum(rs.points) as earned,
            sum(rs.max)    as possible
       from rubric_scores rs
       join exercise_submissions es on es.id = rs.submission_id
       join lessons l on l.id = es.lesson_id
       join modules m on m.id = l.module_id
       join courses c on c.id = l.course_id
      where es.user_id = $1
        and es.status = 'returned'
        and rs.track is not null
        and l.archived_at is null and m.archived_at is null
      group by c.slug, rs.track`,
    [userId],
  );

  return rows.map((row) => ({
    courseSlug: row.course_slug,
    track: row.track,
    earned: Number(row.earned),
    possible: Number(row.possible),
  }));
}

/**
 * The current streak, in the learner's own IANA timezone.
 *
 * Phase 3's `computeStreaks` is REUSED verbatim rather than reimplemented in
 * SQL — it is the module that already knows a "day" is a calendar day in the
 * student's zone and not a UTC date (design §15), including the case where
 * the two disagree about which day an event fell on. A second implementation
 * here would be a second answer to that question, and design §10 exists
 * specifically to stop the feed, the heatmap, the streak counter and this
 * badge criterion drifting apart.
 */
async function loadCurrentStreak(client: pg.PoolClient, userId: string): Promise<number> {
  const userResult = await client.query<{ timezone: string | null }>('select timezone from users where id = $1', [
    userId,
  ]);
  const timezone = userResult.rows[0]?.timezone ?? DEFAULT_TIMEZONE;

  const { rows } = await client.query<{ occurred_at: Date }>(
    'select occurred_at from activity_events where user_id = $1 order by occurred_at asc',
    [userId],
  );

  return computeStreaks(
    rows.map((r) => ({ occurredAt: r.occurred_at })),
    timezone,
  ).current;
}

/**
 * Quizzes scored 100 %, as DISTINCT LESSONS rather than as attempt rows.
 *
 * Design §9.1 allows retakes, so counting attempts would let one quiz sat
 * five times satisfy `{type: perfect_quiz, count: 5}` — a badge for
 * persistence rather than for the five different perfect quizzes it names.
 * A lesson counts once, the first time it is aced, and keeps counting
 * afterwards no matter what later attempts score: `perfect_quiz` asks
 * whether it was ever done perfectly.
 */
async function loadPerfectQuizzes(client: pg.PoolClient, userId: string): Promise<PerfectQuizFact[]> {
  const { rows } = await client.query<{ course_slug: string; lesson_slug: string }>(
    `select distinct c.slug as course_slug, l.slug as lesson_slug
       from quiz_attempts qa
       join lessons l on l.id = qa.lesson_id
       join modules m on m.id = l.module_id
       join courses c on c.id = l.course_id
      where qa.user_id = $1
        and qa.score = 1
        and l.archived_at is null and m.archived_at is null`,
    [userId],
  );

  return rows.map((row) => ({ courseSlug: row.course_slug, lessonSlug: row.lesson_slug }));
}

/**
 * Loads exactly the bundles in `needed`, on `client` — which must be the
 * transaction that just wrote the progress being evaluated. See the header.
 */
export async function loadFacts(
  client: pg.PoolClient,
  userId: string,
  needed: ReadonlySet<FactKey>,
): Promise<LearnerFacts> {
  const facts = emptyFacts();

  const [courseProgress, degrees, quizTallies, rubricTallies, currentStreak, perfectQuizzes] = await Promise.all([
    needed.has('courseProgress') ? loadCourseProgress(client, userId) : Promise.resolve(null),
    needed.has('degrees') ? loadDegrees(client, userId) : Promise.resolve(null),
    needed.has('trackScores') ? loadQuizTallies(client, userId) : Promise.resolve(null),
    needed.has('trackScores') ? loadRubricTallies(client, userId) : Promise.resolve(null),
    needed.has('streak') ? loadCurrentStreak(client, userId) : Promise.resolve(null),
    needed.has('perfectQuizzes') ? loadPerfectQuizzes(client, userId) : Promise.resolve(null),
  ]);

  return {
    ...facts,
    courseProgress: courseProgress ?? facts.courseProgress,
    degrees: degrees ?? facts.degrees,
    trackScores:
      quizTallies !== null || rubricTallies !== null
        ? poolTrackTallies(quizTallies ?? [], rubricTallies ?? [])
        : facts.trackScores,
    currentStreak: currentStreak ?? facts.currentStreak,
    perfectQuizzes: perfectQuizzes ?? facts.perfectQuizzes,
  };
}
