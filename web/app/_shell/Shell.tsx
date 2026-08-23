/*
 * One shell wrapping every page (design §14.2, plan phase 4): the top
 * banner, the nav (bottom tab bar on phone / sidebar at 768px+), the page
 * content, and the graphite footer.
 *
 * `.content` at 375px is exactly the viewport width minus its own
 * page-level padding — Nav has zero footprint in normal flow there (it's
 * `position: fixed`, taken out of flow) so it cannot steal width from the
 * prose measure. At 768px+ Nav becomes an in-flow sidebar and legitimately
 * takes a column, which is the point of a sidebar.
 */

import type { ReactNode } from 'react';
import type { ThemePreference } from '../../src/lib/theme';
import type { Me } from '../../src/lib/api';
import type { NavAudience } from '../../src/lib/nav';
import TopBar from './TopBar';
import Nav from './Nav';
import Footer from './Footer';
import styles from './shell.module.css';

export default function Shell({
  theme,
  user,
  audience,
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
   * Goes to BOTH Nav and TopBar: the sidebar is the three everyday
   * destinations, and the account menu's Manage section is the role-gated
   * ones. Same audience, filtered by the same function, so the two cannot
   * disagree about who may see what.
   */
  audience: NavAudience;
  children: ReactNode;
}) {
  const signedIn = user !== null;
  return (
    <div className={styles.root} data-nav-visible={signedIn}>
      <TopBar theme={theme} user={user} audience={audience} />
      <div className={styles.body}>
        <Nav signedIn={signedIn} audience={audience} />
        <main className={styles.content}>{children}</main>
      </div>
      <Footer />
    </div>
  );
}
