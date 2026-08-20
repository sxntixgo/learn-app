import type pg from 'pg';
import type { Actor } from '../policy/can.ts';

/**
 * Full-text search over lessons (design §16, plan Phase 16).
 *
 * THE VISIBILITY RULE IS THE POINT OF THIS MODULE. Search spans courses, so
 * it cannot ask `can()` per course the way a single-course route does — the
 * filter has to happen in SQL, before LIMIT, or ranking and paging would be
 * computed over rows the caller may not see. That makes the WHERE clause
 * below a SECOND expression of `lesson:read`'s rule, and a second expression
 * of a security rule is how private content leaks.
 *
 * Two things hold it to the first one:
 *   1. `visibleCoursePredicate` is written to mirror STUDENT_VISIBLE_OR_OWN
 *      in policy/can.ts line for line — owner first, independent of
 *      visibility; then the visible states.
 *   2. `query.test.ts` asserts the two agree for every combination of
 *      visibility and ownership, so a change to either that does not change
 *      the other fails the suite.
 *
 * Note what this means for roles: §5 grants `lesson:read` to `student` only,
 * and `admin` absorbs the learner roles rather than combining with them, so a
 * teacher-only or admin account matches nothing here. That is not an
 * oversight — roles are a set, and a teacher who also learns holds `student`
 * too. The route still refuses them before reaching this module, because
 * `search:query` carries the same grant as `course:list`.
 */

/** Mirrors STUDENT_VISIBLE_OR_OWN (policy/can.ts): owner first, then the visible states. */
const VISIBLE_COURSE_PREDICATE = `(c.owner_id = $2 or c.visibility in ('open', 'restricted'))`;

/**
 * Sentinels for ts_headline's match markers.
 *
 * The snippet is built from prose that had its HTML tags stripped, so its
 * text can still contain literal `<` and `>` (an escaped entity in the source
 * becomes a real angle bracket once decoded, and authors write `3 < 5`).
 * Emitting `<mark>` directly from Postgres would mean escaping the result
 * afterwards could not tell our markers from the author's characters. So
 * Postgres marks matches with control characters that cannot occur in prose,
 * the whole string is escaped, and only then do the sentinels become tags.
 */
const MARK_START = '';
const MARK_END = '';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface SearchHit {
  lessonSlug: string;
  title: string;
  snippet: string;
}

export interface SearchCourseGroup {
  courseSlug: string;
  courseTitle: string;
  lessons: SearchHit[];
}

export interface SearchResults {
  query: string;
  groups: SearchCourseGroup[];
}

export interface SearchOptions {
  q: string;
  limit?: number;
}

interface SearchRow {
  course_slug: string;
  course_title: string;
  lesson_slug: string;
  title: string;
  snippet: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escape everything, then turn the sentinels into the one tag the contract allows. */
function renderSnippet(raw: string): string {
  return escapeHtml(raw).replaceAll(MARK_START, '<mark>').replaceAll(MARK_END, '</mark>');
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * `websearch_to_tsquery` is deliberate: unlike `to_tsquery` it never raises on
 * whatever a person types into a box — unbalanced quotes, bare operators,
 * punctuation — it just parses what it can. A search box that 500s on an
 * apostrophe is worse than one that returns nothing.
 */
const SEARCH_SQL = `
  with q as (select websearch_to_tsquery('english', $1) as query)
  select c.slug  as course_slug,
         c.title as course_title,
         l.slug  as lesson_slug,
         l.title as title,
         ts_headline(
           'english',
           lesson_prose_text(l.blocks),
           q.query,
           'StartSel=' || $4 || ', StopSel=' || $5 || ', MaxFragments=1, MaxWords=28, MinWords=12, ShortWord=2, HighlightAll=FALSE'
         ) as snippet
    from lessons l
    join modules m on m.id = l.module_id
    join courses c on c.id = l.course_id
    cross join q
   where l.search_vector @@ q.query
     and l.archived_at is null
     and m.archived_at is null
     and ${VISIBLE_COURSE_PREDICATE}
   order by ts_rank(l.search_vector, q.query) desc, l.title asc, l.slug asc
   limit $3
`;

/**
 * Runs a search as `actor`, returning only lessons that actor may read.
 *
 * `actor` is required rather than optional: an overload that could be called
 * without one would make "search everything" the easy mistake to write.
 */
export async function searchLessons(
  pool: pg.Pool,
  actor: Actor,
  options: SearchOptions,
): Promise<SearchResults> {
  const q = options.q ?? '';

  // A blank box is not an error and not "everything" — it is no results.
  // Checked here rather than left to websearch_to_tsquery, which would return
  // an empty tsquery that matches nothing anyway; being explicit means the
  // database is not queried at all for the commonest non-search.
  if (q.trim() === '') {
    return { query: q, groups: [] };
  }

  const { rows } = await pool.query<SearchRow>(SEARCH_SQL, [
    q,
    actor.id,
    clampLimit(options.limit),
    MARK_START,
    MARK_END,
  ]);

  // Group by course, preserving the relevance order the SQL produced: a
  // course first appears at the rank of its best lesson.
  const groups: SearchCourseGroup[] = [];
  const byCourse = new Map<string, SearchCourseGroup>();

  for (const row of rows) {
    let group = byCourse.get(row.course_slug);
    if (!group) {
      group = { courseSlug: row.course_slug, courseTitle: row.course_title, lessons: [] };
      byCourse.set(row.course_slug, group);
      groups.push(group);
    }
    group.lessons.push({
      lessonSlug: row.lesson_slug,
      title: row.title,
      snippet: renderSnippet(row.snippet),
    });
  }

  return { query: q, groups };
}
