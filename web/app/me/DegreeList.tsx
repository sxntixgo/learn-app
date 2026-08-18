/*
 * Degrees on `/me` (design §9.2: "progress toward unearned degrees is
 * visible").
 *
 * Three states per requirement, each with a PREFIX CHARACTER as well as a
 * border style — done, still to do, and not imported on this instance. The
 * third is design §6.1's cross-repo case: "a degree whose requirements are
 * not all imported shows as unsatisfiable in admin rather than appearing
 * broken to students", so the student is told plainly that a course is not
 * on this instance instead of being shown a requirement they cannot start.
 */

import type { DegreeProgress, DegreeRequirement } from '../../src/lib/api';
import { describeDegreeProgress, formatAwardedAt } from '../../src/lib/badges';
import styles from './badges.module.css';

export interface DegreeListProps {
  degrees: DegreeProgress[];
  timezone: string;
}

function Requirement({ requirement }: { requirement: DegreeRequirement }) {
  if (!requirement.imported) {
    return (
      <li className={styles.reqMissing}>
        <span aria-hidden="true">? </span>
        {requirement.slug} (not on this instance)
      </li>
    );
  }
  return (
    <li className={requirement.completed ? styles.reqDone : styles.reqTodo}>
      <span aria-hidden="true">{requirement.completed ? '✓ ' : '· '}</span>
      {requirement.title ?? requirement.slug}
      <span className={styles.srOnly}>{requirement.completed ? ' — complete' : ' — not complete'}</span>
    </li>
  );
}

export default function DegreeList({ degrees, timezone }: DegreeListProps) {
  if (degrees.length === 0) {
    return (
      <p className={styles.empty}>
        No degrees are declared on this instance yet. A curriculum repo declares them in its course.yaml, and your
        progress toward each one appears here.
      </p>
    );
  }

  return (
    <ul className={styles.degrees}>
      {degrees.map((degree) => {
        const awardedAt = formatAwardedAt(degree.awardedAt, timezone);
        return (
          <li key={degree.slug} className={degree.earned ? styles.degreeEarned : styles.degreeLocked}>
            <div className={styles.degreeHead}>
              <h3 className={styles.degreeTitle}>{degree.title}</h3>
              <p className={styles.status}>
                {degree.earned ? `Earned${awardedAt ? ` · ${awardedAt}` : ''}` : describeDegreeProgress(degree)}
              </p>
            </div>

            {degree.description ? <p className={styles.description}>{degree.description}</p> : null}

            <ul className={styles.requirements}>
              {degree.required.map((requirement) => (
                <Requirement key={`req-${requirement.slug}`} requirement={requirement} />
              ))}
              {degree.electives?.from.map((requirement) => (
                <Requirement key={`elective-${requirement.slug}`} requirement={requirement} />
              ))}
            </ul>

            {degree.satisfiable ? null : (
              <p className={styles.unsatisfiable}>
                {degree.missingCourses.length === 1
                  ? `One course this degree names (${degree.missingCourses[0]}) has not been imported on this instance, so it cannot be completed here yet.`
                  : `${degree.missingCourses.length} courses this degree names have not been imported on this instance, so it cannot be completed here yet.`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
