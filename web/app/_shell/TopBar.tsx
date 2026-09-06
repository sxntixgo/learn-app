/*
 * Persistent top banner (design §14 / CHOSEN-PALETTE): the lighter teal
 * band relative to the page in both modes. Present at every width.
 *
 * WHAT IT HOLDS AFTER THE ARTBOARD IMPORT. The wide artboards have no top
 * bar — the 224px rail runs the full height and carries the logo, the
 * destinations, the enrolled courses and the account control
 * (artboard-spec §6). The account menu moved into the rail with them
 * (see Shell), so what is left here is the brand, and, for a signed-out
 * visitor who has no rail at all, the theme control and the way in.
 *
 * The brand keeps the artboard's mark and, at >= 1024px, is laid out to
 * occupy exactly `--rail-width` against the same teal — so it reads as the
 * top of the rail rather than as a second bar. See top-bar.module.css.
 *
 * AND, BELOW 1024px, THE HAMBURGER. P11 puts three bars at the left of the
 * teal band; there is no rail at that tier and no bottom tab bar any more,
 * so this is the only way to the nav. It renders only when signed in,
 * because Nav renders nothing at all for a signed-out visitor (see Shell) —
 * a control that opens an empty drawer is worse than no control.
 */

import Link from 'next/link';
import type { ThemePreference } from '../../src/lib/theme';
import type { Me } from '../../src/lib/api';
import ThemeToggle from './ThemeToggle';
import AuthControl from './AuthControl';
import { NavDrawerToggle } from './NavDrawer';
import styles from './top-bar.module.css';

export default function TopBar({ theme, user }: { theme: ThemePreference; user: Me | null }) {
  return (
    <header className={styles.banner} data-drawer-inert>
      {user ? <NavDrawerToggle /> : null}
      <Link href="/" className={styles.brand}>
        {/* Decorative: the wordmark beside it is the accessible name. */}
        <span className={styles.mark} aria-hidden="true">
          <span className={styles.markCell} />
          <span className={styles.markCell} />
          <span className={styles.markCell} />
          <span className={styles.markCell} />
        </span>
        Learn App
      </Link>
      {user ? null : (
        <div className={styles.controls}>
          <ThemeToggle current={theme} tone="banner" />
          <AuthControl user={null} />
        </div>
      )}
    </header>
  );
}
