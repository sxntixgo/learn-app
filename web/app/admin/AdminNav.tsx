import Link from 'next/link';
import styles from './admin-nav.module.css';

/*
 * The link strip shared by the admin screens (design §14 item 6: "Admin —
 * repo list, import run log with errors, invite table"). Phase 13 turns
 * /admin from one page into three, and without this the two new ones would
 * be reachable only by typing the URL.
 *
 * A server component with plain links and no active-state highlighting:
 * marking the current one needs `usePathname`, which would make every admin
 * page pull in a client component for a decoration. The page's own <h1>
 * already says where you are.
 */

const ADMIN_SCREENS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/admin/imports', label: 'Imports' },
  { href: '/admin/people', label: 'People' },
  { href: '/admin/audit', label: 'Audit log' },
  { href: '/invites', label: 'Invitations' },
];

export default function AdminNav({ current }: { current: string }) {
  return (
    <nav className={styles.nav} aria-label="Admin sections">
      <ul className={styles.list}>
        {ADMIN_SCREENS.map((screen) => (
          <li key={screen.href}>
            {screen.href === current ? (
              <span className={styles.currentLink} aria-current="page">
                {screen.label}
              </span>
            ) : (
              <Link className={styles.link} href={screen.href}>
                {screen.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
