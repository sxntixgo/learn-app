'use client';

/*
 * THE NARROW-TIER NAV DRAWER'S STATE, and the hamburger that opens it
 * (artboard P11 — "Account & password, and the nav drawer").
 *
 * Why a context rather than local state in one component: the trigger and
 * the drawer are in different parts of the shell. The hamburger sits in the
 * banner (TopBar, a Server Component) and the drawer IS the one `<nav>`
 * (Nav, a Client Component) — there is exactly one nav landmark at every
 * width, so the drawer cannot be a second copy of it that lives next to its
 * own button. A tiny provider around both is the cheapest thing that lets
 * them share one boolean without duplicating a single link.
 *
 * The provider is a Client Component wrapping Server Components as
 * `children`; that keeps TopBar, Footer and the page itself on the server —
 * only the hamburger and Nav hydrate.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import styles from './nav-drawer.module.css';

/** `aria-controls` on the hamburger, and the id on the `<nav>` it opens. */
export const NAV_DRAWER_ID = 'primary-nav';

interface NavDrawerState {
  open: boolean;
  openDrawer(): void;
  closeDrawer(): void;
  /**
   * The hamburger, so the drawer can put focus back on it when it closes.
   * A keyboard user who dismisses a drawer and lands at the top of the
   * document has lost their place; this is the half of "closes on Escape"
   * that is easy to forget and impossible to notice with a mouse.
   */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const NavDrawerContext = createContext<NavDrawerState | null>(null);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => setOpen(false), []);

  /*
   * CROSSING INTO THE WIDE TIER CLOSES IT. Above 1024px the rail is
   * permanent and the hamburger is not rendered, so an `open` left over
   * from a narrow viewport would strand a scrim and a focus trap on a page
   * with nothing left to dismiss them. 1024 is the tier boundary — the
   * literal is repeated here for the same reason the stylesheets repeat it
   * (a custom property cannot be read from a media condition); see
   * nav.module.css's header for its one documented home.
   */
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const sync = () => {
      if (wide.matches) setOpen(false);
    };
    sync();
    wide.addEventListener('change', sync);
    return () => wide.removeEventListener('change', sync);
  }, []);

  const value = useMemo<NavDrawerState>(
    () => ({ open, openDrawer, closeDrawer, triggerRef }),
    [open, openDrawer, closeDrawer],
  );

  return <NavDrawerContext.Provider value={value}>{children}</NavDrawerContext.Provider>;
}

export function useNavDrawer(): NavDrawerState {
  const state = useContext(NavDrawerContext);
  if (!state) throw new Error('useNavDrawer must be used inside <NavDrawerProvider>');
  return state;
}

/**
 * The hamburger (artboard P11: three 2px bars, 30px wide, at the left of the
 * banner). Rendered by TopBar only when there is a nav to open, and hidden by
 * CSS at the wide tier where the rail is permanent — so `open` can only ever
 * become true at narrow.
 */
export function NavDrawerToggle() {
  const { open, openDrawer, closeDrawer, triggerRef } = useNavDrawer();

  return (
    <button
      ref={triggerRef}
      type="button"
      className={styles.toggle}
      aria-expanded={open}
      aria-controls={NAV_DRAWER_ID}
      onClick={() => (open ? closeDrawer() : openDrawer())}
    >
      <span className={styles.bars} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className={styles.srOnly}>Open navigation</span>
    </button>
  );
}
