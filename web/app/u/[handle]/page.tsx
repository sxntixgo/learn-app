import { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchMyBadges, fetchMyDegrees, fetchProfile } from '../../../src/lib/api';
import type { BadgeProgress, DegreeProgress, Profile } from '../../../src/lib/api';
import { AuthRequiredError } from '../../../src/lib/api-errors';
import Avatar from '../../_shell/Avatar';
import { sectionHasContent } from '../../../src/lib/profile-sections';
import BadgesSection, { badgesSectionHasContent } from './BadgesSection';
import DegreesSection, { degreesSectionHasContent } from './DegreesSection';
import Heatmap from './Heatmap';
import styles from './profile.module.css';

/*
 * THE PUBLIC PROFILE PAGE — /u/{handle} (design §11).
 *
 * Everything about what a visitor may see was decided by the API before this
 * file ran. A hidden section is ABSENT from `profile.sections`, so the JSX
 * below renders it only when the key is there; there is no `hidden` class and
 * no client-side filtering anywhere in this tree, because a payload the
 * browser received is a payload the reader can read (§11).
 *
 * Three viewer-dependent details are worth stating:
 *
 *  - `noindex` is per student and defaults to on. It becomes the page's
 *    robots meta below, not a suggestion in a comment.
 *  - Feed entries link into a lesson ONLY when the API sent a lesson slug,
 *    which it does not do for an anonymous reader (§12: lesson content is
 *    always behind login). So the anonymous page cannot link into content
 *    even if this component forgot — but it does not forget either.
 *  - Badges and degrees are richer for the OWNER than for anyone else. PL9/
 *    P9 ("3 OF 9" with locked tiles; "1 IN PROGRESS" with a not-started
 *    degree's prerequisites) is drawn from the owner's own view — this file
 *    fetches `/api/v1/me/badges` and `/api/v1/me/degrees` (already existing,
 *    already tested; no new API surface) exactly when `profile.viewer ===
 *    'owner'`, and BadgesSection/DegreesSection fall back to the public,
 *    earned-only payload for every other viewer. See their file headers for
 *    why the public payload cannot show a locked badge or a prerequisite at
 *    all — it is a real, deliberate gap against the artboard for a
 *    non-owner viewer, not an oversight.
 */

/**
 * One fetch per request, shared between generateMetadata and the page.
 * Without this, every render of this route asks the API twice — and both
 * calls would be counted by the profile rate limiter.
 */
const loadProfile = cache(async (handle: string): Promise<Profile | null> => fetchProfile(handle));

function displayNameOf(profile: Profile): string {
  return profile.displayName ?? profile.handle;
}

/**
 * The Open Graph description (§11: "so a shared badge looks good when pasted
 * into Slack"). Built only from what the viewer's own payload contains, so a
 * crawler — which is anonymous, and therefore gets the public serializer's
 * output — can never be handed something the account holder did not publish.
 */
function summaryOf(profile: Profile): string {
  if (profile.bio) return profile.bio;

  const parts: string[] = [];
  const badges = profile.sections.badges?.length ?? 0;
  const degrees = profile.sections.degrees?.filter((degree) => degree.earned).length ?? 0;
  const completed = profile.sections.courses?.completed.length ?? 0;
  if (badges > 0) parts.push(`${badges} ${badges === 1 ? 'badge' : 'badges'}`);
  if (degrees > 0) parts.push(`${degrees} ${degrees === 1 ? 'degree' : 'degrees'}`);
  if (completed > 0) parts.push(`${completed} ${completed === 1 ? 'course' : 'courses'} completed`);

  return parts.length > 0 ? `${displayNameOf(profile)} — ${parts.join(', ')}.` : `${displayNameOf(profile)} on Learn App.`;
}

/**
 * The absolute URL of this page, built from the request's own host.
 *
 * `og:url` has to be absolute — Slack, and every other unfurler, resolves it
 * against nothing. Taken from the forwarded host rather than an env var so a
 * self-hosted instance does not need one more setting to get its own name
 * right (design §4 puts Caddy in front, which sets these).
 */
async function absoluteUrl(path: string): Promise<string> {
  const store = await headers();
  const host = store.get('x-forwarded-host') ?? store.get('host');
  if (!host) return path;
  const proto = store.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http';
  return `${proto}://${host}${path}`;
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const profile = await loadProfile(handle);

  // A page that does not exist is never indexable either.
  if (!profile) {
    return { title: 'Profile not found — Learn App', robots: { index: false, follow: false } };
  }

  const name = displayNameOf(profile);
  const title = `${name} (@${profile.handle}) — Learn App`;
  const description = summaryOf(profile);

  return {
    title,
    description,
    // §11's per-student toggle, honoured. It defaults to TRUE in the
    // database (migration 0014), so a profile is out of the index until its
    // owner deliberately opts in.
    robots: profile.noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      type: 'profile',
      title,
      description,
      url: await absoluteUrl(`/u/${profile.handle}`),
      siteName: 'Learn App',
    },
    twitter: { card: 'summary', title, description },
  };
}

function formatDate(iso: string): string {
  // UTC, explicitly: a profile's join date is not a timestamp anyone is
  // reading in a hurry, and rendering it in the server's local zone would
  // make it drift between server and client (design §15).
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/**
 * Runs an owner-only loader and turns "not signed in as this account" into
 * `null` instead of a crash. Only ever reached when `profile.viewer ===
 * 'owner'`, so an `AuthRequiredError` here would mean the session expired
 * between the profile fetch and this one — rare, and the safe fallback is
 * the public payload's earned-only view, not a broken page. Same pattern as
 * `orNull` in app/me/page.tsx.
 */
async function ownerOnly<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  }
}

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  if (!profile) notFound();

  const { sections } = profile;
  const name = displayNameOf(profile);

  const [ownerBadges, ownerDegrees]: [BadgeProgress[] | null, DegreeProgress[] | null] =
    profile.viewer === 'owner'
      ? await Promise.all([ownerOnly(fetchMyBadges), ownerOnly(fetchMyDegrees)])
      : [null, null];

  const badgesContent = badgesSectionHasContent({ ownerBadges, publicBadges: sections.badges });
  const degreesContent = degreesSectionHasContent({ ownerDegrees, publicDegrees: sections.degrees });
  /*
   * `Profile` carries no top-level timezone — only `activity_heatmap` does
   * (design §15). That is the best signal available regardless of viewer;
   * a viewer for whom that section is hidden gets UTC, same as `formatDate`
   * below already does for `joinedAt`.
   */
  const timezone = sections.activity_heatmap?.timezone ?? 'UTC';

  /*
   * "Nothing to show" now means no section with CONTENT, not no section
   * shared. A present-but-empty section renders nothing at all — a new
   * account used to show four headings in a row, each apologising for having
   * nothing under it, which says nothing about the person and pushes
   * whatever they do have below the fold. Badges and degrees are asked
   * through their own owner-aware helpers above rather than
   * `anySectionHasContent`, since that function only ever sees the public,
   * earned-only shape.
   */
  const empty =
    !badgesContent &&
    !degreesContent &&
    !sectionHasContent(sections, 'courses') &&
    !sectionHasContent(sections, 'activity_feed') &&
    !sectionHasContent(sections, 'activity_heatmap');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Avatar avatar={profile.avatar} size={96} label={null} />
        <div className={styles.identity}>
          <h1 className={styles.name}>{name}</h1>
          <p className={styles.handle}>@{profile.handle}</p>
          <p className={styles.joined}>Joined {formatDate(profile.joinedAt)}</p>
        </div>
      </header>

      {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}

      {profile.viewer === 'owner' ? (
        <p className={styles.ownerNote}>
          This is your profile, shown to you in full.{' '}
          <Link className={styles.ownerLink} href="/settings/profile">
            Choose what other people see
          </Link>
          .
        </p>
      ) : null}

      {empty ? (
        <p className={styles.empty}>
          {name} hasn’t shared anything on their profile
          {profile.viewer === 'anonymous' ? ' publicly' : ''}.
        </p>
      ) : null}

      {badgesContent ? (
        <section className={styles.section} aria-labelledby="profile-badges">
          <h2 className={styles.sectionTitle} id="profile-badges">
            Badges
          </h2>
          <BadgesSection ownerBadges={ownerBadges} publicBadges={sections.badges} timezone={timezone} />
        </section>
      ) : null}

      {degreesContent ? (
        <section className={styles.section} aria-labelledby="profile-degrees">
          <h2 className={styles.sectionTitle} id="profile-degrees">
            Degrees
          </h2>
          <DegreesSection ownerDegrees={ownerDegrees} publicDegrees={sections.degrees} timezone={timezone} />
        </section>
      ) : null}

      {sectionHasContent(sections, 'courses') ? (
        <section className={styles.section} aria-labelledby="profile-courses">
          <h2 className={styles.sectionTitle} id="profile-courses">
            Courses
          </h2>
          <h3 className={styles.subTitle}>Completed</h3>
          {sections.courses!.completed.length === 0 ? (
            <p className={styles.sectionEmpty}>Nothing completed yet.</p>
          ) : (
            <ul className={styles.courseList}>
              {sections.courses!.completed.map((course) => (
                <li className={styles.course} key={course.slug}>
                  {/* §12: a course has a public landing page; the lessons
                      themselves stay behind login, and this links to the
                      former. */}
                  <Link className={styles.courseLink} href={`/courses/${course.slug}`}>
                    {course.title}
                  </Link>
                  <span className={styles.courseCount}>
                    {course.completedLessons} of {course.totalLessons} lessons
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className={styles.subTitle}>In progress</h3>
          {sections.courses!.inProgress.length === 0 ? (
            <p className={styles.sectionEmpty}>Nothing in progress.</p>
          ) : (
            <ul className={styles.courseList}>
              {sections.courses!.inProgress.map((course) => (
                <li className={styles.course} key={course.slug}>
                  <Link className={styles.courseLink} href={`/courses/${course.slug}`}>
                    {course.title}
                  </Link>
                  <span className={styles.courseCount}>
                    {course.completedLessons} of {course.totalLessons} lessons
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {sections.activity_heatmap ? (
        <section className={styles.section} aria-labelledby="profile-heatmap">
          <h2 className={styles.sectionTitle} id="profile-heatmap">
            Activity
          </h2>
          <Heatmap days={sections.activity_heatmap.days} maxCount={sections.activity_heatmap.maxCount} />
          <p className={styles.streaks}>
            Current streak {sections.activity_heatmap.currentStreak} · longest{' '}
            {sections.activity_heatmap.longestStreak} · times shown in {sections.activity_heatmap.timezone}
          </p>
        </section>
      ) : null}

      {sectionHasContent(sections, 'activity_feed') ? (
        <section className={styles.section} aria-labelledby="profile-feed">
          <h2 className={styles.sectionTitle} id="profile-feed">
            Recent activity
          </h2>
          <ol className={styles.feed}>
            {sections.activity_feed?.map((event, index) => (
              <li className={styles.event} key={`${event.occurredAt}-${index}`}>
                <span className={styles.eventType}>{event.type.replace(/_/g, ' ')}</span>
                <span className={styles.eventWhat}>
                  {event.lesson?.slug && event.course ? (
                    // Only reachable for a signed-in viewer: the API omits
                    // the slug for everyone else (§12).
                    <Link
                      className={styles.eventLink}
                      href={`/courses/${event.course.slug}/lessons/${event.lesson.slug}`}
                    >
                      {event.lesson.title ?? event.lesson.slug}
                    </Link>
                  ) : (
                    (event.lesson?.title ?? event.course?.title ?? '')
                  )}
                </span>
                <time className={styles.eventDate} dateTime={event.occurredAt}>
                  {formatDate(event.occurredAt)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
