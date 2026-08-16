/*
 * The student's recent activity feed (design §10), below the heatmap on
 * `/me`. Purely presentational — no interaction, so this stays a server
 * component (unlike Heatmap.tsx, which needs client state for the roving
 * tab stop). All formatting logic lives in src/lib/activity.ts so it can be
 * unit-tested without a browser.
 */

import Link from 'next/link';
import type { ActivityEvent } from '../../src/lib/api';
import { formatActivityLine, formatOccurredAt } from '../../src/lib/activity';
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
