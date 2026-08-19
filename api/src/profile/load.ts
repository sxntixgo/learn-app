import type pg from 'pg';
import { buildHeatmapDays } from '../activity/heatmap.ts';
import { computeStreaks, localDateKey } from '../activity/streaks.ts';
import type { StreakEvent } from '../activity/streaks.ts';
import { listDegreeProgress } from '../progression/views.ts';
import { DEFAULT_TIMEZONE } from '../time/timezone.ts';
import type {
  ProfileActivityEvent,
  ProfileBadge,
  ProfileCourse,
  ProfileCourses,
  ProfileDegree,
  ProfileHeatmap,
  ProfileModel,
  ProfileSectionData,
} from './serialize.ts';
import type { ProfileSection, VisibilityMap } from './visibility.ts';
import { visibilityMapFrom } from './visibility.ts';

// =============================================================================
// LOADING a profile from the database (design §11).
//
// The route decides WHICH sections this viewer may see before anything here
// runs, and passes that set in. A section the viewer cannot see is not
// queried at all — an anonymous reader of a default (all-private) profile
// costs exactly two queries, the user row and its visibility rows, and the
// heavy per-section work never starts.
//
// That is an optimization, not the enforcement: profile/serialize.ts asks
// the same question again when it builds the payload, so a caller that over-
// loads on purpose still cannot publish anything.
// =============================================================================

/** Trailing window for a profile heatmap, matching the dashboard's default. */
const HEATMAP_WEEKS = 53;

/** How many feed entries a profile shows. The dashboard's default, too. */
const FEED_LIMIT = 20;

/** The `users` row behind a handle, before any section is loaded. */
export interface ProfileSubject {
  id: string;
  handle: string;
  email: string | null;
  displayName: string | null;
  bio: string | null;
  noindex: boolean;
  joinedAt: Date;
  timezone: string | null;
  /**
   * §5's "Own profile, badges, degrees" row is a STUDENT power, and §5.1 is
   * explicit that an operator account has "no enrollments, no progress, no
   * badges, and no public profile". So an account without the student role
   * has no profile page — the route 404s rather than rendering an empty one,
   * which would confirm the handle exists.
   */
  isStudent: boolean;
}

interface SubjectRow {
  id: string;
  handle: string;
  email: string | null;
  display_name: string | null;
  bio: string | null;
  profile_noindex: boolean;
  created_at: Date;
  timezone: string | null;
  is_student: boolean;
}

/** Finds the account a handle names, or null. Handles are stored lower-case (0005). */
export async function findProfileSubject(client: pg.PoolClient, handle: string): Promise<ProfileSubject | null> {
  const { rows } = await client.query<SubjectRow>(
    `select u.id, u.handle, u.email, u.display_name, u.bio, u.profile_noindex, u.created_at, u.timezone,
            exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role = 'student') as is_student
       from users u
      where u.handle = $1`,
    [handle.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    displayName: row.display_name,
    bio: row.bio,
    noindex: row.profile_noindex,
    joinedAt: row.created_at,
    timezone: row.timezone,
    isStudent: row.is_student,
  };
}

/** Every visibility row this user has. Sections with no row stay private. */
export async function loadVisibility(client: pg.PoolClient, userId: string): Promise<VisibilityMap> {
  const { rows } = await client.query<{ section: string; visibility: string }>(
    'select section, visibility from profile_section_visibility where user_id = $1',
    [userId],
  );
  return visibilityMapFrom(rows);
}

/** Earned badges only. A profile shows what you have, not what you are missing. */
async function loadBadges(client: pg.PoolClient, userId: string): Promise<ProfileBadge[]> {
  const { rows } = await client.query<{
    slug: string;
    title: string;
    description: string | null;
    course_slug: string | null;
    awarded_at: Date;
  }>(
    `select b.slug, b.title, b.description, c.slug as course_slug, ub.awarded_at
       from user_badges ub
       join badges b on b.id = ub.badge_id
       left join courses c on c.id = b.course_id
      where ub.user_id = $1
      order by ub.awarded_at desc`,
    [userId],
  );
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    description: row.description,
    courseSlug: row.course_slug,
    awardedAt: row.awarded_at.toISOString(),
  }));
}

/** §11: "Earned, and progress toward unearned." */
async function loadDegrees(client: pg.PoolClient, userId: string): Promise<ProfileDegree[]> {
  const views = await listDegreeProgress(client, userId);
  return views.map((view) => ({
    slug: view.slug,
    title: view.title,
    description: view.description,
    earned: view.earned,
    awardedAt: view.awardedAt === null ? null : view.awardedAt.toISOString(),
    percent: view.percent,
  }));
}

/**
 * §11: completed and in-progress, SEPARATELY.
 *
 * Scoped to courses the learner is actually enrolled in, and counted over
 * live lessons only — archived lessons and modules are excluded here exactly
 * as they are everywhere else (progression/facts.ts), so "3 of 5" means the
 * same thing on a profile as on the dashboard.
 *
 * A course with zero live lessons cannot be "completed" (0 of 0 is not an
 * achievement), and one with no completed lessons is not yet "in progress" —
 * it is an enrollment, which is not one of the two things §11 publishes.
 */
async function loadCourses(client: pg.PoolClient, userId: string): Promise<ProfileCourses> {
  const { rows } = await client.query<{
    slug: string;
    title: string;
    total_lessons: number;
    completed_lessons: number;
  }>(
    `select c.slug,
            c.title,
            count(l.id)::int                                        as total_lessons,
            count(*) filter (where lp.state = 'complete')::int       as completed_lessons
       from enrollments e
       join courses c on c.id = e.course_id
       left join modules m on m.course_id = c.id and m.archived_at is null
       left join lessons l on l.module_id = m.id and l.archived_at is null
       left join lesson_progress lp on lp.lesson_id = l.id and lp.user_id = $1
      where e.user_id = $1 and e.status = 'active'
      group by c.slug, c.title
      order by c.title`,
    [userId],
  );

  const completed: ProfileCourse[] = [];
  const inProgress: ProfileCourse[] = [];
  for (const row of rows) {
    const course: ProfileCourse = {
      slug: row.slug,
      title: row.title,
      totalLessons: row.total_lessons,
      completedLessons: row.completed_lessons,
    };
    if (course.totalLessons > 0 && course.completedLessons >= course.totalLessons) {
      completed.push(course);
    } else if (course.completedLessons > 0) {
      inProgress.push(course);
    }
  }
  return { completed, inProgress };
}

/** The recent feed (§10), same shape as /api/v1/me/activity. */
async function loadFeed(client: pg.PoolClient, userId: string): Promise<ProfileActivityEvent[]> {
  const { rows } = await client.query<{
    type: string;
    occurred_at: Date;
    course_slug: string | null;
    course_title: string | null;
    lesson_slug: string | null;
    lesson_title: string | null;
  }>(
    `select ae.type, ae.occurred_at,
            c.slug as course_slug, c.title as course_title,
            l.slug as lesson_slug, l.title as lesson_title
       from activity_events ae
       left join courses c on c.id = ae.course_id
       left join lessons l on l.id = ae.lesson_id
      where ae.user_id = $1
      order by ae.occurred_at desc
      limit $2`,
    [userId, FEED_LIMIT],
  );

  return rows.map((row) => ({
    type: row.type,
    occurredAt: row.occurred_at.toISOString(),
    course: row.course_slug === null ? null : { slug: row.course_slug, title: row.course_title },
    lesson: row.lesson_slug === null ? null : { slug: row.lesson_slug, title: row.lesson_title },
  }));
}

/**
 * The heatmap (§10), bucketed in the SUBJECT's timezone — the profile shows
 * when that person is at their desk, not when the viewer is.
 */
async function loadHeatmap(client: pg.PoolClient, userId: string, timezone: string): Promise<ProfileHeatmap> {
  const now = new Date();
  const todayKey = localDateKey(now, timezone);
  const windowStartKey = localDateKey(new Date(now.getTime() - HEATMAP_WEEKS * 7 * 24 * 60 * 60 * 1000), timezone);

  const counts = await client.query<{ local_date: string; cnt: string }>(
    `select (occurred_at at time zone $2)::date::text as local_date, count(*)::int as cnt
       from activity_events
      where user_id = $1
        and occurred_at >= ($3::date)::timestamp at time zone $2
      group by local_date`,
    [userId, timezone, windowStartKey],
  );

  const days = buildHeatmapDays(new Map(counts.rows.map((r) => [r.local_date, Number(r.cnt)])), HEATMAP_WEEKS, todayKey);

  // Streaks come from the FULL history, not the window: a streak that began
  // before it is still a streak (same reasoning as routes/me.ts).
  const all = await client.query<{ occurred_at: Date }>(
    'select occurred_at from activity_events where user_id = $1 order by occurred_at asc',
    [userId],
  );
  const events: StreakEvent[] = all.rows.map((r) => ({ occurredAt: r.occurred_at }));
  const { current, longest } = computeStreaks(events, timezone, now);

  return {
    timezone,
    days: days.map((day) => ({ date: day.date, count: day.count })),
    maxCount: days.reduce((max, day) => Math.max(max, day.count), 0),
    currentStreak: current,
    longestStreak: longest,
  };
}

/** What a section that was not loaded looks like. Never published — see the header. */
function emptySections(timezone: string): ProfileSectionData {
  return {
    badges: [],
    degrees: [],
    courses: { completed: [], inProgress: [] },
    activity_feed: [],
    activity_heatmap: { timezone, days: [], maxCount: 0, currentStreak: 0, longestStreak: 0 },
  };
}

/**
 * Builds the full model for `subject`, loading only `sections`.
 *
 * One client (not the pool) for the same reason routes/me.ts takes one: the
 * degree view runs several queries in sequence and they must see one
 * consistent snapshot.
 */
export async function loadProfileModel(
  client: pg.PoolClient,
  subject: ProfileSubject,
  visibility: VisibilityMap,
  sections: ReadonlySet<ProfileSection>,
): Promise<ProfileModel> {
  const timezone = subject.timezone ?? DEFAULT_TIMEZONE;
  const data = emptySections(timezone);

  if (sections.has('badges')) data.badges = await loadBadges(client, subject.id);
  if (sections.has('degrees')) data.degrees = await loadDegrees(client, subject.id);
  if (sections.has('courses')) data.courses = await loadCourses(client, subject.id);
  if (sections.has('activity_feed')) data.activity_feed = await loadFeed(client, subject.id);
  if (sections.has('activity_heatmap')) data.activity_heatmap = await loadHeatmap(client, subject.id, timezone);

  return {
    id: subject.id,
    handle: subject.handle,
    email: subject.email,
    displayName: subject.displayName,
    bio: subject.bio,
    joinedAt: subject.joinedAt.toISOString(),
    noindex: subject.noindex,
    visibility,
    sections: data,
  };
}
