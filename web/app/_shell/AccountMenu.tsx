'use client';

/*
 * The account menu behind the name in the banner (design §14: quiet).
 *
 * `<details>`/`<summary>` rather than a hand-built menu, for the same reason
 * ThemeToggle is three forms and not a client widget: it is operable by
 * keyboard natively — Enter and Space toggle it, Tab walks its contents — and
 * it works with no JavaScript at all. Nothing here re-implements focus
 * management, roving tabindex, or aria-expanded, because the element already
 * has them.
 *
 * WHAT THE CLIENT JS IS FOR, and it is only this: a `<details>` does not
 * close on Escape or on a click elsewhere, and a menu that stays open when
 * you look away is a menu that covers the page. Both are additive — with
 * scripting off the menu still opens, still navigates, and still closes when
 * you click the summary again.
 *
 * The theme control is passed in as `children` rather than imported: it is a
 * Server Component built from three server actions, and this component is a
 * client one. Passing it through keeps it on the server where it belongs.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import type { Me } from '../../src/lib/api';
import type { NavDestination } from '../../src/lib/nav';
import { logoutAction } from './auth-actions';
import styles from './account-menu.module.css';

export interface AccountMenuProps {
  user: Me;
  /**
   * The role-gated destinations this account may reach, already filtered by
   * TopBar. Empty for most people, and the whole section disappears when it
   * is — an empty "Manage" heading tells a student that tools exist which
   * they may not have, which is a disclosure and a distraction at once.
   */
  manage: readonly NavDestination[];
  /** ThemeToggle, rendered on the server by the parent. */
  themeControl: ReactNode;
}

export default function AccountMenu({ user, manage, themeControl }: AccountMenuProps) {
  const menu = useRef<HTMLDetailsElement>(null);

  /**
   * One way to close it. There were four — the effect's own, and an inline
   * `menu.current!.open = false` on each link, every one of them a non-null
   * assertion that would throw if the ref were ever unset.
   */
  const close = useCallback(() => {
    if (menu.current) menu.current.open = false;
  }, []);

  useEffect(() => {
    const element = menu.current;
    if (!element) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !element.open) return;
      /*
       * STOP HERE, NOT JUST `preventDefault`. When this menu is open inside
       * the narrow-tier drawer, Nav.tsx has its OWN `document` Escape
       * listener with a guard meant to leave this press to the menu:
       * "innermost first... the next [press] finds no open details and
       * closes the drawer." That guard reads `element.querySelector
       * ('details[open]')` at the time IT runs — but both listeners are on
       * the same `document`, and `close()` below has, by then, already set
       * `open = false`. Two listeners on one node fire in registration
       * order, which is an accident of mount timing (this one mounts with
       * the menu, Nav's only when the drawer opens) — not something to
       * depend on. `stopImmediatePropagation` makes the ordering
       * irrelevant: no other `document` keydown listener for this event
       * runs at all, so the drawer's guard never gets a chance to see a
       * closed menu and close itself in the same press.
       */
      event.stopImmediatePropagation();
      close();
      // Focus returns to the control that opened it, which is where a
      // keyboard user expects to be after dismissing a menu.
      element.querySelector('summary')?.focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!element.open) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [close]);

  /*
   * WHICH LINKS APPEAR IS DECIDED BY THE API, not guessed here. `hasProfile`
   * is false for operator accounts — §5.1 gives them no public profile, and
   * /settings/profile is student-only, so offering either to an admin would
   * send them to /no-access. The account screen is safe for everyone: it
   * handles an operator with a plain sentence rather than a redirect.
   */
  const profilePath = user.hasProfile && user.handle ? `/u/${user.handle}` : null;

  return (
    <details className={styles.menu} ref={menu}>
      <summary className={styles.summary}>
        <span className={styles.name}>{user.displayName ?? user.handle ?? 'Account'}</span>
        <span className={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </summary>

      <div className={styles.panel}>
        {profilePath ? (
          <Link className={styles.item} href={profilePath} onClick={close}>
            Your profile
          </Link>
        ) : null}
        {user.hasProfile ? (
          <Link className={styles.item} href="/settings/profile" onClick={close}>
            Profile &amp; visibility
          </Link>
        ) : null}
        <Link className={styles.item} href="/settings/account" onClick={close}>
          Account &amp; password
        </Link>

        {manage.length > 0 ? (
          <div className={styles.section}>
            <span className={styles.sectionLabel} id="account-menu-manage">
              Manage
            </span>
            <div aria-labelledby="account-menu-manage">
              {manage.map((destination) => (
                <Link key={destination.href} className={styles.item} href={destination.href} onClick={close}>
                  {destination.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.section}>
          <span className={styles.sectionLabel} id="account-menu-theme">
            Theme
          </span>
          <div aria-labelledby="account-menu-theme">{themeControl}</div>
        </div>

        <form action={logoutAction} className={styles.signOutForm}>
          <button type="submit" className={styles.signOut}>
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
