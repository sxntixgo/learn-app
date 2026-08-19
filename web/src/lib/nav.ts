/*
 * App-shell navigation data (design §14.2, plan phase 4). Destinations and
 * "am I the active one" both live here, out of the Nav component, so the
 * matching rule is testable without a browser.
 *
 * Four destinations: Catalog, Dashboard, Grading (Phase 9 — design §9.4's
 * grading queue), and Admin (plan phase 5's import screen — design §14 item
 * 6). Admin's label doubles as its own "clearly marked as admin" marker
 * (design brief); do not add more admin destinations here ahead of the
 * phase that builds their pages (CLAUDE.md: build only the phase you were
 * asked for).
 *
 * Grading is the one destination that is not for every signed-in visitor —
 * design §9.4/the grading UI brief: "a Grading destination for teachers; do
 * not show it to students." `restrictedToTeacher` marks that, and
 * `visibleNavDestinations` is what a caller filters through before handing
 * the list to <Nav>, so "should a student ever see this link" is answered
 * in one tested place rather than inside JSX.
 */

export interface NavDestination {
  href: string;
  label: string;
  /**
   * Path prefixes that count as "still under this destination" beyond an
   * exact match — e.g. a lesson reader lives under `/courses/...` but is
   * reached by drilling into the catalog, so Catalog stays marked current
   * while reading one. `/` is never treated as a prefix (see isNavActive):
   * every path starts with `/`, so that would mark Catalog active
   * everywhere.
   */
  activePrefixes?: readonly string[];
  /**
   * When true, only visible to an actor who can reach the grading queue
   * (design §9.4: teachers, scoped to the courses they own). There is no
   * `roles` field on `Me` to check directly (CLAUDE.md rule 1: web has no
   * database access of its own), so the caller derives this from whether
   * `GET /api/v1/grading/queue` — the same role floor the API itself
   * enforces — answered rather than 403'd (see api.ts's `fetchIsTeacher`).
   */
  restrictedToTeacher?: boolean;
  /**
   * Phase 13. Like `restrictedToTeacher`, but for the two roles that can
   * issue invitations at all — a teacher (course invites, plus platform
   * invites from a budget) and an admin (design §12). It cannot reuse
   * `restrictedToTeacher`: admin is EXCLUSIVE of teacher (§5.1), so a flag
   * that means "teacher" would hide the invitations screen from precisely
   * the role §12 builds it for. Derived the same way, from whether the API's
   * own `invite:list` floor answered rather than 403'd (`fetchCanInvite`).
   */
  restrictedToInviter?: boolean;
  /**
   * Admin-only (design §5's last three rows). Shown to students since
   * Phase 5 — /admin/imports has always been admin-gated on the API side,
   * so the link was a promise the API refused to keep, and a student who
   * followed it was bounced to /login while already signed in. Phase 13
   * hangs two more screens off it, which is what made the wart worth
   * fixing rather than living with.
   */
  restrictedToAdmin?: boolean;
}

/** What the shell knows about the actor, for deciding which destinations to render. */
export interface NavAudience {
  /** Can reach the grading queue (design §9.4). */
  isTeacher: boolean;
  /** Can issue invitations at all — teacher or admin (design §12). */
  canInvite: boolean;
  /** Holds the operator role (design §5.1). */
  isAdmin: boolean;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/', label: 'Catalog', activePrefixes: ['/courses'] },
  { href: '/me', label: 'Dashboard' },
  { href: '/grading', label: 'Grading', restrictedToTeacher: true },
  { href: '/invites', label: 'Invitations', restrictedToInviter: true },
  // Phase 13 adds two more admin screens (people, audit) beside the import
  // one, so Admin claims the whole `/admin` prefix rather than only the
  // page it happens to land on.
  { href: '/admin/imports', label: 'Admin', activePrefixes: ['/admin'], restrictedToAdmin: true },
];

/**
 * The destinations an actor should actually see. One tested place for
 * "should this person ever see this link", rather than three conditions
 * inside JSX.
 */
export function visibleNavDestinations(audience: NavAudience): readonly NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (destination) =>
      (!destination.restrictedToTeacher || audience.isTeacher) &&
      (!destination.restrictedToInviter || audience.canInvite) &&
      (!destination.restrictedToAdmin || audience.isAdmin),
  );
}

/**
 * Whether `destination` is the "current" one for `pathname`, for the nav's
 * non-colour active marker (design §14.2 — pair it with a weight/underline
 * change, never colour alone).
 */
export function isNavActive(pathname: string, destination: NavDestination): boolean {
  if (pathname === destination.href) return true;
  if (destination.href !== '/' && pathname.startsWith(`${destination.href}/`)) return true;
  return (destination.activePrefixes ?? []).some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
