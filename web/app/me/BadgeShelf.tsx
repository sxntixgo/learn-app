/*
 * The badge shelf on `/me` (design §9.3), earned first then locked.
 *
 * EARNED AND LOCKED ARE TOLD APART FOUR WAYS, only one of which is colour
 * (design §14, WCAG 1.4.1 — "never by colour alone"):
 *
 *   1. A visible status WORD on every card ("Earned" / "Locked").
 *   2. A different border: solid for earned, dashed for locked.
 *   3. A different mark: a filled seal for earned, an open ring for locked.
 *   4. Different content: earned cards carry an award date, locked cards a
 *      progress bar with a counted sentence beside it.
 *
 * Purely presentational, so it stays a server component. All formatting is in
 * src/lib/badges.ts, tested without a browser.
 */

import type { BadgeProgress } from '../../src/lib/api';
import { badgeStatusLabel, describeProgress, formatAwardedAt } from '../../src/lib/badges';
import styles from './badges.module.css';

export interface BadgeShelfProps {
  badges: BadgeProgress[];
  /** The actor's effective IANA timezone (design §15) — award dates render in it, never the server's. */
  timezone: string;
}

export default function BadgeShelf({ badges, timezone }: BadgeShelfProps) {
  if (badges.length === 0) {
    return (
      <p className={styles.empty}>
        No badges are defined on this instance yet. When a curriculum repo declares one — or an admin creates one —
        it appears here with your progress toward it.
      </p>
    );
  }

  return (
    <ul className={styles.grid}>
      {badges.map((badge) => {
        const awardedAt = formatAwardedAt(badge.awardedAt, timezone);
        return (
          <li key={badge.slug} className={badge.earned ? styles.cardEarned : styles.cardLocked}>
            <div className={styles.head}>
              {/* Decorative: the status is already stated in words below, so
                  announcing the glyph too would be a duplicate. */}
              <span className={badge.earned ? styles.sealEarned : styles.sealLocked} aria-hidden="true" />
              <h3 className={styles.title}>{badge.title}</h3>
            </div>

            <p className={styles.status}>{badgeStatusLabel(badge)}</p>

            {badge.description ? <p className={styles.description}>{badge.description}</p> : null}

            {badge.earned ? (
              awardedAt !== null ? (
                <p className={styles.awarded}>
                  <time dateTime={badge.awardedAt ?? undefined}>{awardedAt}</time>
                </p>
              ) : null
            ) : (
              <div className={styles.progress}>
                {/*
                 * The bar is `aria-hidden` and the sentence beside it is the
                 * accessible answer: a bar announces a number without a unit,
                 * and "3 of 5 lessons" is what the reader actually wants.
                 */}
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fill} style={{ width: `${badge.progress.percent}%` }} />
                </div>
                <p className={styles.count}>{describeProgress(badge.progress)}</p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
