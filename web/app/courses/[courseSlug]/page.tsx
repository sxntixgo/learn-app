import type { CSSProperties } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchCourse, fetchCourseProgress } from '../../../src/lib/api';
import EnrolButton from './EnrolButton';
import PublishControl from './PublishControl';
import styles from './course.module.css';

// Track hues are structural only (design §14.1) — a chip border here, a
// left-edge rule in the table of contents below. Never a text colour,
// never a fill. The hue name is exactly the `--color-track-*` suffix
// (tokens.css), so this is a lookup, not a mapping table to maintain.
function trackAccentStyle(hue: string): CSSProperties {
  return { '--track-accent': `var(--color-track-${hue})` } as CSSProperties;
}

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

  // Keyed by track key so table-of-contents rows can resolve their track's
  // hue — a lesson only carries the key, not the hue itself.
  const trackHues = new Map(course.tracks.map((t) => [t.key, t.hue]));

  // Task E: visibility is shown to whoever can already see this page at
  // all — a non-owner only ever reaches here for open/restricted (design
  // §12), so the badge is informational for them too, not owner-exclusive.
  // 'open' is the unremarkable default state and stays unbadged.
  const visibilityLabel: Record<string, string> = { restricted: 'Restricted', hidden: 'Hidden — draft' };

  return (
    <main className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{course.title}</h1>
        {course.visibility !== 'open' ? (
          <span className={styles.visibilityBadge} data-visibility={course.visibility}>
            {visibilityLabel[course.visibility]}
          </span>
        ) : null}
      </div>
      {course.subtitle ? <p className={styles.subtitle}>{course.subtitle}</p> : null}
      {course.description ? <p className={styles.description}>{course.description}</p> : null}

      <div className={styles.actions}>
        <EnrolButton courseSlug={course.slug} enrolled={course.enrolled} />
        {course.canPublish ? <PublishControl courseSlug={course.slug} visibility={course.visibility} /> : null}
      </div>

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
            <li
              key={track.key}
              className={styles.track}
              style={trackAccentStyle(track.hue)}
              title={track.blurb ?? undefined}
            >
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
                    const hue = lesson.track ? trackHues.get(lesson.track) : undefined;
                    return (
                      <li key={lesson.slug}>
                        <Link
                          href={`/courses/${encodeURIComponent(course.slug)}/lessons/${encodeURIComponent(lesson.slug)}`}
                          className={styles.lessonRow}
                          data-complete={complete ? 'true' : undefined}
                          data-track={hue ? 'true' : undefined}
                          style={hue ? trackAccentStyle(hue) : undefined}
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
