import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AuthRequiredError,
  fetchActivity,
  fetchCourse,
  fetchCourseProgress,
  fetchHeatmap,
  fetchMeOrNull,
  fetchMyCourses,
  fetchMyDegrees,
} from '../../src/lib/api';
import type { ActivityEvent, DegreeProgress, EnrolledCourse } from '../../src/lib/api';
import { withAuthRedirect } from '../../src/lib/require-auth';
import { activityThisWeek, pickCurrentCourse, pickDegree, planCourse, type CoursePlan } from '../../src/lib/home';
import ActivityFeed from './ActivityFeed';
import CourseList from './CourseList';
import DegreePanel from './DegreePanel';
import ResumeBanner, { type HomeStat } from './ResumeBanner';
import UpNext from './UpNext';
import styles from './me.module.css';

export const metadata: Metadata = {
  title: 'Home — Learn App',
};

/**
 * How many events the feed shows.
 *
 * It was 50 while the feed WAS the page. It is one of six blocks now
 * (docs/design/2026-09-02-artboard-spec.md §6), and M1 draws five rows, so
 * fifty would push Your courses off the bottom of every screen the design
 * was drawn at. Ten keeps a couple of days of a normal week visible without
 * the section becoming the page again; the full history is the profile's
 * feed, which is where §11 puts it.
 */
const FEED_LIMIT = 10;

/**
 * How many lessons "Up next" lists, INCLUDING the one the banner resumes.
 *
 * Both artboards draw two. The banner's lesson is the first of them on
 * purpose — P2 numbers its first Up next row `06` and its banner says
 * "Next up: The Base Case", the same lesson — so this is "the next two
 * things", not "the two things after the next thing".
 */
const UP_NEXT_COUNT = 2;

/**
 * The trailing heatmap window this page asks for.
 *
 * Two weeks, not the 53 the profile fetches. The only two things Home reads
 * off this response are `currentStreak` (computed fresh from
 * activity_events, so the window does not affect it) and the last seven
 * days' counts — see `activityThisWeek` in src/lib/home.ts. The API clamps
 * `weeks` to [1, 53]; asking for the whole year here would be a year of
 * day rows fetched to add up seven of them.
 */
const STREAK_WEEKS = 2;

/*
 * HOME (M1 / P2) — the merged screen.
 *
 * WHAT THIS PAGE IS. Phase 0 of the design import found that the artboards
 * move the information architecture and not just the paint: "Dashboard is
 * gone as a destination and Home takes its place — resume, streak, activity
 * feed, up next and degree progress, in one place, with the three courses
 * you're actually enrolled in at the bottom"
 * (docs/design/2026-09-02-artboard-spec.md §2). Phase 2 landed the nav half
 * of that — §7 Q1 answered as option (a), so `/me` IS Home and no route
 * moved. This file is the content half.
 *
 * WHAT WAS HERE BEFORE, AND WHERE IT WENT. Everything: the activity feed
 * and its timezone note stay (the feed as the band's left column, the note
 * moved up under the banner where M1 draws it), and the "your badges,
 * degrees and activity grid are on your profile" link stays at the foot.
 * The heatmap, badge shelf and degree list had already moved to
 * /u/{handle} in an earlier phase and are not coming back — putting them
 * here is the duplication the redesign removed.
 *
 * WHAT IT COSTS. Six requests plus two per enrolled course. The two are
 * unavoidable and neither is new: `/me/courses` says which courses and how
 * far through, but not WHICH LESSON IS NEXT, and answering that needs the
 * course's own manifest order (`/courses/{slug}`) and the actor's per-lesson
 * state (`/courses/{slug}/progress`). Neither route is rate-limited (only
 * `/profiles/{handle}` and login are — api/src/auth/), and they go out in
 * parallel. The alternative was a seventh endpoint, and adding one is a
 * scope decision for a human, not for this task.
 */
export default async function HomePage() {
  const { me, activity, degrees, streak, weekEvents, plans } = await withAuthRedirect('/me', loadHome);

  const timezone = me?.timezone ?? 'UTC';
  const timezoneIsDefault = me?.timezoneSource !== 'set';
  const current = pickCurrentCourse(plans, activity);
  const degree = pickDegree(degrees);
  const lessonsComplete = plans.reduce((sum, p) => sum + p.completedLessons, 0);
  const lessonsTotal = plans.reduce((sum, p) => sum + p.totalLessons, 0);
  // The banner's percent is the course you are resuming. With nothing to
  // resume it is everything you are enrolled in, which is 0 for a new
  // account and 100 for someone who has finished — both true, and neither
  // is the 0 that "no current course" would otherwise print.
  const percent = current?.percent ?? (lessonsTotal > 0 ? Math.round((lessonsComplete / lessonsTotal) * 100) : 0);

  /*
   * The banner's statistics. M1 draws two (streak, this week) and P2 draws
   * three tiles; the same three render at both tiers so neither can be the
   * one that quietly lost a number.
   *
   * "THIS WEEK" IS NOT THE ARTBOARD'S "3h 40m" — see `activityThisWeek` in
   * src/lib/home.ts. Nothing in the API measures time, so the slot answers
   * the same question with the events it can actually count. P2's third
   * tile is BADGES, which is not rendered: badges are the profile's
   * (PL9/P9, Phase 4), the count would be a seventh request on every Home
   * render, and M1 — the artboard this task is accepted against — has no
   * badge count at all.
   */
  const stats: HomeStat[] = [
    { label: 'Streak', value: String(streak), description: `${streak} day${streak === 1 ? '' : 's'} in a row` },
    { label: 'This week', value: String(weekEvents), description: 'things done in the last seven days' },
    { label: 'Lessons', value: String(lessonsComplete), description: 'lessons finished across your courses' },
  ];

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Home</h1>

      <ResumeBanner current={current} percent={percent} stats={stats} />

      {/* Unobtrusive by design: a note, not a call to action, and never a picker. */}
      {timezoneIsDefault ? (
        <p className={styles.timezoneNote}>
          Times are shown in UTC because this account has no timezone set, so a late-night session can look like the
          next day. Setting a timezone on your account moves them to where you actually are.
        </p>
      ) : (
        <p className={styles.timezoneNote}>Times shown in {timezone}.</p>
      )}

      <div className={styles.band}>
        <section className={styles.feed} aria-labelledby="feed-heading">
          <h2 className={styles.sectionTitle} id="feed-heading">
            Recent activity
          </h2>
          <ActivityFeed events={activity} timezone={timezone} />
        </section>

        {/*
          * Three grid children, not two: at narrow tier P2 puts Up next
          * ABOVE the feed and the degree card BELOW it, so wrapping the
          * latter two in an aside would make that order unreachable. The
          * areas are named in me.module.css.
          */}
        <UpNext lessons={current?.upcoming ?? []} />
        {degree ? <DegreePanel degree={degree} /> : null}
      </div>

      <CourseList courses={plans} />

      {/*
       * Where the rest of it went. Badges, degrees and the heatmap are on
       * the profile, and without this line the only route to them is a menu
       * the reader has to think to open.
       */}
      {me?.hasProfile && me.handle ? (
        <p className={styles.profileLinkRow}>
          <Link className={styles.profileLink} href={`/u/${me.handle}`}>
            Your badges, degrees and activity grid are on your profile
          </Link>
        </p>
      ) : null}
    </main>
  );
}

interface HomeData {
  me: Awaited<ReturnType<typeof fetchMeOrNull>>;
  activity: ActivityEvent[];
  degrees: DegreeProgress[];
  streak: number;
  weekEvents: number;
  plans: CoursePlan[];
}

/**
 * Two rounds, not one: the per-course requests cannot be issued until
 * `/me/courses` has said which courses there are. Everything inside each
 * round goes out together.
 */
async function loadHome(): Promise<HomeData> {
  const [me, activity, enrolled, heatmap, degrees] = await Promise.all([
    fetchMeOrNull(),
    fetchActivity(FEED_LIMIT),
    fetchMyCourses(),
    fetchHeatmap(STREAK_WEEKS),
    fetchMyDegrees(),
  ]);

  const plans = await planEnrolled(enrolled);

  return {
    me,
    activity,
    degrees,
    streak: heatmap.currentStreak,
    weekEvents: activityThisWeek(heatmap.days),
    plans,
  };
}

/** Every enrolled course, folded together with its manifest order and the actor's place in it. */
async function planEnrolled(enrolled: EnrolledCourse[]): Promise<CoursePlan[]> {
  return Promise.all(
    enrolled.map(async (course) => {
      const [detail, progress] = await Promise.all([
        orNull(() => fetchCourse(course.slug)),
        orNull(() => fetchCourseProgress(course.slug)),
      ]);
      return planCourse(course, detail, progress, UP_NEXT_COUNT);
    }),
  );
}

/**
 * ONE UNREADABLE COURSE MUST NOT TAKE HOME DOWN.
 *
 * `/me/courses` lists an enrolment; `/courses/{slug}` can still refuse it —
 * a course made `hidden` after enrolment 404s for a student (design §12),
 * and `can()` answers 403 rather than 404 wherever "may not ask" is the
 * truer answer. Either would otherwise propagate through
 * `withAuthRedirect`, which reads a 403 as "this page is not for you" and
 * sends the reader to /no-access — for a screen that is entirely for them,
 * because one row of six could not be filled in.
 *
 * So the row degrades: no manifest means no next lesson and no module line,
 * and `planCourse` already renders that state. The count and percent still
 * come from `/me/courses`, which answered.
 */
async function orNull<T>(load: () => Promise<T | null>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  }
}
