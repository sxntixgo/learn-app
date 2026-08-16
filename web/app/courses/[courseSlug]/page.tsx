import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchCourse } from '../../../src/lib/api';
import styles from './course.module.css';

export default async function CoursePage({
  params,
}: {
  params: Promise<{ courseSlug: string }>;
}) {
  const { courseSlug } = await params;
  const course = await fetchCourse(courseSlug);

  if (!course) {
    notFound();
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{course.title}</h1>
      {course.subtitle ? <p className={styles.subtitle}>{course.subtitle}</p> : null}
      {course.description ? <p className={styles.description}>{course.description}</p> : null}

      {course.tracks.length > 0 ? (
        <ul className={styles.tracks}>
          {course.tracks.map((track) => (
            <li key={track.key} className={styles.track} title={track.blurb ?? undefined}>
              {track.name}
            </li>
          ))}
        </ul>
      ) : null}

      {course.modules.length === 0 ? (
        <p className={styles.empty}>No modules yet.</p>
      ) : (
        <ol className={styles.moduleList}>
          {course.modules.map((mod) => (
            <li key={mod.key}>
              <h2 className={styles.moduleTitle}>{mod.title}</h2>
              {mod.lessons.length === 0 ? (
                <p className={styles.empty}>No lessons yet.</p>
              ) : (
                <ul className={styles.lessonList}>
                  {mod.lessons.map((lesson) => (
                    <li key={lesson.slug}>
                      <Link
                        href={`/courses/${encodeURIComponent(course.slug)}/lessons/${encodeURIComponent(lesson.slug)}`}
                        className={styles.lessonRow}
                      >
                        <span className={styles.lessonTitle}>{lesson.title}</span>
                        <span className={styles.lessonMeta}>
                          {lesson.kind !== 'lesson' ? <span>{lesson.kind}</span> : null}
                          {lesson.estimateMinutes !== null ? <span>{lesson.estimateMinutes} min</span> : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
