'use server';

/*
 * The delete-account screen's one Server Action (plan: "Account deletion and
 * data export"). Same shape as login/actions.ts's `loginAction`: bound to
 * the form via `useActionState`, runs on the Next.js server, and either
 * redirects on success or returns an error for the form to show without
 * losing what was typed.
 */

import { redirect } from 'next/navigation';
import { deleteMyAccount } from '../../../src/lib/api';

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
