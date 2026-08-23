'use server';

/*
 * Accepting an invitation (design §12: "one action issues one link that both
 * registers the person and enrolls them in the course").
 *
 * ONE FLOW, THREE STEPS, in this order and no other:
 *
 *   1. POST /api/v1/invites/accept — claims the invitation atomically and,
 *      in the same database transaction, creates the account and the
 *      enrolment. Either all of it happened or none of it did.
 *   2. POST /api/v1/auth/login — acceptance is not a login: the API returns
 *      the new account, not a session. Signing in here with the password
 *      the invitee just chose is what makes this ONE flow rather than
 *      "registered — now go and sign in".
 *   3. redirect to the course they were invited to, or to their dashboard.
 *
 * Step 2 must not be able to undo step 1, and cannot: if the sign-in fails
 * the account and the enrolment still exist, and the invitee is sent to
 * /login to try again rather than being told the acceptance failed. The
 * one thing that would be wrong here is re-accepting — the link is spent,
 * single-use, and a retry would 410.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvite, login } from '../../src/lib/api';
import { loginRedirectPath } from '../../src/lib/next-path';
import { INVITE_CLAIM_COOKIE, INVITE_CLAIM_COOKIE_OPTIONS } from '../../src/lib/invite-cookie';

export interface AcceptFormState {
  error: string | null;
}

export async function acceptInviteAction(_prev: AcceptFormState, formData: FormData): Promise<AcceptFormState> {
  // From the httpOnly cookie the link exchange set, never from the form: a
  // credential in a form field is a credential in the page, and the whole
  // point of spending the link on arrival was to get it out of reach.
  const claimToken = (await cookies()).get(INVITE_CLAIM_COOKIE)?.value ?? '';
  const email = String(formData.get('email') ?? '');
  const handle = String(formData.get('handle') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('displayName') ?? '').trim();
  const timezone = String(formData.get('timezone') ?? '').trim();
  const registering = handle !== '' || password !== '';

  const accepted = await acceptInvite({
    token: null,
    claimToken,
    handle: registering ? handle : null,
    password: registering ? password : null,
    displayName: displayName === '' ? null : displayName,
    timezone: timezone === '' ? null : timezone,
  });

  if (!accepted.ok) {
    return { error: accepted.message };
  }

  // The invitation is spent, so the claim is too. The API already cleared its
  // side inside the accept transaction; this stops the browser presenting a
  // dead credential on every later /invite request.
  (await cookies()).set(INVITE_CLAIM_COOKIE, '', { ...INVITE_CLAIM_COOKIE_OPTIONS, maxAge: 0 });

  const destination = accepted.result.courseSlug
    ? `/courses/${encodeURIComponent(accepted.result.courseSlug)}`
    : '/me';

  if (registering) {
    const session = await login(email, password);
    if (!session.ok) {
      // The account exists and is enrolled; only the sign-in failed. Send
      // them to the login page pointed at where they were going, never back
      // to a link that is now spent.
      redirect(loginRedirectPath(destination));
    }
  }

  // Thrown by next/navigation — must not be caught, so nothing that can
  // fail comes after it.
  redirect(destination);
}
