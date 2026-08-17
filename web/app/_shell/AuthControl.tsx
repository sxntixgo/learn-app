/*
 * The shell's auth control (Task D): who you are + Sign out when signed in,
 * a Sign in link when not. A plain Server Component — the sign-out form is
 * bound directly to a Server Action, same posture as ThemeToggle: it works
 * via ordinary form submission, no client JS and no hover-only affordance
 * required to use it.
 */

import Link from 'next/link';
import type { Me } from '../../src/lib/api';
import { logoutAction } from './auth-actions';
import styles from './auth-control.module.css';

export default function AuthControl({ user }: { user: Me | null }) {
  if (!user) {
    return (
      <Link href="/login" className={styles.signInLink}>
        Sign in
      </Link>
    );
  }

  return (
    <form action={logoutAction} className={styles.control}>
      <span className={styles.identity}>{user.displayName ?? 'Signed in'}</span>
      <button type="submit" className={styles.signOutButton}>
        Sign out
      </button>
    </form>
  );
}
