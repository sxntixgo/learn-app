// =============================================================================
// PER-SECTION PROFILE VISIBILITY (design §11), the deny-by-default half.
//
// db/migrations/0014_profile_visibility.sql stores one row per (user,
// section) that has ever been set. This module is the other half of that
// bargain: an ABSENT row is `private`, and so is a row whose stored value
// this code does not recognise. There is no backfill and no seeding, which
// means a sixth section added next year lands closed for every existing
// account without a single row being written.
//
// The section vocabulary is CLOSED here exactly as it is closed by the
// migration's check constraint and as the action vocabulary is closed in
// policy/can.ts. A string that is not one of the five is not a section — it
// is ignored, never treated as a new one nobody knows how to enforce.
// =============================================================================

/** The five independently toggleable sections of design §11. */
export const PROFILE_SECTIONS = ['badges', 'degrees', 'courses', 'activity_feed', 'activity_heatmap'] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Ordered least-visible first, which is also the order the UI offers them in. */
export const SECTION_VISIBILITIES = ['private', 'signed_in', 'public'] as const;

export type SectionVisibility = (typeof SECTION_VISIBILITIES)[number];

/**
 * Who is looking, relative to the profile's owner.
 *
 * Deliberately NOT a role: §11's control is about distance from the account
 * holder, not about what the viewer is allowed to do elsewhere on the
 * instance. A teacher looking at a student's profile is a `signed_in` viewer
 * like anybody else — the teaching relationship is enforced by
 * `course:students:progress:read`, not by widening a privacy toggle (§5.2:
 * "privacy toggles govern peer visibility, not the teaching relationship").
 */
export type ViewerRelation = 'owner' | 'signed_in' | 'anonymous';

/** The visibility of every section, for one user. */
export type VisibilityMap = Readonly<Record<ProfileSection, SectionVisibility>>;

const SECTION_SET: ReadonlySet<string> = new Set<string>(PROFILE_SECTIONS);
const VISIBILITY_SET: ReadonlySet<string> = new Set<string>(SECTION_VISIBILITIES);

/** True only for one of the five known sections. */
export function isProfileSection(value: unknown): value is ProfileSection {
  return typeof value === 'string' && SECTION_SET.has(value);
}

/** True only for one of the three known visibility values. */
export function isSectionVisibility(value: unknown): value is SectionVisibility {
  return typeof value === 'string' && VISIBILITY_SET.has(value);
}

/**
 * Reads a stored visibility. Anything unrecognised — null, a typo, a value
 * from a future migration this build predates — is `private`. The failure
 * direction is chosen: an unreadable setting closes the section, it does not
 * open it.
 */
export function parseVisibility(value: unknown): SectionVisibility {
  return isSectionVisibility(value) ? value : 'private';
}

/** Builds a fresh all-private map. Null-prototype: rows cannot reach Object.prototype. */
function emptyMap(): Record<ProfileSection, SectionVisibility> {
  const map = Object.create(null) as Record<ProfileSection, SectionVisibility>;
  for (const section of PROFILE_SECTIONS) map[section] = 'private';
  return map;
}

/** Every section private — what a user with no rows at all has. */
export const ALL_PRIVATE: VisibilityMap = Object.freeze(emptyMap());

/** One `profile_section_visibility` row, as it comes back from Postgres. */
export interface VisibilityRow {
  section: string;
  visibility: string;
}

/**
 * Turns the rows a user DOES have into a setting for all five sections.
 *
 * Absent rows stay private, unknown sections are dropped, and unknown values
 * close their section.
 */
export function visibilityMapFrom(rows: readonly VisibilityRow[]): VisibilityMap {
  const map = emptyMap();
  for (const row of rows) {
    if (!isProfileSection(row.section)) continue;
    map[row.section] = parseVisibility(row.visibility);
  }
  return map;
}

/** May `viewer` see a section set to `visibility`? */
export function isSectionVisibleTo(visibility: SectionVisibility, viewer: ViewerRelation): boolean {
  switch (viewer) {
    case 'owner':
      return true;
    case 'signed_in':
      return visibility === 'signed_in' || visibility === 'public';
    case 'anonymous':
      return visibility === 'public';
    default:
      // Unreachable through the type, reachable through a JS caller or a
      // future third relation someone forgets to handle. Denies.
      return false;
  }
}

/** The sections `viewer` may see. The owner always sees all five. */
export function visibleSectionsFor(map: VisibilityMap, viewer: ViewerRelation): ReadonlySet<ProfileSection> {
  const visible = new Set<ProfileSection>();
  for (const section of PROFILE_SECTIONS) {
    if (isSectionVisibleTo(map[section], viewer)) visible.add(section);
  }
  return visible;
}
