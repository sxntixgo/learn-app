import type { Metadata } from 'next';
import { fetchActivity, fetchHeatmap } from '../../src/lib/api';
import { withAuthRedirect } from '../../src/lib/require-auth';
import { HEATMAP_MAX_WEEKS } from '../../src/lib/heatmap';
import ActivityFeed from './ActivityFeed';
import Heatmap from './Heatmap';
import styles from './me.module.css';

export const metadata: Metadata = {
  title: 'Your desk — Learn App',
};

function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/*
 * The student's own dashboard. Deliberately narrow in scope: the heatmap,
 * the streaks it is derived from, and the activity feed below it. The app
 * shell and the nav are other people's work (design §10, plan phase 4).
 *
 * The full 53-week window is fetched here, once, on the server. How much of it
 * is visible without scrolling is a CSS decision — see src/lib/heatmap.ts.
 *
 * The feed's timestamps render in `heatmap.timezone` — the same effective
 * IANA zone (design §15: real value, or the UTC fallback when unset) already
 * resolved for the heatmap, rather than a second call to /api/v1/me.
 */
export default async function MePage() {
  const [heatmap, activity] = await withAuthRedirect('/me', () =>
    Promise.all([fetchHeatmap(HEATMAP_MAX_WEEKS), fetchActivity()]),
  );

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Your desk</h1>

      <section className={styles.activity} aria-labelledby="activity-heading">
        <div className={styles.activityHead}>
          <h2 className={styles.sectionTitle} id="activity-heading">
            Activity
          </h2>
          <dl className={styles.streaks}>
            <div className={styles.streak}>
              <dt className={styles.streakLabel}>Current streak</dt>
              <dd className={styles.streakValue}>{days(heatmap.currentStreak)}</dd>
            </div>
            <div className={styles.streak}>
              <dt className={styles.streakLabel}>Longest streak</dt>
              <dd className={styles.streakValue}>{days(heatmap.longestStreak)}</dd>
            </div>
          </dl>
        </div>

        <Heatmap days={heatmap.days} maxCount={heatmap.maxCount} />

        {heatmap.timezoneSource === 'default' ? (
          <p className={styles.timezoneNote}>
            Days are bucketed in UTC because this account has no timezone set, so a late-night session can land on the
            next day. Setting a timezone on your account moves the day boundaries to where you actually are.
          </p>
        ) : (
          <p className={styles.timezoneNote}>Days are counted in {heatmap.timezone}.</p>
        )}
      </section>

      <section className={styles.feed} aria-labelledby="feed-heading">
        <h2 className={styles.sectionTitle} id="feed-heading">
          Recent activity
        </h2>
        <ActivityFeed events={activity} timezone={heatmap.timezone} />
      </section>
    </main>
  );
}
