import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchMeOrNull, previewInvite } from '../../../src/lib/api';
import { loginRedirectPath } from '../../../src/lib/next-path';
import AcceptForm from './AcceptForm';
import styles from './accept.module.css';

export const metadata: Metadata = {
  title: 'Accept your invitation — Learn App',
};

/*
 * The accept-invitation page (design §12, §13: "registration only via invite
 * token", the one exception being first-run bootstrap).
 *
 * REACHABLE WHILE SIGNED OUT, and it has to be: the invitee has no account
 * yet, which is the entire point. The token in the URL is the credential —
 * 256 bits, stored only as a SHA-256 — so this page uses `previewInvite`,
 * which is not routed through `apiFetch` and therefore never bounces an
 * anonymous invitee to /login (that would be a loop they could not leave).
 *
 * FOUR STATES:
 *   dead link            unknown, expired, revoked, or already used — the
 *                        API answers 410 for all four with one message, and
 *                        so does this page: no oracle for which flavour of
 *                        dead a token you do not hold is.
 *   needs an account     the form registers and enrols in one submission.
 *   has an account, and
 *     signed in as it    one button; nothing to fill in.
 *     signed in as
 *     someone else, or
 *     not signed in      told to sign in as the invited address first. A
 *                        link found in a mailbox may not be turned into
 *                        somebody else's enrolment.
 */
export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [invite, me] = await Promise.all([previewInvite(token), fetchMeOrNull()]);

  if (invite === null) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>This invitation is not valid</h1>
        <p className={styles.intro}>
          It may have expired, been revoked, or already been used. Ask whoever invited you for a new link — they can
          issue one in a moment.
        </p>
        <p className={styles.intro}>
          <Link className={styles.link} href="/login">
            Sign in
          </Link>{' '}
          if you already have an account.
        </p>
      </main>
    );
  }

  const signedIn = me !== null;
  const acceptPath = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{invite.courseTitle ? `You are invited to ${invite.courseTitle}` : 'You are invited'}</h1>
      <p className={styles.intro}>
        This invitation is for <strong>{invite.email}</strong>
        {invite.courseTitle ? <> and enrols you in {invite.courseTitle} as soon as you accept.</> : <>.</>}
      </p>

      {invite.needsAccount ? (
        <AcceptForm token={token} email={invite.email} needsAccount courseTitle={invite.courseTitle} />
      ) : signedIn ? (
        <AcceptForm token={token} email={invite.email} needsAccount={false} courseTitle={invite.courseTitle} />
      ) : (
        <p className={styles.intro}>
          That address already has an account, so this invitation grants course access rather than creating one.{' '}
          <Link className={styles.link} href={loginRedirectPath(acceptPath)}>
            Sign in as {invite.email}
          </Link>{' '}
          and open this link again to accept it.
        </p>
      )}
    </main>
  );
}
