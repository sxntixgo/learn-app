/*
 * Persistent top banner (design §14 / CHOSEN-PALETTE): the lighter teal
 * band relative to the page in both modes, same structure as the reference
 * render's brand strip. Present at every width — the tab bar / sidebar
 * below it is what changes shape (design §14.2), not this.
 */

import Link from 'next/link';
import type { ThemePreference } from '../../src/lib/theme';
import type { Me } from '../../src/lib/api';
import ThemeToggle from './ThemeToggle';
import AccountMenu from './AccountMenu';
import AuthControl from './AuthControl';
import styles from './top-bar.module.css';

export default function TopBar({ theme, user }: { theme: ThemePreference; user: Me | null }) {
  return (
    <header className={styles.banner}>
      <Link href="/" className={styles.brand}>
        Learn App
      </Link>
      <div className={styles.controls}>
        {/*
         * Signed in, the theme control lives INSIDE the account menu — it is
         * a personal preference and belongs with the other ones, and the
         * banner had grown into five separate controls. Signed out there is
         * no menu to put it in, so it stays where it was.
         */}
        {user ? (
          <AccountMenu user={user} themeControl={<ThemeToggle current={theme} />} />
        ) : (
          <>
            <ThemeToggle current={theme} />
            <AuthControl user={user} />
          </>
        )}
      </div>
    </header>
  );
}
