import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchCanSearch, fetchIsAdmin, fetchIsTeacher, fetchMeOrNull } from '../../src/lib/api';
import { sanitizeNextPath } from '../../src/lib/next-path';
import styles from './no-access.module.css';

export const metadata: Metadata = {
  title: 'Not available to this account — Learn App',
  robots: { index: false, follow: false },
};

/*
 * Where a 403 lands.
 *
 * It exists because the alternative was an infinite redirect. A signed-in
 * account that reaches a page it may not see used to be sent to /login, and
 * /login — finding a perfectly valid session — sent it back. Firefox called
 * it "the page isn't redirecting properly"; the account was an admin, and the
 * page was the catalog, which is a student-only surface (§5.1: operator
 * accounts have no enrolments, no progress and no public profile).
 *
 * The page therefore has to say the one thing the redirect could not: you ARE
 * signed in, and signing in again will not help. Then it has to offer
 * somewhere useful, which depends on what the account actually is.
 *
 * It fetches nothing that can 403. `fetchMeOrNull` is the only call, and it
 * returns null rather than throwing — a page that handles a failed
 * authorization must not be capable of failing authorization itself, or the
 * loop simply moves here.
 */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const params = await searchParams;
  const from = sanitizeNextPath(params.from);

  // CAPABILITY PROBES, not roles. `/api/v1/me` carries no roles, and the
  // endpoint that would (`/api/v1/me/profile`) is itself student-only — so
  // asking it here would 403 and land back on this page. These four each
  // answer false on refusal instead of throwing, which is exactly the
  // property a page that handles refusals needs.
  const [me, isAdmin, isTeacher, canSearch] = await Promise.all([
    fetchMeOrNull(),
    fetchIsAdmin(),
    fetchIsTeacher(),
    fetchCanSearch(),
  ]);

  const isOperator = isAdmin || isTeacher;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Not available to this account</h1>

      <p className={styles.lede}>
        You are signed in{me?.displayName ? ` as ${me.displayName}` : ''}, but this account cannot open{' '}
        <code className={styles.path}>{from}</code>. Signing in again will not change that.
      </p>

      {isOperator && !canSearch ? (
        <p className={styles.explain}>
          Operator accounts — admin and teacher — have no learner surface: no catalog, no enrolments, no progress.
          That is deliberate. The linked student account created alongside this one is the one to read courses with.
        </p>
      ) : (
        <p className={styles.explain}>
          This page needs a permission this account does not have. If that seems wrong, an administrator can check
          its roles.
        </p>
      )}

      <ul className={styles.links}>
        {canSearch ? (
          <li>
            <Link href="/">Catalog</Link>
          </li>
        ) : null}
        {isTeacher ? (
          <li>
            <Link href="/grading">Grading queue</Link>
          </li>
        ) : null}
        {isAdmin ? (
          <li>
            <Link href="/admin/people">Administration</Link>
          </li>
        ) : null}
        <li>
          <Link href="/settings/account">Account settings</Link>
        </li>
      </ul>
    </main>
  );
}
