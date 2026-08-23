'use server';

/*
 * The delete-account screen's one Server Action (plan: "Account deletion and
 * data export"). Same shape as login/actions.ts's `loginAction`: bound to
 * the form via `useActionState`, runs on the Next.js server, and either
 * redirects on success or returns an error for the form to show without
 * losing what was typed.
 */

import { redirect } from 'next/navigation';
import { changePassword, deleteMyAccount } from '../../../src/lib/api';

export interface DeleteAccountFormState {
  error: string | null;
}

export async function deleteAccountAction(
  _prevState: DeleteAccountFormState,
  formData: FormData,
): Promise<DeleteAccountFormState> {
  const confirmHandle = String(formData.get('confirmHandle') ?? '');

  const result = await deleteMyAccount(confirmHandle);
  if (!result.ok) {
    return { error: result.message };
  }

  // The API already cleared the session cookies on its own response (relayed
  // by deleteMyAccount); nothing here to sign out of. `?deleted=1` is read by
  // app/login/page.tsx to show a one-line confirmation instead of leaving the
  // account holder to wonder whether anything happened.
  //
  // Thrown by next/navigation — must not be caught, so this happens after
  // the only place in this function that could fail.
  redirect('/login?deleted=1');
}

/**
 * Changing the account's own password.
 *
 * The values are read out of FormData rather than taken as arguments so the
 * form posts normally, and neither password is ever put in a URL, a redirect,
 * or a returned object — the result carries a message and nothing else.
 */
export type ChangePasswordActionResult = { ok: true } | { ok: false; message: string };

export async function changePasswordAction(formData: FormData): Promise<ChangePasswordActionResult> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');

  // The confirmation is a CLIENT-SIDE concern and is checked here rather than
  // sent on: the API has no business knowing a person typed it twice, and a
  // third password field in the request body would be a third place it could
  // be logged.
  if (newPassword !== confirmPassword) {
    return { ok: false, message: 'The new passwords do not match.' };
  }

  const result = await changePassword(currentPassword, newPassword);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    message: result.retryAfterSeconds
      ? `${result.message} Try again in ${result.retryAfterSeconds} seconds.`
      : result.message,
  };
}
