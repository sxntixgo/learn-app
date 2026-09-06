/*
 * "DEGREE PROGRESS" — the tinted card under Up next (M1) and under the feed
 * (P2).
 *
 * The pips are one per course the degree requires, filled for the ones
 * finished; the artboards draw five because the degree they draw names five.
 * They are `aria-hidden` and the sentence below them carries the same fact
 * in words, which is the rule design §10 already applies to the heatmap: a
 * filled shape with no label is not a label.
 *
 * NO LINK, deliberately. The artboards give this card none, and the degree
 * list with its requirements and prerequisites is the profile's (PL9/P9,
 * Phase 4 of the design-import plan) — the "on your profile" line at the
 * foot of Home is the one route there, rather than two.
 */

import type { DegreeProgress } from '../../src/lib/api';
import { degreeTally } from '../../src/lib/home';
import styles from './me.module.css';

export interface DegreePanelProps {
  degree: DegreeProgress;
}

export default function DegreePanel({ degree }: DegreePanelProps) {
  const { complete, total } = degreeTally(degree);
  const pips = Array.from({ length: total }, (_, i) => i < complete);

  return (
    <section className={styles.degree} aria-labelledby="degree-heading">
      <p className={styles.degreeEyebrow}>Degree progress</p>
      <h2 className={styles.degreeTitle} id="degree-heading">
        {degree.title}
      </h2>
      {total > 0 ? (
        <p className={styles.degreePips} aria-hidden="true">
          {/* A pip IS its position in the requirement list; there is no other identity to key on. */}
          {pips.map((filled, i) => (
            <span className={styles.degreePip} data-filled={filled} key={`pip-${i}`} />
          ))}
        </p>
      ) : null}
      <p className={styles.degreeCount}>
        {complete} of {total} {total === 1 ? 'course' : 'courses'} complete
      </p>
    </section>
  );
}
