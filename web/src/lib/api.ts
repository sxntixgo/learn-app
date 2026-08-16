import type { components } from './api-types';

// Types come from the generated contract (CLAUDE.md rule 3) — never
// hand-written. web talks to the API over HTTP only (CLAUDE.md rule 1); it
// never receives DATABASE_URL.

export type CourseSummary = components['schemas']['CourseSummary'];
export type CourseDetail = components['schemas']['CourseDetail'];
export type Lesson = components['schemas']['Lesson'];
export type Heatmap = components['schemas']['Heatmap'];
export type HeatmapDay = components['schemas']['HeatmapDay'];
export type ActivityEvent = components['schemas']['ActivityEvent'];
export type CourseProgressSummary = components['schemas']['CourseProgressSummary'];
export type LessonProgressDetail = components['schemas']['LessonProgressDetail'];
export type ProgressState = components['schemas']['ProgressState'];
export type Me = components['schemas']['Me'];
export type ImportRunSummary = components['schemas']['ImportRunSummary'];
export type ImportProgressEvent = components['schemas']['ImportProgressEvent'];
export type ImportCounts = components['schemas']['ImportCounts'];

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }
  return base;
}

export async function fetchCourses(): Promise<CourseSummary[]> {
  const res = await fetch(`${apiBase()}/api/v1/courses`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch courses: ${res.status}`);
  }
  return (await res.json()) as CourseSummary[];
}

export async function fetchCourse(courseSlug: string): Promise<CourseDetail | null> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as CourseDetail;
}

/**
 * The actor's activity heatmap. `weeks` is a trailing window ending today;
 * the API clamps it to [1, 53] and zero-fills every day in between, so the UI
 * never infers a gap. We ask for the full year and let CSS decide how much of
 * it is visible without scrolling — see src/lib/heatmap.ts for why.
 */
export async function fetchHeatmap(weeks: number): Promise<Heatmap> {
  const res = await fetch(`${apiBase()}/api/v1/me/heatmap?weeks=${encodeURIComponent(String(weeks))}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch heatmap: ${res.status}`);
  }
  return (await res.json()) as Heatmap;
}

export async function fetchLesson(courseSlug: string, lessonSlug: string): Promise<Lesson | null> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch lesson "${lessonSlug}" in course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as Lesson;
}

/**
 * The actor's recent activity feed, newest first (design §10). `limit` is
 * left to the API's own default/clamp ([1, 100], default 20) when omitted.
 */
export async function fetchActivity(limit?: number): Promise<ActivityEvent[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await fetch(`${apiBase()}/api/v1/me/activity${query}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch activity: ${res.status}`);
  }
  return (await res.json()) as ActivityEvent[];
}

/** The actor's progress summary for a course: totals, percent, and every lesson's state. */
export async function fetchCourseProgress(courseSlug: string): Promise<CourseProgressSummary | null> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/progress`, {
    cache: 'no-store',
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch progress for course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as CourseProgressSummary;
}

/** The actor's own profile — id, display name, and effective timezone (design §15). */
export async function fetchMe(): Promise<Me> {
  const res = await fetch(`${apiBase()}/api/v1/me`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch me: ${res.status}`);
  }
  return (await res.json()) as Me;
}

/** Import run history, newest first (design plan phase 5's admin screen). */
export async function fetchImportRuns(limit?: number): Promise<ImportRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await fetch(`${apiBase()}/api/v1/admin/import-runs${query}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch import runs: ${res.status}`);
  }
  return (await res.json()) as ImportRunSummary[];
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Marks a lesson complete for the actor. Only `kind: "lesson"` may be
 * completed this way — the API returns 409 for an exercise or quiz, since
 * those complete on submission/passing in later phases. Callers that only
 * ever show this control for `kind === 'lesson'` should not see the 409 in
 * practice, but we surface the API's own message rather than assume.
 */
export async function markLessonComplete(courseSlug: string, lessonSlug: string): Promise<LessonProgressDetail> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/progress`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ state: 'complete' }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to mark lesson "${lessonSlug}" complete: ${res.status}`));
  }
  return (await res.json()) as LessonProgressDetail;
}
