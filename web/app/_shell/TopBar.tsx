/*
 * Persistent top banner (design §14 / CHOSEN-PALETTE): the lighter teal
 * band relative to the page in both modes, same structure as the reference
 * render's brand strip. Present at every width — the tab bar / sidebar
 * below it is what changes shape (design §14.2), not this.
 */

import Link from 'next/link';
import type { ThemePreference } from '../../src/lib/theme';
import ThemeToggle from './ThemeToggle';
import styles from './top-bar.module.css';

export default function TopBar({ theme }: { theme: ThemePreference }) {
  return (
    <header className={styles.banner}>
      <Link href="/" className={styles.brand}>
        Learn App
      </Link>
      <ThemeToggle current={theme} />
    </header>
  );
}
