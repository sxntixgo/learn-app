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
import TopBar from './TopBar';
import Nav from './Nav';
import Footer from './Footer';
import styles from './shell.module.css';

export default function Shell({ theme, children }: { theme: ThemePreference; children: ReactNode }) {
  return (
    <div className={styles.root}>
      <TopBar theme={theme} />
      <div className={styles.body}>
        <Nav />
        <main className={styles.content}>{children}</main>
      </div>
      <Footer />
    </div>
  );
}
