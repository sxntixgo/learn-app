'use server';

/*
 * Server Action backing the shell's Sign-out control (Task D). Same shape
 * as login/actions.ts: runs on the Next.js server, calls src/lib/api.ts,
 * never touches a token itself.
 */

import { redirect } from 'next/navigation';
import { logout } from '../../src/lib/api';

export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}
