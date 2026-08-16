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
import { isNavActive, NAV_DESTINATIONS } from '../../src/lib/nav';
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
  '/admin/imports': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 4.5 7v6c0 4 3 6.7 7.5 7.8 4.5-1.1 7.5-3.8 7.5-7.8V7L12 3.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

export default function Nav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

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
        {NAV_DESTINATIONS.map((destination) => {
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
