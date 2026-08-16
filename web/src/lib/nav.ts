/*
 * App-shell navigation data (design §14.2, plan phase 4). Destinations and
 * "am I the active one" both live here, out of the Nav component, so the
 * matching rule is testable without a browser.
 *
 * Three destinations: Catalog, Dashboard, and Admin (plan phase 5's import
 * screen — design §14 item 6). Admin's label doubles as its own "clearly
 * marked as admin" marker (design brief); do not add more admin
 * destinations here ahead of the phase that builds their pages (CLAUDE.md:
 * build only the phase you were asked for).
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
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/', label: 'Catalog', activePrefixes: ['/courses'] },
  { href: '/me', label: 'Dashboard' },
  { href: '/admin/imports', label: 'Admin' },
];

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
