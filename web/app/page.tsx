import Link from 'next/link';
import { fetchCourses } from '../src/lib/api';
import styles from './page.module.css';

export default async function Home() {
  const courses = await fetchCourses();

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
