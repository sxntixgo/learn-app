'use client';

/*
 * The one nav component for both shapes (design §14.2: "navigation changes
 * shape, not content"). Same markup, same single `<nav>` landmark, same
 * active-item computation, in two shapes chosen by nav.module.css:
 *
 *   below 1024px  a DRAWER over the page, opened by the banner's hamburger
 *                 (artboard P11) — replacing the fixed bottom tab bar this
 *                 tier used to have;
 *   at/above      the permanent 224px teal rail (artboard M1).
 *
 * One <nav>, not two, is the whole reason the drawer's open state lives in a
 * context (NavDrawer.tsx) rather than next to the button that sets it: a
 * CSS-hidden per-tier copy would put two of every destination link and two
 * of every account-menu item in the DOM, which is a duplicate-landmark
 * problem for a reader and a strict-mode problem for every spec that locates
 * one by role.
 *
 * A client component because the active destination depends on the current
 * pathname (usePathname), which a Server Component in a layout has no way
 * to read. It still renders correctly in the initial server-sent HTML —
 * Next resolves the router context during the SSR pass of client
 * components too — so the active marker is not a post-hydration flash.
 *
 * WHAT THE DRAWER OWES A KEYBOARD AND A SCREEN READER, all of it below and
 * none of it free, because unlike AccountMenu's <details> there is no
 * element that does this for us:
 *   - focus moves into the drawer when it opens;
 *   - Tab and Shift+Tab cycle inside it and never escape (the trap);
 *   - Escape closes it;
 *   - focus returns to the hamburger that opened it;
 *   - the rest of the shell is `inert` while it is open, so the page behind
 *     is unreachable by pointer, by Tab and by a screen reader's virtual
 *     cursor alike. `inert` rather than `aria-modal`, because `aria-modal`
 *     would mean changing this element's role to `dialog` — throwing away
 *     the navigation landmark that every width, and several specs, rely on.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EnrolledCourse, Me } from '../../src/lib/api';
import type { NavAudience } from '../../src/lib/nav';
import { isNavActive, visibleNavDestinations } from '../../src/lib/nav';
import { NAV_DRAWER_ID, useNavDrawer } from './NavDrawer';
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
  '/search': (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5" />
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

/**
 * What the trap cycles through. Deliberately recomputed on every Tab rather
 * than captured once: the account menu is a `<details>` inside the drawer, so
 * opening it adds five focusable items to the middle of this list.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Nav({
  signedIn,
  user,
  audience,
  enrolledCourses,
  accountControl,
}: {
  signedIn: boolean;
  /**
   * Who the drawer belongs to (P11's identity header — mark, name, @handle,
   * at the top of the drawer). Wide never renders it: M1's rail has no
   * equivalent at the top, only the "Learn App" brand, which stays in the
   * banner (see top-bar.module.css) — so this is drawn only inside
   * `.drawerHeader`, which nav.module.css already hides at >= 1024px. `null`
   * signed out, same as `accountControl`.
   */
  user: Me | null;
  audience: NavAudience;
  /**
   * The rail's `ENROLLED` list (artboard M1). Rendered only at the wide tier:
   * nav.module.css hides `.enrolled` below 1024px because the narrow design
   * puts this list on Home instead of in the chrome — P11's drawer has no
   * enrolled section, and P2 (Home) carries "Your courses" with the same
   * titles and the same progress bars. See nav.module.css's `.enrolled`.
   */
  enrolledCourses: readonly EnrolledCourse[];
  /**
   * The account menu, built on the server by Shell and pinned to the bottom
   * of the rail (artboard M1's "Santiago ▾") — and, at narrow, to the bottom
   * of the drawer, where P11 puts "Sign out". An element rather than an
   * import because it carries a Server Component (ThemeToggle) inside it and
   * this file is a Client Component.
   */
  accountControl: ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { open, closeDrawer, triggerRef } = useNavDrawer();
  const drawer = useRef<HTMLElement>(null);

  /*
   * THE MODAL HALF OF THE DRAWER: everything that stops the page behind it
   * from still being there. Runs only while `open`, which can only be true
   * at the narrow tier (the hamburger is `display: none` above 1024px and
   * the provider closes the drawer on the way past that boundary), so none
   * of this ever touches the rail.
   */
  useEffect(() => {
    const element = drawer.current;
    if (!open || !element) return;

    // The rest of the shell: banner, page and footer (Shell marks them).
    // `inert` takes them out of the tab order AND out of the accessibility
    // tree in one attribute, which is the pair a hand-rolled focus trap
    // usually gets half of.
    const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-drawer-inert]'));
    for (const region of regions) region.inert = true;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /*
     * `checkVisibility()`, and NOT `offsetParent !== null` — which is what
     * this said first, and it made the trap leak on exactly one press in six.
     *
     * The account menu is a closed `<details>` inside the drawer. Chrome does
     * not hide its contents with `display: none` any more; it skips them with
     * `content-visibility` on `::details-content`. They therefore still have
     * an offsetParent and a non-empty `getClientRects()`, while being
     * genuinely unreachable by Tab — so the list ended with "Sign out"
     * instead of the summary, the summary never matched `last`, and Tab from
     * it fell out of the drawer into the document. `checkVisibility()` is the
     * one probe that answers the question the browser is actually using.
     */
    const focusable = () =>
      Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((candidate) =>
        candidate.checkVisibility(),
      );

    // Focus lands inside on open, or Escape has nothing to give back and a
    // keyboard user has to Tab from the top of the document to reach a
    // drawer that is already covering it.
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        /*
         * Innermost first. The account menu is an open `<details>` inside the
         * drawer with its own Escape handler (AccountMenu.tsx); dismissing
         * the whole drawer out from under it would throw away more than the
         * person asked to close. Leave that press to the menu — the next one
         * finds no open details and closes the drawer.
         */
        if (element.querySelector('details[open]')) return;
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      const inside = active instanceof Node && element.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const region of regions) region.inert = false;
      document.body.style.overflow = bodyOverflow;
    };
  }, [open, closeDrawer]);

  /*
   * Focus goes back to the hamburger when the drawer closes — however it
   * closed: Escape, the close button, the scrim, or following a link.
   *
   * A separate effect on purpose. React runs every cleanup for a commit
   * before any effect, so the one above has already cleared `inert` from the
   * banner by the time this runs — focusing an inert button silently does
   * nothing, which is exactly the kind of failure that looks fine on screen.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open, triggerRef]);

  // Task D: "do not render nav destinations that only work when
  // authenticated." Every current destination requires a session — Catalog
  // included, since course:list denies the anonymous actor outright
  // (api/src/policy/can.ts) — so a signed-out visitor has nothing this nav
  // could usefully point at. TopBar's Sign-in link is the only navigation
  // offered instead, and it renders no hamburger for the same reason.
  if (!signedIn) return null;

  // Design §9.4 / the grading UI brief: "a Grading destination for
  // teachers; do not show it to students." visibleNavDestinations is the
  // one tested place that decision lives (web/src/lib/nav.ts).
  const destinations = visibleNavDestinations(audience);

  return (
    <>
      {/*
       * The scrim (P11: the drawer sits on a wash of the rail's own teal).
       * Rendered ONLY while open — never present at the wide tier, because
       * `open` cannot be true there — so no rule has to cancel it, and the
       * attribute-selector specificity trap in shell.module.css's history
       * has nothing to catch here.
       *
       * A div, not a button: it is a pointer convenience on top of Escape
       * and the drawer's own close control, and a full-screen focusable
       * element with an accessible name would be both a tab stop nobody
       * wants and a second "Close navigation" for locators to trip over.
       */}
      {open ? <div className={styles.scrim} aria-hidden="true" onClick={closeDrawer} /> : null}

      <nav
        id={NAV_DRAWER_ID}
        ref={drawer}
        className={styles.nav}
        data-collapsed={collapsed}
        data-open={open}
        aria-label="Primary"
      >
        {/*
         * The drawer's own header. At narrow the drawer covers the banner
         * (P11's overlay runs to the top of the screen), so the hamburger
         * that opened it is behind the drawer and cannot also be what closes
         * it — this is the pointer user's way out. Hidden at the wide tier,
         * where nothing opened and nothing closes.
         *
         * P11's identity block (mark, name, @handle) shares this row rather
         * than getting one of its own: the artboard draws it across the full
         * top strip of the drawer, but that strip is where this app's close
         * button has to live too — the drawer covers the hamburger that
         * would otherwise close it, so SOME control has to sit up here, and
         * `space-between` gives each its own corner instead of either
         * shrinking the other or pushing the close button down into the
         * link list. It also keeps the artboard's vertical order: identity
         * first, then destinations, exactly as P11 stacks them.
         */}
        <div className={styles.drawerHeader}>
          {user ? (
            <div className={styles.identity}>
              <span className={styles.identityMark} aria-hidden="true">
                <span className={styles.identityMarkCell} />
                <span className={styles.identityMarkCell} />
                <span className={styles.identityMarkCell} />
                <span className={styles.identityMarkCell} />
              </span>
              <span className={styles.identityText}>
                <span className={styles.identityName}>{user.displayName ?? user.handle ?? 'Account'}</span>
                {user.handle ? <span className={styles.identityHandle}>@{user.handle}</span> : null}
              </span>
            </div>
          ) : null}
          <button type="button" className={styles.close} onClick={closeDrawer}>
            <span aria-hidden="true">&times;</span>
            <span className={styles.srOnly}>Close navigation</span>
          </button>
        </div>

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

        {/* Everything above the pinned account control scrolls together when
            the rail or the drawer is taller than the viewport — see
            nav.module.css's `.scroll`, which exists so neither ever becomes a
            clipping container. */}
        <div className={styles.scroll}>
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
                    /* Following a destination is finishing with the drawer;
                       leaving it open would cover the page just navigated to. */
                    onClick={closeDrawer}
                  >
                    <span className={styles.icon}>{ICONS[destination.href]}</span>
                    <span className={styles.label}>{destination.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/*
           * The `ENROLLED` list (artboard M1): the courses you are actually in,
           * with how far through each one you are. Absent entirely when there
           * are none — an empty heading over nothing tells a new learner their
           * rail is broken rather than that they have not enrolled yet.
           *
           * NOT A HEADING ELEMENT. A shell-level <h2> would precede every
           * page's own <h1> in the document, which is a heading-order failure
           * on every route at once; the list carries its name through
           * aria-label instead.
           */}
          {enrolledCourses.length > 0 ? (
            <div className={styles.enrolled}>
              <span className={styles.enrolledLabel} aria-hidden="true">
                Enrolled
              </span>
              <ul className={styles.courses} aria-label="Enrolled courses">
                {enrolledCourses.map((course) => (
                  <li key={course.slug}>
                    <Link href={`/courses/${course.slug}`} className={styles.course} onClick={closeDrawer}>
                      <span className={styles.courseTitle}>{course.title}</span>
                      {/* The percent is READ, not inferred from the bar below,
                          which is aria-hidden decoration — a progress bar is a
                          picture of a number and a reader needs the number. */}
                      <span className={styles.srOnly}>{course.percent}% complete</span>
                      <span className={styles.progressTrack} aria-hidden="true">
                        <span className={styles.progressFill} style={{ width: `${course.percent}%` }} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {accountControl ? <div className={styles.account}>{accountControl}</div> : null}
      </nav>
    </>
  );
}
