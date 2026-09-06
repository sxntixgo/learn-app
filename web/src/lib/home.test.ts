import { describe, it, expect } from 'vitest';
import {
  activityDot,
  activityThisWeek,
  degreeTally,
  flattenLessons,
  lessonMeta,
  pickCurrentCourse,
  pickDegree,
  planCourse,
  twoDigit,
  type CoursePlan,
} from './home';
import type {
  ActivityEvent,
  CourseDetail,
  CourseProgressSummary,
  DegreeProgress,
  EnrolledCourse,
  HeatmapDay,
  LessonSummary,
} from './api';

/*
 * Home is assembled from two screens, and the failure mode the plan names
 * for it is "a quietly dropped element". These cover the derivations that
 * decide WHICH element gets drawn — which course resumes, which lesson is
 * next, how many pips the degree card has — because those are the ones that
 * fail by silently rendering nothing rather than by throwing.
 */

function lesson(slug: string, over: Partial<LessonSummary> = {}): LessonSummary {
  return { slug, title: slug, kind: 'lesson', position: 1, track: null, estimateMinutes: null, ...over };
}

function courseDetail(modules: { title: string; lessons: LessonSummary[] }[], slug = 'recursion'): CourseDetail {
  return {
    slug,
    title: 'Recursion & Induction',
    subtitle: null,
    description: null,
    tags: [],
    tracks: [],
    visibility: 'open',
    enrolled: true,
    canPublish: false,
    modules: modules.map((m, i) => ({ key: `m${i}`, title: m.title, position: i, lessons: m.lessons })),
  };
}

function enrolled(over: Partial<EnrolledCourse> = {}): EnrolledCourse {
  return { slug: 'recursion', title: 'Recursion & Induction', totalLessons: 4, completedLessons: 1, percent: 25, ...over };
}

function progress(states: Record<string, 'not_started' | 'in_progress' | 'complete'>): CourseProgressSummary {
  const lessons = Object.entries(states).map(([slug, state]) => ({ slug, kind: 'lesson' as const, state }));
  return {
    totalLessons: lessons.length,
    completedLessons: lessons.filter((l) => l.state === 'complete').length,
    percent: 0,
    lessons,
  };
}

const TWO_MODULES = courseDetail([
  { title: 'Beginnings', lessons: [lesson('a'), lesson('b')] },
  { title: 'Trees', lessons: [lesson('c', { kind: 'quiz' }), lesson('d')] },
]);

describe('flattenLessons', () => {
  it('numbers lessons from 1 across module boundaries, in manifest order', () => {
    const flat = flattenLessons(TWO_MODULES);
    expect(flat.map((l) => [l.lesson.slug, l.number, l.moduleNumber])).toEqual([
      ['a', 1, 1],
      ['b', 2, 1],
      ['c', 3, 2],
      ['d', 4, 2],
    ]);
  });

  it('numbers from the array, not from the manifest positions, so archived gaps do not leak', () => {
    // `/courses/{slug}` omits archived lessons but keeps the survivors'
    // original `position`, so trusting it would number the visible lessons
    // 1, 5, 9 and the artboards' "LESSON 6" would count something the
    // reader cannot see.
    const gappy = courseDetail([{ title: 'Beginnings', lessons: [lesson('a', { position: 0 }), lesson('b', { position: 7 })] }]);
    expect(flattenLessons(gappy).map((l) => l.number)).toEqual([1, 2]);
  });

  it('links each lesson into its own course', () => {
    expect(flattenLessons(TWO_MODULES)[2]!.href).toBe('/courses/recursion/lessons/c');
  });
});

describe('planCourse', () => {
  it('resumes at the first unfinished lesson and lists it first under Up next', () => {
    const plan = planCourse(enrolled(), TWO_MODULES, progress({ a: 'complete', b: 'in_progress' }), 2);
    expect(plan.next?.lesson.slug).toBe('b');
    expect(plan.next?.moduleNumber).toBe(1);
    expect(plan.upcoming.map((u) => u.lesson.slug)).toEqual(['b', 'c']);
  });

  it('treats a lesson with no progress row as unfinished', () => {
    const plan = planCourse(enrolled(), TWO_MODULES, progress({ a: 'complete' }), 2);
    expect(plan.next?.lesson.slug).toBe('b');
  });

  it('reports no next lesson when every lesson is complete', () => {
    const done = progress({ a: 'complete', b: 'complete', c: 'complete', d: 'complete' });
    const plan = planCourse(enrolled({ completedLessons: 4, percent: 100 }), TWO_MODULES, done, 2);
    expect(plan.next).toBeNull();
    expect(plan.upcoming).toEqual([]);
  });

  it('degrades to no next lesson — never to lesson one — when the course or progress is unavailable', () => {
    // A 404 from either call (unlisted course, enrolment ended between the
    // two requests) must not make Home tell the reader to start over.
    expect(planCourse(enrolled(), null, null, 2).next).toBeNull();
    expect(planCourse(enrolled(), TWO_MODULES, null, 2).next?.lesson.slug).toBe('a');
  });

  it('carries the counts from /me/courses rather than recomputing them', () => {
    const plan = planCourse(enrolled({ totalLessons: 12, completedLessons: 5, percent: 42 }), TWO_MODULES, null, 2);
    expect([plan.totalLessons, plan.completedLessons, plan.percent]).toEqual([12, 5, 42]);
    expect(plan.moduleCount).toBe(2);
  });
});

describe('pickCurrentCourse', () => {
  const plans = (): CoursePlan[] => [
    planCourse(enrolled({ slug: 'algo', title: 'Algorithms', completedLessons: 0 }), TWO_MODULES, progress({}), 2),
    planCourse(enrolled({ slug: 'recursion' }), TWO_MODULES, progress({ a: 'complete' }), 2),
  ];

  function event(slug: string | null): ActivityEvent {
    return {
      type: 'lesson_completed',
      occurredAt: '2026-09-01T00:00:00.000Z',
      course: slug ? { slug, title: slug } : null,
      lesson: null,
    } as ActivityEvent;
  }

  it('resumes the most recently touched enrolled course', () => {
    expect(pickCurrentCourse(plans(), [event('recursion'), event('algo')])?.slug).toBe('recursion');
  });

  it('ignores feed entries for courses that are not resumable', () => {
    expect(pickCurrentCourse(plans(), [event('long-gone'), event('algo')])?.slug).toBe('algo');
  });

  it('prefers a started course over an untouched one when the feed says nothing', () => {
    expect(pickCurrentCourse(plans(), [])?.slug).toBe('recursion');
  });

  it('is null when nothing is resumable', () => {
    const finished = planCourse(
      enrolled(),
      TWO_MODULES,
      progress({ a: 'complete', b: 'complete', c: 'complete', d: 'complete' }),
      2,
    );
    expect(pickCurrentCourse([finished], [event('recursion')])).toBeNull();
    expect(pickCurrentCourse([], [])).toBeNull();
  });
});

describe('degreeTally', () => {
  function degree(over: Partial<DegreeProgress> = {}): DegreeProgress {
    return {
      slug: 'foundations',
      title: 'Foundations of Computing',
      description: null,
      earned: false,
      awardedAt: null,
      required: [],
      electives: null,
      satisfiable: true,
      missingCourses: [],
      percent: 0,
      ...over,
    };
  }

  const req = (slug: string, completed: boolean) => ({ slug, title: slug, imported: true, completed });

  it('counts required courses', () => {
    expect(degreeTally(degree({ required: [req('a', true), req('b', true), req('c', false)] }))).toEqual({
      complete: 2,
      total: 3,
    });
  });

  it('adds the electives the degree asks for, not the ones it offers', () => {
    const d = degree({
      required: [req('a', true)],
      electives: { choose: 2, from: [req('x', true), req('y', true), req('z', false)], completed: 2 },
    });
    expect(degreeTally(d)).toEqual({ complete: 3, total: 3 });
  });

  it('caps elective progress at the requirement', () => {
    const d = degree({
      required: [],
      electives: { choose: 1, from: [req('x', true), req('y', true)], completed: 2 },
    });
    expect(degreeTally(d)).toEqual({ complete: 1, total: 1 });
  });
});

describe('pickDegree', () => {
  function degree(slug: string, earned: boolean, percent: number): DegreeProgress {
    return {
      slug,
      title: slug,
      description: null,
      earned,
      awardedAt: null,
      required: [],
      electives: null,
      satisfiable: true,
      missingCourses: [],
      percent,
    };
  }

  it('shows the nearest unearned degree', () => {
    expect(pickDegree([degree('a', false, 10), degree('b', false, 80), degree('c', true, 100)])?.slug).toBe('b');
  });

  it('falls back to an earned degree rather than rendering nothing', () => {
    expect(pickDegree([degree('c', true, 100)])?.slug).toBe('c');
  });

  it('is null when there are no degrees at all', () => {
    expect(pickDegree([])).toBeNull();
  });
});

describe('activityThisWeek', () => {
  const days = (counts: number[]): HeatmapDay[] => counts.map((count, i) => ({ date: `2026-09-${i + 1}`, count }));

  it('sums the trailing seven days, which are the END of the array', () => {
    // The heatmap is oldest-first, ending today. Summing the HEAD would
    // report a fortnight ago and look plausible while being wrong.
    expect(activityThisWeek(days([9, 9, 9, 9, 9, 9, 9, 1, 2, 3, 0, 0, 0, 4]))).toBe(10);
  });

  it('sums everything when fewer than seven days are present', () => {
    expect(activityThisWeek(days([1, 2, 3]))).toBe(6);
    expect(activityThisWeek([])).toBe(0);
  });
});

describe('activityDot', () => {
  it('gives passes, badges and degrees the noticing tone', () => {
    for (const type of ['quiz_passed', 'badge_awarded', 'degree_earned', 'course_completed'] as const) {
      expect(activityDot(type), type).toBe('award');
    }
  });

  it('gives enrolment its own quiet tone and ordinary reading the progress tone', () => {
    expect(activityDot('course_enrolled')).toBe('enrolment');
    expect(activityDot('lesson_completed')).toBe('progress');
    expect(activityDot('exercise_returned')).toBe('progress');
  });

  it('degrades a type it has never seen to progress rather than to nothing', () => {
    expect(activityDot('widget_replaced')).toBe('progress');
  });
});

describe('lessonMeta', () => {
  it('names the kind the way the artboards do', () => {
    expect(lessonMeta(lesson('a', { estimateMinutes: 9 }))).toBe('9 min · reading');
    expect(lessonMeta(lesson('b', { kind: 'quiz', estimateMinutes: 2 }))).toBe('2 min · checkpoint');
    expect(lessonMeta(lesson('c', { kind: 'exercise' }))).toBe('exercise');
  });

  it('omits an estimate the content did not declare', () => {
    expect(lessonMeta(lesson('a'))).toBe('reading');
    expect(lessonMeta(lesson('a', { estimateMinutes: 0 }))).toBe('reading');
  });
});

describe('twoDigit', () => {
  it('pads below ten and leaves everything else alone', () => {
    expect([twoDigit(1), twoDigit(9), twoDigit(10), twoDigit(112)]).toEqual(['01', '09', '10', '112']);
  });
});
