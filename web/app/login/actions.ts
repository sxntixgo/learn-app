'use server';

/*
 * Server Action backing the login form (Task C). Runs on the Next.js
 * server, never in the browser (CLAUDE.md rule 1) — the form posts here,
 * this calls src/lib/api.ts's `login`, and either redirects to the
 * validated `next` target or returns an error for the form to show.
 *
 * `next` is re-validated here, not trusted from the hidden field alone:
 * the field is set from an already-sanitized value in page.tsx, but a
 * request straight to this action (no browser, no page render) could send
 * anything, so this is the actual enforcement point for the open-redirect
 * fix, not just a display nicety.
 */

import { redirect } from 'next/navigation';
import { login } from '../../src/lib/api';
import { sanitizeNextPath } from '../../src/lib/next-path';

export interface LoginFormState {
  error: string | null;
}

export async function loginAction(_prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = sanitizeNextPath(String(formData.get('next') ?? ''));

  const result = await login(email, password);
  if (!result.ok) {
    return { error: result.message };
  }

  // Thrown by next/navigation — must not be caught, so this happens after
  // the only place in this function that could fail.
  redirect(next);
}
