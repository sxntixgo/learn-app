/*
 * Graphite footer strip (design §14 / CHOSEN-PALETTE.md rule 3: "footer is
 * the darkest" band). Second unused-token consumer alongside TopBar. Static
 * content only — nothing here invents a destination that doesn't exist yet.
 */

import styles from './footer.module.css';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <p className={styles.text}>© {year} Learn App</p>
    </footer>
  );
}
