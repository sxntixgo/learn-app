import type { components } from './api-types';

// Types come from the generated contract (CLAUDE.md rule 3) — never
// hand-written. web talks to the API over HTTP only (CLAUDE.md rule 1); it
// never receives DATABASE_URL.

export type CourseSummary = components['schemas']['CourseSummary'];
export type CourseDetail = components['schemas']['CourseDetail'];
export type Lesson = components['schemas']['Lesson'];
export type Heatmap = components['schemas']['Heatmap'];
export type HeatmapDay = components['schemas']['HeatmapDay'];

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
