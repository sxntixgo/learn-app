import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchCourse, fetchCourseProgress } from '../../../src/lib/api';
import styles from './course.module.css';

export default async function CoursePage({
  params,
}: {
  params: Promise<{ courseSlug: string }>;
}) {
  const { courseSlug } = await params;
  const [course, progress] = await Promise.all([fetchCourse(courseSlug), fetchCourseProgress(courseSlug)]);

  if (!course) {
    notFound();
  }

  // Keyed by slug, not by module: CourseProgressSummary.lessons is a flat
  // list across the whole course, same as the join it's read from.
  const lessonStates = new Map((progress?.lessons ?? []).map((l) => [l.slug, l.state]));

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{course.title}</h1>
      {course.subtitle ? <p className={styles.subtitle}>{course.subtitle}</p> : null}
      {course.description ? <p className={styles.description}>{course.description}</p> : null}

      {progress && progress.totalLessons > 0 ? (
        <div className={styles.progressSummary}>
          <div className={styles.progressText}>
            <span className={styles.progressLabel}>Progress</span>
            <span className={styles.progressValue}>
              {progress.completedLessons} / {progress.totalLessons} lessons complete ({progress.percent}%)
            </span>
          </div>
          <div
            className={styles.progressBar}
            role="img"
            aria-label={`${progress.percent} percent of lessons complete`}
          >
            <div className={styles.progressBarFill} style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      ) : null}

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
                  {mod.lessons.map((lesson) => {
                    const complete = lessonStates.get(lesson.slug) === 'complete';
                    return (
                      <li key={lesson.slug}>
                        <Link
                          href={`/courses/${encodeURIComponent(course.slug)}/lessons/${encodeURIComponent(lesson.slug)}`}
                          className={styles.lessonRow}
                          data-complete={complete ? 'true' : undefined}
                        >
                          <span className={styles.lessonTitle}>{lesson.title}</span>
                          <span className={styles.lessonMeta}>
                            {lesson.kind !== 'lesson' ? <span>{lesson.kind}</span> : null}
                            {lesson.estimateMinutes !== null ? <span>{lesson.estimateMinutes} min</span> : null}
                            {complete ? <span className={styles.lessonDone}>Done</span> : null}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
