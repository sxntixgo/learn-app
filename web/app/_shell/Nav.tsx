'use client';

/*
 * The one nav component for both shapes (design §14.2: "navigation changes
 * shape, not content"). Same markup renders as a fixed bottom tab bar under
 * 768px and a sidebar at/above it — nav.module.css's media queries decide
 * which one is visible, so there is exactly one <nav> landmark and one
 * active-item computation, not two that could drift apart.
 *
 * A client component because the active destination depends on the current
 * pathname (usePathname), which a Server Component in a layout has no way
 * to read. It still renders correctly in the initial server-sent HTML —
 * Next resolves the router context during the SSR pass of client
 * components too — so the active marker is not a post-hydration flash.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { NavAudience } from '../../src/lib/nav';
import { isNavActive, visibleNavDestinations } from '../../src/lib/nav';
import styles from './nav.module.css';

const ICONS: Record<string, React.ReactNode> = {
  '/': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <line x1="7" y1="8.5" x2="17" y2="8.5" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="7" y1="15.5" x2="13" y2="15.5" />
    </svg>
  ),
  '/me': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10" />
      <path d="M12 20V4" />
      <path d="M20 20v-6" />
    </svg>
  ),
  '/grading': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="m8.5 13 2.5 2.5L16 10" />
    </svg>
  ),
  '/invites': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  ),
  '/admin/imports': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 4.5 7v6c0 4 3 6.7 7.5 7.8 4.5-1.1 7.5-3.8 7.5-7.8V7L12 3.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

export default function Nav({ signedIn, audience }: { signedIn: boolean; audience: NavAudience }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Task D: "do not render nav destinations that only work when
  // authenticated." Every current destination requires a session — Catalog
  // included, since course:list denies the anonymous actor outright
  // (api/src/policy/can.ts) — so a signed-out visitor has nothing this nav
  // could usefully point at. TopBar's Sign-in link is the only navigation
  // offered instead.
  if (!signedIn) return null;

  // Design §9.4 / the grading UI brief: "a Grading destination for
  // teachers; do not show it to students." visibleNavDestinations is the
  // one tested place that decision lives (web/src/lib/nav.ts).
  const destinations = visibleNavDestinations(audience);

  return (
    <nav className={styles.nav} data-collapsed={collapsed} aria-label="Primary">
      <button
        type="button"
        className={styles.collapseToggle}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className={styles.collapseIcon} aria-hidden="true">
          {collapsed ? '»' : '«'}
        </span>
        <span className={styles.srOnly}>{collapsed ? 'Expand navigation' : 'Collapse navigation'}</span>
      </button>
      <ul className={styles.list}>
        {destinations.map((destination) => {
          const active = isNavActive(pathname, destination);
          return (
            <li key={destination.href}>
              <Link
                href={destination.href}
                className={styles.link}
                data-active={active}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.icon}>{ICONS[destination.href]}</span>
                <span className={styles.label}>{destination.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
