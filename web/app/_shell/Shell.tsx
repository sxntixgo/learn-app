/*
 * One shell wrapping every page (design §14.2, plan phase 4): the top
 * banner, the nav (a drawer behind the banner's hamburger below 1024px /
 * the 224px teal rail at 1024px+), the page content, and the graphite
 * footer.
 *
 * `.content` at 375px and at 834px is exactly the viewport width minus its
 * own page-level padding — Nav has zero footprint in normal flow there (the
 * drawer is `position: fixed`, taken out of flow, and absent from the box
 * model entirely while closed) so it cannot steal width from the prose
 * measure. At 1024px+ Nav becomes an in-flow sidebar and legitimately takes
 * a column, which is the point of a sidebar.
 *
 * THE THREE REGIONS THE DRAWER SUPPRESSES carry `data-drawer-inert`: banner,
 * page and footer. Nav sets `inert` on each while the drawer is open, which
 * is what makes the page behind it unreachable by pointer, by Tab and by a
 * screen reader at once (see Nav.tsx). They are marked here because this is
 * the file that knows what "the rest of the shell" is.
 *
 * THE ACCOUNT CONTROL IS BUILT HERE AND HANDED TO Nav. The artboards move it
 * into the rail (artboard-spec §6: "the enrolled-course list and the account
 * control both move into the rail"), and there is exactly ONE of it — a
 * per-tier copy hidden by CSS would put two of every menu item in the DOM,
 * which is a duplicate-landmark problem for a reader and a strict-mode
 * problem for every spec that locates one by role. Nav is a Client
 * Component and AccountMenu's theme control is a Server Component built
 * from three server actions, so it is composed here, on the server, and
 * passed down as an element.
 */

import type { ReactNode } from 'react';
import type { ThemePreference } from '../../src/lib/theme';
import type { EnrolledCourse, Me } from '../../src/lib/api';
import { MANAGE_DESTINATIONS, visibleNavDestinations, type NavAudience } from '../../src/lib/nav';
import TopBar from './TopBar';
import Nav from './Nav';
import { NavDrawerProvider } from './NavDrawer';
import Footer from './Footer';
import AccountMenu from './AccountMenu';
import ThemeToggle from './ThemeToggle';
import styles from './shell.module.css';

export default function Shell({
  theme,
  user,
  audience,
  enrolledCourses,
  children,
}: {
  theme: ThemePreference;
  /** Task D: every current nav destination requires a session (Catalog
   *  included — course:list denies the anonymous actor outright), so the
   *  shell needs to know whether one exists to decide what Nav renders. */
  user: Me | null;
  /**
   * Which role-restricted destinations this account may reach (design §9.4,
   * §12, §5.1). Meaningless when signed out; the layout only asks the API
   * when `user` is non-null.
   *
   * Feeds BOTH lists the shell renders: the rail is the three everyday
   * destinations, and the account menu's Manage section is the role-gated
   * ones. Same audience, filtered by the same function, so the two cannot
   * disagree about who may see what.
   */
  audience: NavAudience;
  /**
   * The rail's `ENROLLED` list (artboard M1). Empty for a signed-out
   * visitor, and empty for any account the API refuses — a teacher or an
   * operator, who has no enrollments to list (design §5.1). Threaded from
   * the layout rather than fetched here so the shell stays a pure render.
   */
  enrolledCourses: readonly EnrolledCourse[];
  children: ReactNode;
}) {
  const signedIn = user !== null;

  // Filtered here rather than inside AccountMenu so the menu stays a
  // presentational component and the "may this person see this?" decision
  // stays in the one tested place (src/lib/nav.ts).
  const manage = user ? visibleNavDestinations(audience, MANAGE_DESTINATIONS) : [];

  return (
    <div className={styles.root}>
      {/*
       * The hamburger lives in the banner and the drawer IS the one <nav>,
       * so the two share a boolean through this provider rather than one of
       * them owning a second copy of the other. A Client Component wrapping
       * Server Components as children: TopBar, Footer and the page itself
       * stay on the server; only the hamburger and Nav hydrate.
       */}
      <NavDrawerProvider>
        <TopBar theme={theme} user={user} />
        <div className={styles.body}>
          <Nav
            signedIn={signedIn}
            user={user}
            audience={audience}
            enrolledCourses={enrolledCourses}
            accountControl={
              user ? (
                /*
                 * Signed in, the theme control lives INSIDE the account menu —
                 * it is a personal preference and belongs with the other ones,
                 * and the banner had grown into five separate controls. Signed
                 * out there is no menu to put it in, so TopBar keeps it.
                 */
                <AccountMenu user={user} manage={manage} themeControl={<ThemeToggle current={theme} />} />
              ) : null
            }
          />
          <main className={styles.content} data-drawer-inert>
            {children}
          </main>
        </div>
        <Footer />
      </NavDrawerProvider>
    </div>
  );
}
