/*
 * App-shell navigation data (design §14.2, plan phase 4). Destinations and
 * "am I the active one" both live here, out of the Nav component, so the
 * matching rule is testable without a browser.
 *
 * Five destinations: Catalog, Search (Phase 16 — design §16's full-text
 * search), Home, Grading (Phase 9 — design §9.4's grading queue), and
 * Admin (plan phase 5's import screen — design §14 item 6). Admin's label
 * doubles as its own "clearly marked as admin" marker (design brief); do
 * not add more admin destinations here ahead of the phase that builds
 * their pages (CLAUDE.md: build only the phase you were asked for).
 *
 * Grading is the one destination that is not for every signed-in visitor —
 * design §9.4/the grading UI brief: "a Grading destination for teachers; do
 * not show it to students." `restrictedToTeacher` marks that, and
 * `visibleNavDestinations` is what a caller filters through before handing
 * the list to <Nav>, so "should a student ever see this link" is answered
 * in one tested place rather than inside JSX.
 *
 * Search is restricted the same way, for a different reason: `search:query`
 * (api/src/policy/can.ts) carries exactly `course:list`'s grant — student
 * only — so a teacher-only or admin account gets a 403 from the API, same
 * as it would from the catalog. Rather than surface that as an in-page
 * permission error, `restrictedToSearch` + `canSearch` hide the entry point
 * from an account that could never use it, the same choice Grading already
 * made for the same underlying reason (a role floor, not a per-resource
 * check).
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
  /**
   * Phase 16. Only visible to an actor who may reach `GET /api/v1/search`
   * at all — `search:query` grants to `student` only, exactly like
   * `course:list` (api/src/policy/can.ts), so a teacher-only or admin
   * account matches nothing and would only ever see a 403. Derived the
   * same way as `restrictedToTeacher`/`restrictedToInviter`: the caller
   * asks the API's own floor rather than checking a role directly, since
   * there is no `roles` field on `Me` (CLAUDE.md rule 1).
   */
  restrictedToSearch?: boolean;
}

/** What the shell knows about the actor, for deciding which destinations to render. */
export interface NavAudience {
  /** Can reach the grading queue (design §9.4). */
  isTeacher: boolean;
  /** Can issue invitations at all — teacher or admin (design §12). */
  canInvite: boolean;
  /** Holds the operator role (design §5.1). */
  isAdmin: boolean;
  /** Can reach search — student only, same grant as `course:list` (design §16). */
  canSearch: boolean;
}

/**
 * THE SIDEBAR: the three places anyone goes every day, in the order they are
 * reached for — where a session starts, then somewhere to browse, then
 * somewhere to look inside what you browsed.
 *
 * Every label here is also the `<h1>` of the page it opens, enforced by
 * nav-labels.test.ts. That is not cosmetic: a sidebar reading "Dashboard"
 * that opens a page headed "Your desk" makes a reader wonder whether they
 * landed where they meant to. Rename one and the test makes you rename the
 * other.
 *
 * HOME LIVES AT `/me` — a documented assumption, not a settled fact.
 * The imported design (docs/design/2026-09-02-artboard-spec.md §2) makes the
 * nav Home · Catalog · Search, and §7 Q1 left open which route Home is.
 * Pending human review this takes option (a): `/me` is relabelled Home and
 * `/` stays Catalog. The reason is that this list was ALREADY in the design's
 * order, so the whole IA change is one label; option (b) — Home at `/`,
 * Catalog moved to a new `/catalog` — reads better as a URL but costs a
 * route, a redirect, and churn through the specs and the PWA manifest for
 * nothing a reader can see. Reversible: it is this line plus the `<h1>` the
 * test binds to it.
 *
 * The label moved in Phase 2; the CONTENT has not. The design also folds the
 * dashboard's resume/streak/activity/up-next/degree panels onto Home and
 * strips Catalog back to browsing — that is Phase 3, and until it lands
 * "Home" opens the activity feed that used to be called Dashboard.
 */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/me', label: 'Home' },
  { href: '/', label: 'Catalog', activePrefixes: ['/courses'] },
  { href: '/search', label: 'Search', restrictedToSearch: true },
];

/**
 * THE ACCOUNT MENU'S "MANAGE" SECTION: the role-gated tools.
 *
 * These used to sit in the sidebar, permanently, beside three everyday
 * destinations — while being reachable by, and relevant to, almost nobody.
 * They are not everyday navigation; they are things you hold a role in order
 * to do, which is what the account menu is already about.
 *
 * They MUST live somewhere, and before this they had no other entry point:
 * `/no-access` links to them but is an error page, and `AdminNav` only
 * appears once you are already inside `/admin`. Removing them from the
 * sidebar without a home would have left three working pages reachable only
 * by typing their URL.
 */
export const MANAGE_DESTINATIONS: readonly NavDestination[] = [
  { href: '/grading', label: 'Grading queue', restrictedToTeacher: true },
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
export function visibleNavDestinations(
  audience: NavAudience,
  // The list is a parameter so the sidebar and the account menu's Manage
  // section share ONE gate. Two copies of this predicate could disagree, and
  // a destination visible in one place but hidden in the other is a
  // permissions bug that looks like a rendering bug.
  destinations: readonly NavDestination[] = NAV_DESTINATIONS,
): readonly NavDestination[] {
  return destinations.filter(
    (destination) =>
      (!destination.restrictedToTeacher || audience.isTeacher) &&
      (!destination.restrictedToInviter || audience.canInvite) &&
      (!destination.restrictedToAdmin || audience.isAdmin) &&
      (!destination.restrictedToSearch || audience.canSearch),
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
