import { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchProfile } from '../../../src/lib/api';
import type { Profile } from '../../../src/lib/api';
import Avatar from '../../_shell/Avatar';
import { anySectionHasContent, sectionHasContent } from '../../../src/lib/profile-sections';
import Heatmap from '../../me/Heatmap';
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
 * Two viewer-dependent details are worth stating:
 *
 *  - `noindex` is per student and defaults to on. It becomes the page's
 *    robots meta below, not a suggestion in a comment.
 *  - Feed entries link into a lesson ONLY when the API sent a lesson slug,
 *    which it does not do for an anonymous reader (§12: lesson content is
 *    always behind login). So the anonymous page cannot link into content
 *    even if this component forgot — but it does not forget either.
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

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  if (!profile) notFound();

  const { sections } = profile;
  const name = displayNameOf(profile);
  /*
   * "Nothing to show" now means no section with CONTENT, not no section
   * shared. A present-but-empty section renders nothing at all — a new
   * account used to show four headings in a row, each apologising for having
   * nothing under it, which says nothing about the person and pushes
   * whatever they do have below the fold.
   */
  const empty = !anySectionHasContent(sections);

  return (
    <main className={styles.page}>
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

      {sectionHasContent(sections, 'badges') ? (
        <section className={styles.section} aria-labelledby="profile-badges">
          <h2 className={styles.sectionTitle} id="profile-badges">
            Badges
          </h2>
          <ul className={styles.badgeList}>
            {sections.badges?.map((badge) => (
              <li className={styles.badge} key={badge.slug}>
                <span className={styles.badgeTitle}>{badge.title}</span>
                {badge.description ? <span className={styles.badgeDescription}>{badge.description}</span> : null}
                {badge.awardedAt ? (
                  <span className={styles.badgeDate}>Earned {formatDate(badge.awardedAt)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sectionHasContent(sections, 'degrees') ? (
        <section className={styles.section} aria-labelledby="profile-degrees">
          <h2 className={styles.sectionTitle} id="profile-degrees">
            Degrees
          </h2>
          <ul className={styles.degreeList}>
            {sections.degrees?.map((degree) => (
              <li className={styles.degree} key={degree.slug}>
                <span className={styles.degreeTitle}>{degree.title}</span>
                <span className={styles.degreeState}>
                  {degree.earned ? `Earned${degree.awardedAt ? ` ${formatDate(degree.awardedAt)}` : ''}` : 'In progress'}
                </span>
                {/* The number is written out, not left to the bar: a
                    colour-only progress indicator is unreadable for a
                    significant number of people (design §10/§14). */}
                <span className={styles.degreePercent}>{degree.percent}%</span>
                <span
                  className={styles.degreeBar}
                  role="img"
                  aria-label={`${degree.percent}% complete`}
                  style={{ ['--degree-percent' as string]: `${degree.percent}%` }}
                />
              </li>
            ))}
          </ul>
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
    </main>
  );
}
