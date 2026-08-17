import { cookies } from 'next/headers';
import type { components } from './api-types';

// Types come from the generated contract (CLAUDE.md rule 3) — never
// hand-written. web talks to the API over HTTP only (CLAUDE.md rule 1); it
// never receives DATABASE_URL.

export type CourseSummary = components['schemas']['CourseSummary'];
export type CourseDetail = components['schemas']['CourseDetail'];
export type CourseManage = components['schemas']['CourseManage'];
export type CourseVisibility = components['schemas']['CourseVisibility'];
export type Enrolment = components['schemas']['Enrolment'];
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

/**
 * Forwards the visitor's own session cookie to the API on a server-side
 * request. Every function in this module runs on the Next.js server (never
 * in the browser — see the client components that only ever import TYPES
 * from here), so `fetch` here is a server-to-server call that does NOT
 * automatically carry the browser's cookies the way a same-origin browser
 * fetch would. Without this, api/src/auth/actor.ts resolves every request
 * from web as the ANONYMOUS actor — which Phase 1-5 never noticed because
 * `can()` allowed everything, and Phase 6's real matrix denies most of it.
 * `next/headers`'s `cookies()` only works inside a request scope (a Server
 * Component render, a Server Action, a Route Handler); every caller below
 * is exactly one of those.
 */
async function authHeaders(): Promise<HeadersInit> {
  const store = await cookies();
  const header = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return header ? { Cookie: header } : {};
}

export async function fetchCourses(): Promise<CourseSummary[]> {
  const res = await fetch(`${apiBase()}/api/v1/courses`, { cache: 'no-store', headers: await authHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to fetch courses: ${res.status}`);
  }
  return (await res.json()) as CourseSummary[];
}

export async function fetchCourse(courseSlug: string): Promise<CourseDetail | null> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}`, {
    cache: 'no-store',
    headers: await authHeaders(),
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
 * Self-enrols the actor in a course (design §12). Returns null on a 403/404
 * — "not eligible right now" and "not found" are both states the caller
 * (the enrol button's Server Action) turns into a quiet, specific message
 * rather than a thrown error, since neither is exceptional from a reader's
 * point of view.
 */
export async function enrolInCourse(courseSlug: string): Promise<Enrolment> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/enrolments`, {
    method: 'POST',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to enrol in course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as Enrolment;
}

/** Un-enrols the actor from a course (design §12) — a soft withdrawal, not a hard delete. */
export async function unenrolFromCourse(courseSlug: string): Promise<Enrolment> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/enrolments`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to un-enrol from course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as Enrolment;
}

/**
 * Publishes/sets a course's visibility (Task C, design §12) — the owner's
 * or an admin's publish control. `can()` decides server-side; this is a
 * plain PATCH, not a re-implementation of that decision.
 */
export async function setCourseVisibility(courseSlug: string, visibility: CourseVisibility): Promise<CourseManage> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to update visibility for course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as CourseManage;
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
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch heatmap: ${res.status}`);
  }
  return (await res.json()) as Heatmap;
}

export async function fetchLesson(courseSlug: string, lessonSlug: string): Promise<Lesson | null> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`,
    { cache: 'no-store', headers: await authHeaders() },
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
  const res = await fetch(`${apiBase()}/api/v1/me/activity${query}`, { cache: 'no-store', headers: await authHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to fetch activity: ${res.status}`);
  }
  return (await res.json()) as ActivityEvent[];
}

/** The actor's progress summary for a course: totals, percent, and every lesson's state. */
export async function fetchCourseProgress(courseSlug: string): Promise<CourseProgressSummary | null> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/progress`, {
    cache: 'no-store',
    headers: await authHeaders(),
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
  const res = await fetch(`${apiBase()}/api/v1/me`, { cache: 'no-store', headers: await authHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to fetch me: ${res.status}`);
  }
  return (await res.json()) as Me;
}

/** Import run history, newest first (design plan phase 5's admin screen). */
export async function fetchImportRuns(limit?: number): Promise<ImportRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await fetch(`${apiBase()}/api/v1/admin/import-runs${query}`, { cache: 'no-store', headers: await authHeaders() });
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
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
      body: JSON.stringify({ state: 'complete' }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to mark lesson "${lessonSlug}" complete: ${res.status}`));
  }
  return (await res.json()) as LessonProgressDetail;
}
