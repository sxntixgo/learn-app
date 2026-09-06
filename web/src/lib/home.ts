/*
 * Home's derivations, kept out of the components so they can be tested
 * without a browser or a server (the same split as src/lib/heatmap.ts and
 * src/lib/activity.ts).
 *
 * WHY THERE IS ANYTHING TO DERIVE. The M1/P2 artboards
 * (docs/design/2026-09-02-artboard-spec.md §6) ask Home four questions the
 * API answers only in pieces:
 *
 *   "where was I"      -> which enrolled course to resume, and at which lesson
 *   "what is next"     -> the two lessons after that one, numbered
 *   "how far in"       -> module N of M, and a percent
 *   "how is the degree going" -> courses complete out of courses required
 *
 * Every one of them is a fold over data that already exists: `/me/courses`
 * (which courses), `/courses/{slug}` (their modules and lessons, in manifest
 * order), `/courses/{slug}/progress` (each lesson's state), `/me/degrees`
 * and `/me/activity`. NO ENDPOINT WAS ADDED FOR THIS SCREEN — Phase 2
 * already added one (`GET /api/v1/me/courses`) and it is under review, so
 * anything the existing contract cannot answer is reported as absent rather
 * than invented. See `activityThisWeek` for the one place that bites.
 */

import type {
  ActivityEvent,
  ActivityEventType,
  CourseDetail,
  CourseProgressSummary,
  DegreeProgress,
  EnrolledCourse,
  HeatmapDay,
  LessonSummary,
} from './api';

/** One lesson, located in its course: enough to render a row and link to it. */
export interface PlannedLesson {
  lesson: LessonSummary;
  /** 1-based position in the WHOLE course, in manifest order — the artboards' `07` / `08`. */
  number: number;
  moduleTitle: string;
  /** 1-based position of the containing module. */
  moduleNumber: number;
  /** Whether the actor has already finished it. */
  complete: boolean;
  href: string;
}

/** One enrolled course, folded into everything Home renders about it. */
export interface CoursePlan {
  slug: string;
  title: string;
  totalLessons: number;
  completedLessons: number;
  percent: number;
  moduleCount: number;
  /** The first unfinished lesson, or null when the course is finished. */
  next: PlannedLesson | null;
  /** `next` and what follows it, in manifest order. Empty when the course is finished. */
  upcoming: PlannedLesson[];
  href: string;
}

export function lessonHref(courseSlug: string, lessonSlug: string): string {
  return `/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`;
}

export function courseHref(courseSlug: string): string {
  return `/courses/${encodeURIComponent(courseSlug)}`;
}

/**
 * Every lesson in a course, flattened into manifest order and numbered from
 * 1 across module boundaries.
 *
 * Numbered from the ARRAY, not from `module.position` / `lesson.position`.
 * Those are the manifest's own numbering and skip whatever was archived —
 * `/courses/{slug}` omits archived modules and lessons, so `position` has
 * gaps in it, and the artboards' "LESSON 6" counts what the reader can
 * actually see.
 */
export function flattenLessons(course: CourseDetail): Omit<PlannedLesson, 'complete'>[] {
  const out: Omit<PlannedLesson, 'complete'>[] = [];
  course.modules.forEach((module, moduleIndex) => {
    for (const lesson of module.lessons) {
      out.push({
        lesson,
        number: out.length + 1,
        moduleTitle: module.title,
        moduleNumber: moduleIndex + 1,
        href: lessonHref(course.slug, lesson.slug),
      });
    }
  });
  return out;
}

/**
 * Folds one enrolled course together with its table of contents and the
 * actor's progress through it.
 *
 * `progress` may be null: `/courses/{slug}/progress` 404s for a course the
 * actor is not enrolled in, and enrolment can end between the two requests.
 * The result then reports no next lesson rather than guessing that lesson
 * one is where they are.
 */
export function planCourse(
  enrolled: EnrolledCourse,
  course: CourseDetail | null,
  progress: CourseProgressSummary | null,
  upcomingCount: number,
): CoursePlan {
  const base: CoursePlan = {
    slug: enrolled.slug,
    title: enrolled.title,
    totalLessons: enrolled.totalLessons,
    completedLessons: enrolled.completedLessons,
    percent: enrolled.percent,
    moduleCount: course?.modules.length ?? 0,
    next: null,
    upcoming: [],
    href: courseHref(enrolled.slug),
  };
  if (!course) return base;

  const stateBySlug = new Map(progress?.lessons.map((l) => [l.slug, l.state]) ?? []);
  const lessons: PlannedLesson[] = flattenLessons(course).map((entry) => ({
    ...entry,
    complete: stateBySlug.get(entry.lesson.slug) === 'complete',
  }));

  const firstUnfinished = lessons.findIndex((l) => !l.complete);
  if (firstUnfinished === -1) return base;

  return {
    ...base,
    next: lessons[firstUnfinished]!,
    upcoming: lessons.slice(firstUnfinished, firstUnfinished + Math.max(0, upcomingCount)),
  };
}

/**
 * Which course the resume banner is about.
 *
 * The most recently touched enrolled course wins, read off the activity feed
 * — that is what "resume" means, and it is the only signal in the data that
 * carries recency. Falling back, in order: a course that is started but
 * unfinished (resuming beats starting), then any course with a next lesson,
 * then nothing.
 *
 * `activity` is assumed newest-first, which is what `/me/activity` promises.
 */
export function pickCurrentCourse(plans: readonly CoursePlan[], activity: readonly ActivityEvent[]): CoursePlan | null {
  const resumable = plans.filter((p) => p.next !== null);
  if (resumable.length === 0) return null;

  for (const event of activity) {
    const slug = event.course?.slug;
    if (!slug) continue;
    const hit = resumable.find((p) => p.slug === slug);
    if (hit) return hit;
  }

  return resumable.find((p) => p.completedLessons > 0) ?? resumable[0]!;
}

/** "2 of 5 courses complete" — required courses plus however many electives the degree asks for. */
export interface DegreeTally {
  complete: number;
  total: number;
}

export function degreeTally(degree: DegreeProgress): DegreeTally {
  const requiredTotal = degree.required.length;
  const requiredComplete = degree.required.filter((r) => r.completed).length;
  const electivesTotal = degree.electives?.choose ?? 0;
  // A learner may have finished MORE electives than the degree asks for;
  // the tally is progress toward the requirement, so it caps at it.
  const electivesComplete = Math.min(degree.electives?.completed ?? 0, electivesTotal);
  return { complete: requiredComplete + electivesComplete, total: requiredTotal + electivesTotal };
}

/**
 * The one degree the card shows: the nearest unearned one, by progress.
 * An already-earned degree is not "progress", so it only shows when there is
 * nothing else — and then it shows as complete, which is the truth.
 */
export function pickDegree(degrees: readonly DegreeProgress[]): DegreeProgress | null {
  if (degrees.length === 0) return null;
  const unearned = degrees.filter((d) => !d.earned);
  if (unearned.length === 0) return degrees[0]!;
  return unearned.reduce((best, d) => (d.percent > best.percent ? d : best));
}

/**
 * The dot beside a feed row (M1 draws three tones, not eight).
 *
 * `award` for the things worth noticing, `enrolment` for the quiet
 * bookkeeping ones, `progress` for ordinary reading. Every member of
 * ActivityEventType is named so a new one has to be classified rather than
 * silently landing in a default.
 */
export type ActivityDot = 'award' | 'progress' | 'enrolment';

export function activityDot(type: ActivityEventType | string): ActivityDot {
  switch (type) {
    case 'quiz_passed':
    case 'badge_awarded':
    case 'degree_earned':
    case 'course_completed':
      return 'award';
    case 'course_enrolled':
      return 'enrolment';
    case 'lesson_completed':
    case 'exercise_submitted':
    case 'exercise_returned':
      return 'progress';
    default:
      return 'progress';
  }
}

/**
 * The banner's second statistic — and A DELIBERATE DEVIATION FROM THE
 * ARTBOARD, recorded here because it is the kind of thing that otherwise
 * gets re-discovered as a bug.
 *
 * M1 and P2 both show "3h 40m · THIS WEEK". NOTHING IN THE API MEASURES
 * TIME: `lesson_progress.seconds_spent` exists in the database and is
 * exposed only per-lesson, after an upsert (`LessonProgressDetail`), never
 * aggregated and never over a window. Rendering minutes would have meant a
 * new endpoint, and adding one is a scope decision for a human
 * (docs/plans/2026-09-02-design-import-plan.md, Phase 2's outcome note).
 *
 * So the slot keeps the artboard's question — "how much have I done this
 * week" — and answers it with data that exists: the number of activity
 * events in the trailing seven local days, straight off the heatmap the
 * streak already comes from. Same request, no new one.
 *
 * `days` is the heatmap's own array: contiguous local days, OLDEST FIRST,
 * ending today. Hence the tail.
 */
export const THIS_WEEK_DAYS = 7;

export function activityThisWeek(days: readonly HeatmapDay[]): number {
  return days.slice(-THIS_WEEK_DAYS).reduce((sum, day) => sum + day.count, 0);
}

/** "7 min · reading" / "2 min · checkpoint" / "exercise" — whatever the lesson actually declares. */
export function lessonMeta(lesson: LessonSummary): string {
  const kind = lesson.kind === 'quiz' ? 'checkpoint' : lesson.kind === 'exercise' ? 'exercise' : 'reading';
  const minutes = lesson.estimateMinutes;
  return minutes && minutes > 0 ? `${minutes} min · ${kind}` : kind;
}

/** The artboards number rows `01`, `07`. Two digits below ten, plain above 99. */
export function twoDigit(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
