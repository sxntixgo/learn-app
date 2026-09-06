/*
 * The student's recent activity feed (design §10) — the left column of M1's
 * band and the third block of P2. Purely presentational — no interaction, so
 * this stays a server component (unlike Heatmap.tsx, which needs client
 * state for the roving tab stop). All formatting logic lives in
 * src/lib/activity.ts so it can be unit-tested without a browser.
 *
 * THE DOT IS THE ONE THING THE IMPORT ADDED. Both artboards draw a small
 * coloured disc at the head of each row, in three tones rather than one per
 * event type; `src/lib/home.ts`'s `activityDot` is where an event type maps
 * onto one. It is `aria-hidden` — the row's own sentence already says what
 * happened, and a colour that repeats the text is decoration.
 */

import Link from 'next/link';
import type { ActivityEvent } from '../../src/lib/api';
import { formatActivityLine, formatOccurredAt } from '../../src/lib/activity';
import { activityDot } from '../../src/lib/home';
import styles from './activity-feed.module.css';

export interface ActivityFeedProps {
  events: ActivityEvent[];
  /** The actor's effective IANA timezone (heatmap.timezone) — never UTC-by-default or the server's zone. */
  timezone: string;
}

export default function ActivityFeed({ events, timezone }: ActivityFeedProps) {
  if (events.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing here yet. Complete a lesson, submit an exercise, or pass a quiz, and it will show up in this feed.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {events.map((event, index) => {
        const { text, href } = formatActivityLine(event);
        const { absolute, iso, relative } = formatOccurredAt(event.occurredAt, timezone);
        return (
          <li key={`${event.occurredAt}-${event.type}-${index}`} className={styles.item}>
            <span className={styles.dot} data-tone={activityDot(event.type)} aria-hidden="true" />
            <p className={styles.line}>{href ? <Link href={href}>{text}</Link> : text}</p>
            <time className={styles.time} dateTime={iso}>
              {absolute}
              <span className={styles.relative}> · {relative}</span>
            </time>
          </li>
        );
      })}
    </ol>
  );
}
