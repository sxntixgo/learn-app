/*
 * "Up next" — the numbered lessons after the one the resume banner points
 * at (M1's right column, P2's second block).
 *
 * THE EMPHASISED ROW IS THE CHECKPOINT, NOT THE FIRST ONE. Both artboards
 * invert exactly one card, and in both it is the quiz — P2 emphasises row
 * `08` while its row `06` is the very lesson the banner resumes, so the
 * inversion cannot be "the next one". `data-kind` carries it, so the rule
 * lives in CSS with the rest of the treatment.
 */

import Link from 'next/link';
import type { PlannedLesson } from '../../src/lib/home';
import { lessonMeta, twoDigit } from '../../src/lib/home';
import styles from './me.module.css';

export interface UpNextProps {
  lessons: readonly PlannedLesson[];
}

export default function UpNext({ lessons }: UpNextProps) {
  if (lessons.length === 0) return null;

  return (
    <section className={styles.upNext} aria-labelledby="up-next-heading">
      <h2 className={styles.sectionTitle} id="up-next-heading">
        Up next
      </h2>
      <ol className={styles.upNextList}>
        {lessons.map((entry) => (
          <li className={styles.upNextItem} data-kind={entry.lesson.kind} key={entry.lesson.slug}>
            <Link className={styles.upNextLink} href={entry.href}>
              <span className={styles.upNextNumber} aria-hidden="true">
                {twoDigit(entry.number)}
              </span>
              <span className={styles.upNextBody}>
                <span className={styles.upNextTitle}>{entry.lesson.title}</span>
                <span className={styles.upNextMeta}>{lessonMeta(entry.lesson)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
