import { createHash } from 'node:crypto';
import type { ViewerRelation, VisibilityMap } from './visibility.ts';
import { visibleSectionsFor } from './visibility.ts';

// =============================================================================
// TWO SERIALIZERS, ON PURPOSE (design §11).
//
// A profile response is built from the VIEWER's identity, in the API. Hidden
// sections are absent from the payload — never sent and hidden with CSS,
// because a payload the browser received is a payload the reader can read.
//
// The signed-in serializer FILTERS: it starts from everything this account
// has and keeps the sections the viewer is allowed to see.
//
// The public serializer does NOT. It is an explicit field ALLOWLIST
// (PUBLIC_PROFILE_FIELDS below), and it never touches the model except
// through it. §11: "never 'fetch the object and delete the private keys'. A
// field added next year is invisible until deliberately published. This
// single decision prevents the classic profile-endpoint leak."
//
// The two are indistinguishable — identical bytes — until somebody adds a
// column. serialize.test.ts adds one, which is the only way to test the
// difference and the entire justification for having two functions.
//
// EMAIL. `ProfileModel` carries it because `users.email` exists and the
// loader selects it. No serializer here reads it, for any viewer, ever —
// including the owner, who has /api/v1/me for their own account record.
// =============================================================================

export interface ProfileBadge {
  slug: string;
  title: string;
  description: string | null;
  courseSlug: string | null;
  awardedAt: string | null;
}

export interface ProfileDegree {
  slug: string;
  title: string;
  description: string | null;
  earned: boolean;
  awardedAt: string | null;
  /**
   * 0–100, the same number the learner's own degree screen shows. The
   * per-requirement breakdown that /api/v1/me/degrees returns is deliberately
   * NOT on a profile: which specific courses are missing, and whether a
   * degree is satisfiable at all, is instance curriculum detail rather than
   * something the account holder opted to publish about themselves.
   */
  percent: number;
}

export interface ProfileCourse {
  slug: string;
  title: string;
  totalLessons: number;
  completedLessons: number;
}

/** §11: completed and in-progress are shown SEPARATELY — they reveal different things. */
export interface ProfileCourses {
  completed: ProfileCourse[];
  inProgress: ProfileCourse[];
}

export interface ProfileActivityEvent {
  type: string;
  occurredAt: string;
  course: { slug: string; title: string | null } | null;
  /**
   * `slug` is OPTIONAL because the public serializer drops it (§12: lesson
   * content is always behind login, so nothing on an unauthenticated page may
   * carry a link into it). The loader always sets it; only publicSections
   * leaves it off.
   */
  lesson: { slug?: string; title: string | null } | null;
}

export interface ProfileHeatmap {
  timezone: string;
  days: { date: string; count: number }[];
  maxCount: number;
  currentStreak: number;
  longestStreak: number;
}

/** The data behind each of the five toggleable sections. */
export interface ProfileSectionData {
  badges: ProfileBadge[];
  degrees: ProfileDegree[];
  courses: ProfileCourses;
  activity_feed: ProfileActivityEvent[];
  activity_heatmap: ProfileHeatmap;
}

/** Everything the database knows about a profile — including what is never published. */
export interface ProfileModel {
  id: string;
  handle: string;
  /** Never serialized. Present because the row has it; see the header. */
  email: string | null;
  displayName: string | null;
  bio: string | null;
  joinedAt: string;
  noindex: boolean;
  visibility: VisibilityMap;
  sections: ProfileSectionData;
}

/** The identicon (§11.1). Uploads are out of scope; see the route module. */
export interface ProfileAvatar {
  kind: 'identicon';
  seed: string;
}

/** Sections are OPTIONAL here: a hidden one is absent, not null, not empty. */
export type SerializedSections = {
  badges?: ProfileBadge[];
  degrees?: ProfileDegree[];
  courses?: ProfileCourses;
  activity_feed?: ProfileActivityEvent[];
  activity_heatmap?: ProfileHeatmap;
};

export interface SerializedProfile {
  handle: string;
  displayName: string | null;
  bio: string | null;
  joinedAt: string;
  avatar: ProfileAvatar;
  /** Honoured by the page's robots meta (§11). Needed by every viewer's render. */
  noindex: boolean;
  viewer: ViewerRelation;
  sections: SerializedSections;
  /** Owner only: what the settings screen renders. Absent for everybody else. */
  visibility?: VisibilityMap;
}

/**
 * The identicon seed (§11.1: "derived from the user ID").
 *
 * Hashed rather than passed through, so the public payload does not carry the
 * `users.id` primary key to anonymous readers. Deterministic, so the face
 * never changes; one-way, so the id cannot be read back out of it.
 */
export function avatarSeed(userId: string): string {
  return createHash('sha256').update(`identicon:${userId}`).digest('hex').slice(0, 16);
}

/** Builds the section object for a viewer, omitting everything they may not see. */
function sectionsFor(model: ProfileModel, viewer: ViewerRelation): SerializedSections {
  const visible = visibleSectionsFor(model.visibility, viewer);
  const out: SerializedSections = {};
  if (visible.has('badges')) out.badges = model.sections.badges;
  if (visible.has('degrees')) out.degrees = model.sections.degrees;
  if (visible.has('courses')) out.courses = model.sections.courses;
  if (visible.has('activity_feed')) out.activity_feed = model.sections.activity_feed;
  if (visible.has('activity_heatmap')) out.activity_heatmap = model.sections.activity_heatmap;
  return out;
}

/**
 * The signed-in view: the owner's own profile in full, or another account's
 * `signed_in`/`public` sections.
 *
 * `viewer` is decided by the route from the actor, never by the client.
 */
export function serializeProfileForViewer(model: ProfileModel, viewer: ViewerRelation): SerializedProfile {
  const payload: SerializedProfile = {
    handle: model.handle,
    displayName: model.displayName,
    bio: model.bio,
    joinedAt: model.joinedAt,
    avatar: { kind: 'identicon', seed: avatarSeed(model.id) },
    noindex: model.noindex,
    viewer,
    sections: sectionsFor(model, viewer),
  };
  // The settings themselves are the owner's business: telling a visitor
  // "this section exists and is set to private" is itself a disclosure.
  if (viewer === 'owner') payload.visibility = model.visibility;
  return payload;
}

// -----------------------------------------------------------------------------
// THE ALLOWLIST. Adding a field to `users` does nothing to the public payload
// until its name appears here AND a builder for it appears below. Removing a
// name from this list removes it from the payload — the list is the contract,
// not a documentation comment about one.
// -----------------------------------------------------------------------------

const PUBLIC_FIELD_BUILDERS = {
  handle: (model: ProfileModel) => model.handle,
  displayName: (model: ProfileModel) => model.displayName,
  bio: (model: ProfileModel) => model.bio,
  joinedAt: (model: ProfileModel) => model.joinedAt,
  avatar: (model: ProfileModel): ProfileAvatar => ({ kind: 'identicon', seed: avatarSeed(model.id) }),
  noindex: (model: ProfileModel) => model.noindex,
  viewer: (): ViewerRelation => 'anonymous',
  sections: (model: ProfileModel): SerializedSections => publicSections(model),
} satisfies Record<string, (model: ProfileModel) => unknown>;

/** Every field an unauthenticated reader may see. Nothing else is published. */
export const PUBLIC_PROFILE_FIELDS: readonly string[] = Object.freeze(Object.keys(PUBLIC_FIELD_BUILDERS));

/**
 * §12: "Lesson content always requires authentication... A public course may
 * have a public landing page... The lessons themselves are always behind
 * login." So a public feed entry keeps the course slug — that page exists —
 * and drops the lesson slug, which is the only thing on this payload that
 * could become a link into content. The lesson TITLE stays: it is what the
 * sentence "Completed: Code Review" is made of, and it is the account
 * holder's own opt-in.
 */
function publicActivityEvent(event: ProfileActivityEvent): ProfileActivityEvent {
  return {
    type: event.type,
    occurredAt: event.occurredAt,
    course: event.course === null ? null : { slug: event.course.slug, title: event.course.title },
    lesson: event.lesson === null ? null : { title: event.lesson.title },
  };
}

/** The public sections, each rebuilt field by field rather than passed through. */
function publicSections(model: ProfileModel): SerializedSections {
  const visible = visibleSectionsFor(model.visibility, 'anonymous');
  const out: SerializedSections = {};

  if (visible.has('badges')) {
    out.badges = model.sections.badges.map((badge) => ({
      slug: badge.slug,
      title: badge.title,
      description: badge.description,
      courseSlug: badge.courseSlug,
      awardedAt: badge.awardedAt,
    }));
  }
  if (visible.has('degrees')) {
    out.degrees = model.sections.degrees.map((degree) => ({
      slug: degree.slug,
      title: degree.title,
      description: degree.description,
      earned: degree.earned,
      awardedAt: degree.awardedAt,
      percent: degree.percent,
    }));
  }
  if (visible.has('courses')) {
    const course = (c: ProfileCourse): ProfileCourse => ({
      slug: c.slug,
      title: c.title,
      totalLessons: c.totalLessons,
      completedLessons: c.completedLessons,
    });
    out.courses = {
      completed: model.sections.courses.completed.map(course),
      inProgress: model.sections.courses.inProgress.map(course),
    };
  }
  if (visible.has('activity_feed')) {
    out.activity_feed = model.sections.activity_feed.map(publicActivityEvent);
  }
  if (visible.has('activity_heatmap')) {
    const heatmap = model.sections.activity_heatmap;
    out.activity_heatmap = {
      timezone: heatmap.timezone,
      days: heatmap.days.map((day) => ({ date: day.date, count: day.count })),
      maxCount: heatmap.maxCount,
      currentStreak: heatmap.currentStreak,
      longestStreak: heatmap.longestStreak,
    };
  }
  return out;
}

/**
 * The unauthenticated view. Built by walking the allowlist — the model is
 * never spread, never copied, never filtered.
 */
export function serializePublicProfile(model: ProfileModel): SerializedProfile {
  const payload: Record<string, unknown> = {};
  for (const [field, build] of Object.entries(PUBLIC_FIELD_BUILDERS)) {
    payload[field] = build(model);
  }
  return payload as unknown as SerializedProfile;
}

/** Picks the serializer for `viewer`. The one place that choice is made. */
export function serializeProfile(model: ProfileModel, viewer: ViewerRelation): SerializedProfile {
  return viewer === 'anonymous' ? serializePublicProfile(model) : serializeProfileForViewer(model, viewer);
}
