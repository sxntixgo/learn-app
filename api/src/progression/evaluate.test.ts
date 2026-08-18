import { describe, it, expect } from 'vitest';
import { evaluateCriterion } from './evaluate.ts';
import { emptyFacts } from './facts.ts';
import type { LearnerFacts } from './facts.ts';
import { CRITERION_TYPES } from './criteria.ts';
import type { Criterion } from './criteria.ts';
import { poolTrackTallies } from './track-score.ts';

function facts(overrides: Partial<LearnerFacts> = {}): LearnerFacts {
  return { ...emptyFacts(), ...overrides };
}

describe('evaluateCriterion — lessons_completed', () => {
  const someProgress = facts({
    courseProgress: [
      { courseSlug: 'code-review', totalLessons: 5, completedLessons: 3, completedExercises: 1 },
      { courseSlug: 'go-security', totalLessons: 4, completedLessons: 2, completedExercises: 2 },
    ],
  });

  it('pools every course when no course is named', () => {
    const result = evaluateCriterion({ type: 'lessons_completed', count: 10 }, someProgress);
    expect(result).toMatchObject({ current: 5, target: 10, percent: 50, unit: 'lessons' });
    expect(result.satisfied).toBe(false);
  });

  it('narrows to one course when `course` is given', () => {
    const result = evaluateCriterion({ type: 'lessons_completed', count: 3, course: 'code-review' }, someProgress);
    expect(result.current).toBe(3);
    expect(result.satisfied).toBe(true);
  });

  it('is unsatisfied for a course this instance has not imported', () => {
    const result = evaluateCriterion({ type: 'lessons_completed', count: 1, course: 'not-here' }, someProgress);
    expect(result.current).toBe(0);
    expect(result.satisfied).toBe(false);
  });

  it('clamps `current` to `target` rather than reporting more than 100 %', () => {
    const result = evaluateCriterion({ type: 'lessons_completed', count: 2 }, someProgress);
    expect(result.current).toBe(2);
    expect(result.percent).toBe(100);
    expect(result.satisfied).toBe(true);
  });
});

describe('evaluateCriterion — exercises_passed', () => {
  it('counts completed exercise-kind lessons, not all lessons', () => {
    const result = evaluateCriterion(
      { type: 'exercises_passed', count: 3 },
      facts({
        courseProgress: [{ courseSlug: 'code-review', totalLessons: 9, completedLessons: 8, completedExercises: 3 }],
      }),
    );
    expect(result).toMatchObject({ current: 3, target: 3, unit: 'exercises' });
    expect(result.satisfied).toBe(true);
  });
});

describe('evaluateCriterion — course_completed', () => {
  it('is satisfied only when every live lesson of the named course is complete', () => {
    const partial = facts({
      courseProgress: [{ courseSlug: 'code-review', totalLessons: 5, completedLessons: 4, completedExercises: 0 }],
    });
    expect(evaluateCriterion({ type: 'course_completed', course: 'code-review' }, partial)).toMatchObject({
      current: 0,
      target: 1,
      satisfied: false,
    });

    const done = facts({
      courseProgress: [{ courseSlug: 'code-review', totalLessons: 5, completedLessons: 5, completedExercises: 0 }],
    });
    expect(evaluateCriterion({ type: 'course_completed', course: 'code-review' }, done)).toMatchObject({
      current: 1,
      percent: 100,
      satisfied: true,
    });
  });

  it('is never satisfied by a course with no live lessons', () => {
    // 0 of 0 is arithmetically "all of them", and an empty course is exactly
    // what a fully-archived one looks like. Awarding a course badge for it
    // would be an award that can never be taken back (design §9.3).
    const empty = facts({
      courseProgress: [{ courseSlug: 'ghost', totalLessons: 0, completedLessons: 0, completedExercises: 0 }],
    });
    expect(evaluateCriterion({ type: 'course_completed', course: 'ghost' }, empty).satisfied).toBe(false);
  });
});

describe('evaluateCriterion — courses_completed', () => {
  it('counts fully-complete courses', () => {
    const result = evaluateCriterion(
      { type: 'courses_completed', count: 2 },
      facts({
        courseProgress: [
          { courseSlug: 'a', totalLessons: 2, completedLessons: 2, completedExercises: 0 },
          { courseSlug: 'b', totalLessons: 3, completedLessons: 3, completedExercises: 0 },
          { courseSlug: 'c', totalLessons: 3, completedLessons: 1, completedExercises: 0 },
          { courseSlug: 'empty', totalLessons: 0, completedLessons: 0, completedExercises: 0 },
        ],
      }),
    );
    expect(result).toMatchObject({ current: 2, target: 2, unit: 'courses', satisfied: true });
  });
});

describe('evaluateCriterion — degree_earned', () => {
  it('reads user_degrees, never recomputed requirements', () => {
    const held = facts({ degrees: new Set(['secure-code-review']) });
    expect(evaluateCriterion({ type: 'degree_earned', degree: 'secure-code-review' }, held).satisfied).toBe(true);
    expect(evaluateCriterion({ type: 'degree_earned', degree: 'other' }, held).satisfied).toBe(false);
  });
});

describe('evaluateCriterion — track_score', () => {
  const scored = facts({
    trackScores: poolTrackTallies(
      [{ courseSlug: 'code-review', track: 'cx', earned: 9, possible: 10 }],
      [{ courseSlug: 'code-review', track: 'cx', earned: 0, possible: 0 }],
    ),
  });

  it('compares the pooled percentage against `min`', () => {
    expect(evaluateCriterion({ type: 'track_score', track: 'cx', min: 90 }, scored)).toMatchObject({
      current: 90,
      target: 90,
      unit: 'percent',
      satisfied: true,
    });
    expect(evaluateCriterion({ type: 'track_score', track: 'cx', min: 95 }, scored).satisfied).toBe(false);
  });

  it('is unsatisfied when nothing has been measured, even for min: 0', () => {
    // percent is null, not zero (track-score.ts). A `min: 0` badge must not
    // fire for a student who has never answered a question.
    expect(evaluateCriterion({ type: 'track_score', track: 'cx', min: 0 }, facts())).toMatchObject({
      current: 0,
      satisfied: false,
    });
  });

  it('narrows to one course when `course` is given', () => {
    expect(
      evaluateCriterion({ type: 'track_score', track: 'cx', course: 'elsewhere', min: 1 }, scored).satisfied,
    ).toBe(false);
  });
});

describe('evaluateCriterion — streak_days', () => {
  it('reads the current streak', () => {
    expect(evaluateCriterion({ type: 'streak_days', days: 7 }, facts({ currentStreak: 7 }))).toMatchObject({
      current: 7,
      target: 7,
      unit: 'days',
      satisfied: true,
    });
    expect(evaluateCriterion({ type: 'streak_days', days: 7 }, facts({ currentStreak: 6 })).satisfied).toBe(false);
  });
});

describe('evaluateCriterion — perfect_quiz', () => {
  const aced = facts({
    perfectQuizzes: [
      { courseSlug: 'code-review', lessonSlug: 'q1' },
      { courseSlug: 'code-review', lessonSlug: 'q2' },
      { courseSlug: 'go-security', lessonSlug: 'q1' },
    ],
  });

  it('defaults `count` to 1', () => {
    expect(evaluateCriterion({ type: 'perfect_quiz' }, aced)).toMatchObject({
      target: 1,
      unit: 'quizzes',
      satisfied: true,
    });
  });

  it('narrows by course and by lesson', () => {
    expect(evaluateCriterion({ type: 'perfect_quiz', count: 2, course: 'code-review' }, aced).satisfied).toBe(true);
    expect(evaluateCriterion({ type: 'perfect_quiz', count: 2, course: 'go-security' }, aced).satisfied).toBe(false);
    expect(
      evaluateCriterion({ type: 'perfect_quiz', course: 'code-review', lesson: 'q2' }, aced).satisfied,
    ).toBe(true);
    expect(
      evaluateCriterion({ type: 'perfect_quiz', course: 'code-review', lesson: 'q9' }, aced).satisfied,
    ).toBe(false);
  });

  it('does not match a lesson slug from a different course when a course is named', () => {
    expect(
      evaluateCriterion({ type: 'perfect_quiz', course: 'go-security', lesson: 'q2' }, aced).satisfied,
    ).toBe(false);
  });
});

describe('the closed vocabulary', () => {
  // criteria.ts's header: "a ninth type added there without an evaluator is a
  // COMPILE ERROR, not a badge that silently never fires". This is the
  // runtime half of that guarantee — every declared type evaluates without
  // throwing, on all-empty facts.
  it('evaluates every declared criterion type', () => {
    const samples: Record<string, Criterion> = {
      lessons_completed: { type: 'lessons_completed', count: 1 },
      exercises_passed: { type: 'exercises_passed', count: 1 },
      course_completed: { type: 'course_completed', course: 'x' },
      courses_completed: { type: 'courses_completed', count: 1 },
      degree_earned: { type: 'degree_earned', degree: 'x' },
      track_score: { type: 'track_score', track: 'x', min: 50 },
      streak_days: { type: 'streak_days', days: 1 },
      perfect_quiz: { type: 'perfect_quiz' },
    };

    for (const type of CRITERION_TYPES) {
      const criterion = samples[type];
      expect(criterion, `no sample for criterion type ${type}`).toBeDefined();
      const result = evaluateCriterion(criterion!, facts());
      expect(result.satisfied).toBe(false);
      expect(result.percent).toBeGreaterThanOrEqual(0);
      expect(result.percent).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result.percent)).toBe(true);
    }
  });
});
