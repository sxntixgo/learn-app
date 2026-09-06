/*
 * Catalog (M2/P3, docs/design/2026-09-02-artboard-spec.md §2, §4) —
 * "browsing only... filters, all five courses, no progress banner, no
 * stats." The extracted spec says "filters" and stops there; no artboard
 * CSS or brief in the source project names which field. `tags` is the one
 * piece of course metadata the catalog card already shows (page.tsx's
 * `.cardMeta`) and the only one `CourseSummary` (openapi.yaml) carries that
 * is meaningfully a *category* rather than free text — visibility is
 * already a badge, not a filter, and title/description search already has
 * a home at `/search`. So the filter set is derived from the tags actually
 * present on the returned courses, not a hardcoded list that could drift
 * from what a course declares.
 *
 * Kept out of page.tsx so it is testable without a server component or a
 * browser — the same split as src/lib/home.ts.
 */

/** The minimal shape either function needs — anything with a `tags` array. */
export interface Taggable {
  tags: readonly string[];
}

/**
 * The distinct tags across a course list, sorted for a stable render order
 * (locale-aware so the chip row doesn't reorder itself between runs).
 */
export function catalogTags(courses: readonly Taggable[]): string[] {
  const tags = new Set<string>();
  for (const course of courses) {
    for (const tag of course.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Courses whose `tags` include `tag`, or every course when `tag` is `null`
 * (the "All courses" chip). A `tag` naming nothing any course carries — a
 * hand-typed URL, or a tag whose last course was just retagged — narrows to
 * an empty list rather than throwing; the page renders that as a distinct
 * empty state from "no courses at all".
 */
export function filterCoursesByTag<T extends Taggable>(courses: readonly T[], tag: string | null): T[] {
  if (tag === null) return [...courses];
  return courses.filter((course) => course.tags.includes(tag));
}
