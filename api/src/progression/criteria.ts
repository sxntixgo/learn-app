// =============================================================================
// THE CLOSED CRITERIA VOCABULARY (design §9.3).
//
//   "Criteria vocabulary is closed and declarative — this is what prevents
//    badges becoming a scripting language: lessons_completed ·
//    exercises_passed · course_completed · courses_completed · degree_earned ·
//    track_score · streak_days · perfect_quiz. ADDING A NINTH TYPE IS A
//    DELIBERATE PLATFORM CHANGE."
//
// This module is one of the three places that sentence is enforced, and the
// only one that is TypeScript:
//
//   1. schemas/badge.schema.json — the wire contract. Eight `oneOf` branches,
//      `additionalProperties: false` on each, so a misspelt field is a
//      validation error rather than a silently ignored one. Every write path
//      (importer, admin CRUD) runs through it.
//   2. THIS FILE — the runtime union, plus what each type needs to know and
//      which events can move it.
//   3. api/src/progression/evaluate.ts — the per-type evaluator. Its
//      `EVALUATORS` map is typed `Record<CriterionType, ...>`, so a ninth type
//      added here without an evaluator is a COMPILE ERROR, not a badge that
//      silently never fires.
//
// A ninth type therefore costs edits to a JSON Schema, a union, a fact-needs
// table, a trigger table and an evaluator — which is exactly the friction
// design §9.3 is asking for. It cannot be added by writing a row in a table.
// =============================================================================

import { validateBadgeCriteria } from '../content/validate.ts';

export type CriterionType =
  | 'lessons_completed'
  | 'exercises_passed'
  | 'course_completed'
  | 'courses_completed'
  | 'degree_earned'
  | 'track_score'
  | 'streak_days'
  | 'perfect_quiz';

/** N lessons completed, optionally within one course. */
export interface LessonsCompletedCriterion {
  type: 'lessons_completed';
  count: number;
  course?: string;
}

/** N exercise lessons completed. Design §9.1: an exercise completes on SUBMIT. */
export interface ExercisesPassedCriterion {
  type: 'exercises_passed';
  count: number;
  course?: string;
}

/** One named course complete — every live, non-archived lesson in it. */
export interface CourseCompletedCriterion {
  type: 'course_completed';
  course: string;
}

/** Any N courses complete. */
export interface CoursesCompletedCriterion {
  type: 'courses_completed';
  count: number;
}

/** One named degree awarded (design §9.2). */
export interface DegreeEarnedCriterion {
  type: 'degree_earned';
  degree: string;
}

/** A percentage across one track, pooling quiz answers and rubric points. */
export interface TrackScoreCriterion {
  type: 'track_score';
  track: string;
  course?: string;
  min: number;
}

/** A run of consecutive active days in the student's own timezone. */
export interface StreakDaysCriterion {
  type: 'streak_days';
  days: number;
}

/** N quizzes scored 100 %, optionally within one course or on one lesson. */
export interface PerfectQuizCriterion {
  type: 'perfect_quiz';
  count?: number;
  course?: string;
  lesson?: string;
}

export type Criterion =
  | LessonsCompletedCriterion
  | ExercisesPassedCriterion
  | CourseCompletedCriterion
  | CoursesCompletedCriterion
  | DegreeEarnedCriterion
  | TrackScoreCriterion
  | StreakDaysCriterion
  | PerfectQuizCriterion;

/**
 * The vocabulary as data. Typed as `readonly CriterionType[]` and built from
 * a literal, so removing a type from the union without removing it here is a
 * compile error and vice versa.
 */
export const CRITERION_TYPES: readonly CriterionType[] = Object.freeze([
  'lessons_completed',
  'exercises_passed',
  'course_completed',
  'courses_completed',
  'degree_earned',
  'track_score',
  'streak_days',
  'perfect_quiz',
] as const);

/**
 * Parses a `badges.criteria` jsonb value into the union, or null if it is not
 * a valid criterion.
 *
 * NULL RATHER THAN THROW, deliberately. Every write path validates against
 * schemas/badge.schema.json first, so an invalid row should be unreachable —
 * but criteria evaluation runs INSIDE the transaction of every progress
 * write (design §9.3), and a throw here would turn one malformed row, from a
 * hand-edited database or a future migration, into a 500 on every lesson
 * anybody completes. An unparseable criterion is simply never satisfied:
 * a badge that cannot fire is a visible bug; a platform that cannot record
 * progress is an outage.
 */
export function parseCriterion(value: unknown): Criterion | null {
  const result = validateBadgeCriteria(value);
  return result.valid ? (value as Criterion) : null;
}

// -----------------------------------------------------------------------------
// What each type needs to know.
//
// The evaluator loads facts from Postgres. Loading all of them on every
// progress write would be five queries per completed lesson for a badge set
// that may need one; this table is what lets the pass load only what the
// candidate badges actually read.
// -----------------------------------------------------------------------------

/** One loadable bundle of learner facts. See progression/facts.ts. */
export type FactKey = 'courseProgress' | 'degrees' | 'trackScores' | 'streak' | 'perfectQuizzes';

export const CRITERION_FACTS: Record<CriterionType, readonly FactKey[]> = Object.freeze({
  lessons_completed: ['courseProgress'],
  exercises_passed: ['courseProgress'],
  course_completed: ['courseProgress'],
  courses_completed: ['courseProgress'],
  degree_earned: ['degrees'],
  track_score: ['trackScores'],
  streak_days: ['streak'],
  perfect_quiz: ['perfectQuizzes'],
});

// -----------------------------------------------------------------------------
// Which events can move which types (design §9.3: "evaluation is synchronous
// on every progress write, FILTERED TO CRITERIA TYPES THE EVENT COULD
// AFFECT").
//
// The filter is a correctness statement, not only an optimisation: a type
// missing from a trigger's row is a badge that will not fire until the next
// unrelated write, which is precisely the "silent failure" the plan warns
// about. So the rule for editing this table is: include a type unless it is
// IMPOSSIBLE for the event to change it.
// -----------------------------------------------------------------------------

export type Trigger =
  /** A `kind: lesson` lesson marked complete through the progress route. */
  | 'lesson_completed'
  /** An exercise handed in — which completes its lesson (design §9.1). */
  | 'exercise_submitted'
  /** Any quiz attempt, passing or not: a failed attempt still moves a track score. */
  | 'quiz_attempted'
  /** A teacher writing rubric scores and returning a submission (design §9.4). */
  | 'submission_graded';

export const TRIGGER_AFFECTS: Record<Trigger, readonly CriterionType[]> = Object.freeze({
  // Completing a lesson can finish its course, and finishing a course can
  // finish a degree — so `degree_earned` is in here even though this event
  // is not itself a degree. It is also an activity_events row, so it can
  // extend a streak.
  lesson_completed: [
    'lessons_completed',
    'course_completed',
    'courses_completed',
    'degree_earned',
    'streak_days',
  ],
  // Everything a lesson completion can do, plus the exercise count itself.
  // NOT track_score: rubric points are written when the teacher grades, not
  // when the student submits (design §9.4 — "grading is an additive layer
  // attaching a score afterward").
  exercise_submitted: [
    'lessons_completed',
    'exercises_passed',
    'course_completed',
    'courses_completed',
    'degree_earned',
    'streak_days',
  ],
  // A PASSING attempt completes the lesson; ANY attempt moves the track
  // score and may be the first 100 %. The route calls this for every
  // attempt, so the row covers both cases rather than splitting into two
  // triggers that a caller could pick wrongly.
  quiz_attempted: [
    'lessons_completed',
    'course_completed',
    'courses_completed',
    'degree_earned',
    'perfect_quiz',
    'streak_days',
    'track_score',
  ],
  // Grading writes rubric_scores and nothing else any criterion reads.
  //
  // `streak_days` is deliberately absent even though grading DOES append an
  // `exercise_returned` activity event for the student (design §10), which
  // Phase 3's streak logic counts as an active day like any other. Whether
  // that event should count is Phase 3's question, not this one; what this
  // row decides is only WHOSE ACTION triggers an evaluation, and a badge
  // must not land in a student's lap because a teacher cleared their
  // marking queue at midnight. The student's own next write evaluates it.
  submission_graded: ['track_score'],
});

/** True when `trigger` could have changed the value `type` measures. */
export function triggerAffects(trigger: Trigger, type: CriterionType): boolean {
  return TRIGGER_AFFECTS[trigger].includes(type);
}

/** The union of fact bundles the given criteria need — what the pass must load. */
export function factsNeededFor(criteria: readonly Criterion[]): ReadonlySet<FactKey> {
  const needed = new Set<FactKey>();
  for (const criterion of criteria) {
    for (const key of CRITERION_FACTS[criterion.type]) needed.add(key);
  }
  return needed;
}
