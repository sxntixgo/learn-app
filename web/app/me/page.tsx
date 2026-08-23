import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchActivity, fetchMeOrNull } from '../../src/lib/api';
import { withAuthRedirect } from '../../src/lib/require-auth';
import ActivityFeed from './ActivityFeed';
import styles from './me.module.css';

export const metadata: Metadata = {
  title: 'Your desk — Learn App',
};

/**
 * How many events the feed shows.
 *
 * Higher than the twenty it used to take, because the feed is now the whole
 * page rather than the last panel on it. Still bounded: this is "what have I
 * been doing lately", not an audit log, and the activity_events table is
 * append-only and unbounded.
 */
const FEED_LIMIT = 50;

/*
 * The dashboard: what you have been doing lately, and nothing else.
 *
 * IT USED TO BE THE PROFILE IN DISGUISE. The heatmap, the streaks, the badge
 * shelf and the degree list all lived here AND on /u/{handle}, rendered from
 * the same data — two pages showing the same four things, one of them private
 * and one of them shareable. That is the profile's job, and the profile does
 * it better: it has the avatar, the bio, the join date and the visibility
 * controls to go with them.
 *
 * So the standing answer to "where am I" is the profile, reachable from the
 * account menu, and this page is the running answer to "what did I just do".
 * The two questions wanted different pages and had been sharing one.
 *
 * The timezone comes from /api/v1/me now rather than from the heatmap
 * response — the feed's timestamps still need an effective IANA zone
 * (design §15: the stored value, or UTC when unset), and this page no longer
 * fetches a heatmap to borrow one from.
 */
export default async function MePage() {
  const [me, activity] = await withAuthRedirect('/me', () =>
    Promise.all([fetchMeOrNull(), fetchActivity(FEED_LIMIT)]),
  );

  const timezone = me?.timezone ?? 'UTC';
  const timezoneIsDefault = me?.timezoneSource !== 'set';

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Your desk</h1>

      {/*
       * Where the rest of it went. Badges, degrees and the heatmap are on the
       * profile now, and without this line the only route to them is a menu
       * the reader has to think to open.
       */}
      {me?.hasProfile && me.handle ? (
        <p className={styles.profileLinkRow}>
          <Link className={styles.profileLink} href={`/u/${me.handle}`}>
            Your badges, degrees and activity grid are on your profile
          </Link>
        </p>
      ) : null}

      <section className={styles.feed} aria-labelledby="feed-heading">
        <h2 className={styles.sectionTitle} id="feed-heading">
          Recent activity
        </h2>
        <ActivityFeed events={activity} timezone={timezone} />
        {timezoneIsDefault ? (
          <p className={styles.timezoneNote}>
            Times are shown in UTC because this account has no timezone set, so a late-night session can look like the
            next day. Setting a timezone on your account moves them to where you actually are.
          </p>
        ) : (
          <p className={styles.timezoneNote}>Times are shown in {timezone}.</p>
        )}
      </section>
    </main>
  );
}
