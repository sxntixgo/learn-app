import type {
  Criterion,
  CriterionType,
  CoursesCompletedCriterion,
  CourseCompletedCriterion,
  DegreeEarnedCriterion,
  ExercisesPassedCriterion,
  LessonsCompletedCriterion,
  PerfectQuizCriterion,
  StreakDaysCriterion,
  TrackScoreCriterion,
} from './criteria.ts';
import type { CourseProgressFact, LearnerFacts } from './facts.ts';
import { trackScoreOf } from './track-score.ts';

// =============================================================================
// THE PER-TYPE EVALUATOR (design §9.3).
//
// One pure function per criterion type, from `LearnerFacts` to a scalar
// answer. Pure and synchronous on purpose: every branch is testable without a
// database, and the DB half (progression/award.ts) is then only about loading
// facts and inserting awards.
//
// EVALUATORS is typed `Record<CriterionType, ...>`, which is the compile-time
// half of criteria.ts's promise: adding a ninth type to the union without an
// evaluator here fails `tsc`, rather than shipping a badge that silently never
// fires.
//
// Every evaluator returns a SCALAR PROGRESS PAIR, not just a boolean, because
// design §9.2's "progress toward unearned degrees is visible" is the same
// requirement for badges — /api/v1/me/badges returns locked badges with how
// far the learner is toward each. Deriving `satisfied` from that same pair
// (rather than computing the two separately) is what stops the progress bar
// and the award ever disagreeing.
// =============================================================================

/** How far a learner is toward one criterion. Mirrors the OpenAPI `CriterionProgress`. */
export interface CriterionProgress {
  /** The learner's current value, CLAMPED to at most `target`. */
  current: number;
  /** The value the criterion requires. */
  target: number;
  /** current/target as a whole percentage, 0-100. */
  percent: number;
  /** What is being counted, so the UI can say "3 of 5 lessons". */
  unit: string;
}

export interface Evaluation extends CriterionProgress {
  satisfied: boolean;
}

/**
 * Builds an evaluation from a raw (unclamped) current value.
 *
 * `satisfied` is decided from the RAW value and `target` before clamping —
 * clamping is presentation, and deciding satisfaction from a clamped number
 * would work only by accident of `>=`.
 */
function progress(rawCurrent: number, target: number, unit: string, satisfied?: boolean): Evaluation {
  const current = Math.min(rawCurrent, target);
  const ratio = target <= 0 ? 1 : current / target;
  return {
    current,
    target,
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    unit,
    satisfied: satisfied ?? rawCurrent >= target,
  };
}

/**
 * A course counts as complete when every LIVE lesson in it is complete.
 *
 * `totalLessons > 0` is load-bearing rather than defensive: 0 of 0 is
 * arithmetically "all of them", and an empty course is exactly what a
 * fully-archived one looks like through facts.ts. Without this guard,
 * archiving the last lesson of a course would AWARD its completion badge to
 * everyone enrolled — and design §9.3 gives no way to take that back.
 */
function isCourseComplete(fact: CourseProgressFact): boolean {
  return fact.totalLessons > 0 && fact.completedLessons >= fact.totalLessons;
}

function coursesMatching(facts: LearnerFacts, course?: string): readonly CourseProgressFact[] {
  return course === undefined ? facts.courseProgress : facts.courseProgress.filter((c) => c.courseSlug === course);
}

function lessonsCompleted(criterion: LessonsCompletedCriterion, facts: LearnerFacts): Evaluation {
  const count = coursesMatching(facts, criterion.course).reduce((sum, c) => sum + c.completedLessons, 0);
  return progress(count, criterion.count, 'lessons');
}

function exercisesPassed(criterion: ExercisesPassedCriterion, facts: LearnerFacts): Evaluation {
  const count = coursesMatching(facts, criterion.course).reduce((sum, c) => sum + c.completedExercises, 0);
  return progress(count, criterion.count, 'exercises');
}

function courseCompleted(criterion: CourseCompletedCriterion, facts: LearnerFacts): Evaluation {
  const fact = facts.courseProgress.find((c) => c.courseSlug === criterion.course);
  return progress(fact !== undefined && isCourseComplete(fact) ? 1 : 0, 1, 'courses');
}

function coursesCompleted(criterion: CoursesCompletedCriterion, facts: LearnerFacts): Evaluation {
  return progress(facts.courseProgress.filter(isCourseComplete).length, criterion.count, 'courses');
}

function degreeEarned(criterion: DegreeEarnedCriterion, facts: LearnerFacts): Evaluation {
  return progress(facts.degrees.has(criterion.degree) ? 1 : 0, 1, 'degrees');
}

/**
 * `min` is a PERCENTAGE, and an unmeasured track scores null rather than 0.
 *
 * `satisfied` is therefore passed explicitly instead of being left to
 * `rawCurrent >= target`: with `min: 0` those two readings differ, and the
 * one that matters is track-score.ts's — a learner who has never answered a
 * question has no track score, so no track_score badge is due.
 */
function trackScore(criterion: TrackScoreCriterion, facts: LearnerFacts): Evaluation {
  const { percent } = trackScoreOf(facts.trackScores, criterion.track, criterion.course);
  return progress(percent ?? 0, criterion.min, 'percent', percent !== null && percent >= criterion.min);
}

function streakDays(criterion: StreakDaysCriterion, facts: LearnerFacts): Evaluation {
  return progress(facts.currentStreak, criterion.days, 'days');
}

/**
 * `count` defaults to 1 — schemas/badge.schema.json requires only `type`, so
 * the bare `{type: perfect_quiz}` a manifest may write means "ace one".
 */
function perfectQuiz(criterion: PerfectQuizCriterion, facts: LearnerFacts): Evaluation {
  const matching = facts.perfectQuizzes.filter(
    (q) =>
      (criterion.course === undefined || q.courseSlug === criterion.course) &&
      (criterion.lesson === undefined || q.lessonSlug === criterion.lesson),
  );
  return progress(matching.length, criterion.count ?? 1, 'quizzes');
}

type Evaluator<C extends Criterion> = (criterion: C, facts: LearnerFacts) => Evaluation;

/**
 * The vocabulary as functions. `Record<CriterionType, ...>` is what makes a
 * missing evaluator a compile error — see the header.
 */
const EVALUATORS: { [T in CriterionType]: Evaluator<Extract<Criterion, { type: T }>> } = {
  lessons_completed: lessonsCompleted,
  exercises_passed: exercisesPassed,
  course_completed: courseCompleted,
  courses_completed: coursesCompleted,
  degree_earned: degreeEarned,
  track_score: trackScore,
  streak_days: streakDays,
  perfect_quiz: perfectQuiz,
};

/** How far `facts` carry a learner toward `criterion`, and whether it is met. */
export function evaluateCriterion(criterion: Criterion, facts: LearnerFacts): Evaluation {
  // The cast narrows the union-of-functions to the one matching this
  // criterion's tag; TypeScript cannot do that correlation itself, and the
  // EVALUATORS type above is what makes it sound.
  const evaluate = EVALUATORS[criterion.type] as Evaluator<Criterion>;
  return evaluate(criterion, facts);
}
