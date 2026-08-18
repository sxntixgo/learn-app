'use client';

/*
 * The award animation (design §9.3).
 *
 *   "Evaluation is synchronous on every progress write ... so the award
 *    animation fires the moment you finish, which is the entire point."
 *
 * Which is why this takes an `AwardNotice` straight off the write's own
 * response rather than re-fetching /api/v1/me/badges: the news is already in
 * the reply to the request the reader just made. The API returns only what
 * THIS write earned (`on conflict do nothing` — the losing request of a race
 * reports nothing), so rendering whatever arrives is correct without this
 * component tracking what it has already shown.
 *
 * Three accessibility rules, all load-bearing:
 *
 *   1. `prefers-reduced-motion: reduce` removes the motion, not the message
 *      — see awards.module.css. The panel still appears; it just does not
 *      travel or scale.
 *   2. The announcement is `role="status"` (polite), so a screen reader is
 *      told without having the reader's place interrupted.
 *   3. Nothing here is dismissible-only-by-hover and nothing disappears on a
 *      timer: an award that vanished before it was read would be an award
 *      the reader never got.
 */

import type { AwardNotice } from '../../../../../src/lib/api';
import { announceAwards } from '../../../../../src/lib/badges';
import styles from './awards.module.css';

export interface AwardAnnouncementProps {
  awarded: AwardNotice | undefined;
}

export default function AwardAnnouncement({ awarded }: AwardAnnouncementProps) {
  const announcement = awarded === undefined ? null : announceAwards(awarded);
  // No live region at all when nothing was earned — an empty one is
  // announced as a change by some readers.
  if (awarded === undefined || announcement === null) return null;

  return (
    <div className={styles.panel} role="status">
      <p className={styles.announcement}>{announcement}</p>
      <ul className={styles.list}>
        {awarded.badges.map((badge) => (
          <li key={`badge-${badge.slug}`} className={styles.item}>
            <span className={styles.seal} aria-hidden="true" />
            <span className={styles.kind}>Badge</span>
            <span className={styles.name}>{badge.title}</span>
          </li>
        ))}
        {awarded.degrees.map((degree) => (
          <li key={`degree-${degree.slug}`} className={styles.item}>
            <span className={styles.seal} aria-hidden="true" />
            <span className={styles.kind}>Degree</span>
            <span className={styles.name}>{degree.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
