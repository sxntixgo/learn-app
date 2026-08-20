import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { fetchMeOrNull } from '../../src/lib/api';
import { sanitizeNextPath } from '../../src/lib/next-path';
import LoginForm from './LoginForm';
import styles from './login.module.css';

export const metadata: Metadata = {
  title: 'Sign in — Learn App',
};

/*
 * The login page (Task C) — the fix for "an anonymous visitor cannot use or
 * even see the app, and cannot log in because no login page exists." Must
 * stay reachable while anonymous: it fetches nothing that requires a
 * session (Task B's redirect-to-login loop would otherwise start here).
 *
 * `next` (where to land after signing in) comes from the query string and
 * is validated with sanitizeNextPath BEFORE it is ever shown or handed to
 * the form — an absolute or protocol-relative URL, or a path-traversal
 * attempt, all fall back to '/' rather than being trusted as a redirect
 * target (open-redirect fix).
 *
 * `?deleted=1` (settings/account/actions.ts's `deleteAccountAction`): the
 * API clears the session cookies as part of a successful deletion, so
 * there is no account left to show anything to — this is the one place
 * left to confirm the irreversible action actually happened, rather than
 * leaving the account holder to wonder whether it did.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; deleted?: string }>;
}) {
  const params = await searchParams;
  const next = sanitizeNextPath(params.next);
  const justDeleted = params.deleted === '1';

  // Already signed in: nothing to do here but land where they were headed.
  const me = await fetchMeOrNull();
  if (me) {
    redirect(next);
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Sign in</h1>
      {justDeleted ? (
        <p className={styles.notice} role="status">
          Your account has been permanently deleted.
        </p>
      ) : null}
      <p className={styles.intro}>Sign in to browse courses and pick up where you left off.</p>
      <LoginForm next={next} />
    </main>
  );
}
