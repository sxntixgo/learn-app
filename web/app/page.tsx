import Link from 'next/link';
import { fetchCourses } from '../src/lib/api';
import { withAuthRedirect } from '../src/lib/require-auth';
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
export default async function Home() {
  const courses = await withAuthRedirect('/', () => fetchCourses());

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Learn App</h1>
      <p className={styles.intro}>Browse a course to start reading.</p>

      {courses.length === 0 ? (
        <p className={styles.empty}>No courses yet.</p>
      ) : (
        <ul className={styles.list}>
          {courses.map((course) => (
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
                  {course.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
