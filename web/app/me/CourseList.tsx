/*
 * "Your courses" — the numbered rows at the foot of M1 and P2, with the
 * `BROWSE CATALOG →` link on the section rule.
 *
 * The same three courses the wide rail lists under `ENROLLED`, from the same
 * `GET /api/v1/me/courses`. They are listed twice on purpose at wide tier
 * (the rail is chrome that follows you between screens; this is Home saying
 * where you are), and only here at narrow, where the rail's `.enrolled`
 * block is `display: none` precisely so this list is the only one — see
 * app/_shell/nav.module.css and Phase 2's outcome note.
 *
 * The module/next-lesson line is the row's reason to exist rather than a
 * decoration: "Module 2 of 3 · The Base Case is next" is the only place
 * outside the banner that says what opening a course would actually do.
 */

import Link from 'next/link';
import type { CoursePlan } from '../../src/lib/home';
import { twoDigit } from '../../src/lib/home';
import styles from './me.module.css';

export interface CourseListProps {
  courses: readonly CoursePlan[];
}

function subtitleFor(course: CoursePlan): string {
  const parts: string[] = [];
  if (course.next && course.moduleCount > 0) {
    parts.push(`Module ${course.next.moduleNumber} of ${course.moduleCount}`);
    parts.push(`${course.next.lesson.title} is next`);
  } else if (course.totalLessons > 0 && course.completedLessons >= course.totalLessons) {
    parts.push('Every lesson complete');
  } else if (course.moduleCount > 0) {
    parts.push(`${course.moduleCount} ${course.moduleCount === 1 ? 'module' : 'modules'}`);
  }
  return parts.join(' · ');
}

export default function CourseList({ courses }: CourseListProps) {
  return (
    <section className={styles.courses} aria-labelledby="your-courses-heading">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="your-courses-heading">
          Your courses
        </h2>
        <Link className={styles.sectionAction} href="/">
          Browse catalog <span aria-hidden="true">→</span>
        </Link>
      </div>

      {courses.length === 0 ? (
        <p className={styles.coursesEmpty}>
          You are not enrolled in anything yet. Every course on the catalog says what it covers before you join.
        </p>
      ) : (
        <ol className={styles.courseList}>
          {courses.map((course, index) => {
            const subtitle = subtitleFor(course);
            return (
              <li className={styles.courseRow} key={course.slug}>
                <span className={styles.courseNumber} aria-hidden="true">
                  {twoDigit(index + 1)}
                </span>
                <span className={styles.courseBody}>
                  <Link className={styles.courseTitle} href={course.href}>
                    {course.title}
                  </Link>
                  {subtitle ? <span className={styles.courseMeta}>{subtitle}</span> : null}
                </span>
                <span className={styles.courseProgress}>
                  <span className={styles.bar}>
                    <span className={styles.barFill} style={{ width: `${course.percent}%` }} />
                  </span>
                  <span className={styles.courseCount}>
                    {course.completedLessons}/{course.totalLessons}
                    <span className={styles.srOnly}> lessons complete ({course.percent}%)</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
