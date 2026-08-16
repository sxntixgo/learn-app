/*
 * Activity feed formatting, kept out of the component so it can be tested
 * without a browser (same split as src/lib/heatmap.ts).
 *
 * Only `lesson_completed` is emitted by the API today (design §10's other
 * seven event types arrive in later phases). Every type in
 * ActivityEventType is handled explicitly below so the feed renders
 * sensibly the day each one starts appearing; a type that somehow doesn't
 * match any case still degrades to a readable generic line rather than
 * throwing.
 */

import type { ActivityEvent } from './api';

export interface ActivityLine {
  /** The full sentence describing what happened, including course/lesson context. */
  text: string;
  /** Where the entry links, when it names a specific lesson. Null otherwise. */
  href: string | null;
}

function lessonHref(courseSlug: string, lessonSlug: string): string {
  return `/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`;
}

/** Last-resort fallback for an event type this file doesn't recognise, e.g. "widget_replaced" -> "Widget replaced". */
function humanizeEventType(type: string): string {
  const words = type.split('_').join(' ');
  return words.length === 0 ? 'Activity' : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Renders one activity_events row as a readable line. Links to the lesson
 * only when the event names one — course-only events (enrollment, course
 * completion) mention the course by name but don't link, per design: the
 * feed links to the lesson where one applies, not to a course page.
 */
export function formatActivityLine(event: ActivityEvent): ActivityLine {
  const { course, lesson } = event;
  const lessonTitle = lesson ? `“${lesson.title}”` : null;
  const courseTitle = course?.title ?? null;
  const inCourse = courseTitle ? ` in ${courseTitle}` : '';
  const href = course && lesson ? lessonHref(course.slug, lesson.slug) : null;

  switch (event.type as string) {
    case 'lesson_completed':
      return { text: `Completed ${lessonTitle ?? 'a lesson'}${inCourse}`, href };
    case 'exercise_submitted':
      return { text: `Submitted ${lessonTitle ?? 'an exercise'}${inCourse}`, href };
    case 'exercise_returned':
      return { text: `Feedback returned on ${lessonTitle ?? 'an exercise'}${inCourse}`, href };
    case 'quiz_passed':
      return { text: `Passed the quiz${lessonTitle ? ` ${lessonTitle}` : ''}${inCourse}`, href };
    case 'course_enrolled':
      return { text: `Enrolled in ${courseTitle ?? 'a course'}`, href: null };
    case 'course_completed':
      return { text: `Completed the course ${courseTitle ?? ''}`.trim(), href: null };
    case 'degree_earned':
      return { text: 'Earned a degree', href: null };
    case 'badge_awarded':
      return { text: 'Earned a badge', href: null };
    default:
      return { text: `${humanizeEventType(event.type)}${inCourse}`.trim(), href };
  }
}

export interface FormattedTimestamp {
  /** Absolute, human-readable, in the actor's timezone. e.g. "Aug 15, 2026, 3:04 PM". */
  absolute: string;
  /** Machine-readable, for the <time datetime> attribute. */
  iso: string;
  /** Relative to `now`, e.g. "2 days ago". Always alongside the absolute form, never instead of it. */
  relative: string;
}

const RELATIVE_UNITS: Array<{ limit: number; divisor: number; unit: string }> = [
  { limit: 60, divisor: 1, unit: 'second' },
  { limit: 60 * 60, divisor: 60, unit: 'minute' },
  { limit: 60 * 60 * 24, divisor: 60 * 60, unit: 'hour' },
  { limit: 60 * 60 * 24 * 30, divisor: 60 * 60 * 24, unit: 'day' },
  { limit: 60 * 60 * 24 * 365, divisor: 60 * 60 * 24 * 30, unit: 'month' },
];

/** "2 days ago" / "3 months ago" / "just now". `now` is injectable for tests. */
export function formatRelativeTime(occurredAt: string, now: Date = new Date()): string {
  const diffSec = Math.max(0, Math.round((now.getTime() - new Date(occurredAt).getTime()) / 1000));
  if (diffSec < 30) return 'just now';

  for (const { limit, divisor, unit } of RELATIVE_UNITS) {
    if (diffSec < limit) {
      const amount = Math.max(1, Math.round(diffSec / divisor));
      return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
    }
  }
  const years = Math.max(1, Math.round(diffSec / (60 * 60 * 24 * 365)));
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Formats an event's UTC `occurredAt` in the actor's own timezone (design
 * §15) — never the server's, never the browser's. `timezone` comes from the
 * heatmap/`/me` response, which already resolves it (real value, or the UTC
 * fallback when unset).
 */
export function formatOccurredAt(occurredAt: string, timezone: string, now: Date = new Date()): FormattedTimestamp {
  const date = new Date(occurredAt);
  const absolute = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);

  return { absolute, iso: date.toISOString(), relative: formatRelativeTime(occurredAt, now) };
}
