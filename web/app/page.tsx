import Link from 'next/link';
import { fetchCourses } from '../src/lib/api';
import { withAuthRedirect } from '../src/lib/require-auth';
import { catalogTags, filterCoursesByTag } from '../src/lib/catalog';
import styles from './page.module.css';

// Task E: the catalog redirects an anonymous visitor to /login rather than
// rendering a signed-out state. This isn't a stricter choice than the API
// makes — `course:list` (api/src/policy/can.ts) has no anonymous case at
// all, so GET /api/v1/courses already 403s for every unauthenticated
// visitor; rendering a partial/empty catalog here would just be hiding that
// answer behind extra UI. It also sidesteps the leak Task E warns about:
// an anonymous "browse" view would need its own filtered fetch to avoid
// showing open-course titles to a visitor who cannot actually open one,
// and redirect-to-login needs none of that.
// NAMED FOR THE SCREEN IT RENDERS. It was `Home()` — harmless while
// "Home" meant nothing in particular, actively misleading since the design
// import made Home a destination of its own at /me (spec §2, §7 Q1). This
// file is Catalog; nothing else changed.
//
// CATALOG (M2/P3) — BROWSING ONLY. Phase 0's merge brief (spec §2): "Catalog
// becomes pure browsing: filters, all five courses, no progress banner, no
// stats." There never was a progress banner or stats block on THIS route —
// `/me` (now Home) carried those, and they stayed there when Home absorbed
// the dashboard (Phase 3's Home task) — so this file has nothing to remove;
// the risk this task guards against is one coming BACK here, which is
// exactly what having it in both places was the redesign's complaint about.
// catalog.spec.ts asserts its absence directly rather than trusting this
// comment.
//
// `?tag=` is the filter. The extracted spec names no field beyond the word
// "filters" — see src/lib/catalog.ts's header for why tags are what this
// reads. It is a GET query param and plain <a> links (like /admin/audit's
// action filter and /search's `?q=`), not a client component: no fetch beats
// a fetch-on-click, and the page works with no JavaScript at all.
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const params = await searchParams;
  const tag = typeof params.tag === 'string' && params.tag !== '' ? params.tag : null;

  const courses = await withAuthRedirect('/', () => fetchCourses());
  const tags = catalogTags(courses);
  const filtered = filterCoursesByTag(courses, tag);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Catalog</h1>
      <p className={styles.intro}>Browse a course to start reading.</p>

      {tags.length > 0 ? (
        <nav className={styles.filters} aria-label="Filter by tag">
          <Link className={styles.filterLink} href="/" data-active={tag === null}>
            All courses
          </Link>
          {tags.map((candidate) => (
            <Link
              key={candidate}
              className={styles.filterLink}
              href={`/?tag=${encodeURIComponent(candidate)}`}
              data-active={tag === candidate}
            >
              {candidate}
            </Link>
          ))}
        </nav>
      ) : null}

      {courses.length === 0 ? (
        <p className={styles.empty}>No courses yet.</p>
      ) : filtered.length === 0 ? (
        <p className={styles.empty}>No courses match this filter.</p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((course) => (
            <li key={course.slug}>
              <Link href={`/courses/${encodeURIComponent(course.slug)}`} className={styles.card}>
                <h2 className={styles.cardTitle}>{course.title}</h2>
                {course.subtitle ? <p className={styles.cardSubtitle}>{course.subtitle}</p> : null}
                <div className={styles.cardMeta}>
                  <span>
                    {course.moduleCount} module{course.moduleCount === 1 ? '' : 's'}
                  </span>
                  <span>
                    {course.lessonCount} lesson{course.lessonCount === 1 ? '' : 's'}
                  </span>
                  {/* Task E: shown to whoever can already see the card at
                      all — a course only appears here (design §12) when it
                      is open/restricted, or when the viewer owns/administers
                      it, so 'open' stays unbadged as the unremarkable
                      default and the other two are informative either way. */}
                  {course.visibility !== 'open' ? (
                    <span className={styles.visibilityBadge} data-visibility={course.visibility}>
                      {course.visibility === 'hidden' ? 'Hidden — draft' : 'Restricted'}
                    </span>
                  ) : null}
                  {course.tags.map((courseTag) => (
                    <span key={courseTag} className={styles.tag}>
                      {courseTag}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
