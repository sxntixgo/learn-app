import { redirect } from 'next/navigation';
import { AuthRequiredError, ForbiddenError } from './api-errors';
import { fetchMeOrNull } from './api';
import { loginRedirectPath } from './next-path';

/*
 * Task B/E: "Server components that need a session should redirect
 * unauthenticated visitors to /login?next=<path> rather than erroring."
 *
 * Every page that fetches data during its own render (the catalog, a
 * course, a lesson, the dashboard, the admin import screen) wraps its
 * fetch(es) in this instead of calling web/src/lib/api.ts directly — one
 * place to redirect on AuthRequiredError instead of five, and one place a
 * future page picks up the same behaviour for free.
 *
 * Not usable from web/src/lib/api.ts itself: `redirect()` throws a Next.js
 * control-flow signal that must propagate out of the page's render, and
 * api.ts is a plain HTTP client with no framework-navigation concerns —
 * keeping the two apart is what lets api-errors.ts stay framework-free and
 * unit-testable (see api-errors.test.ts).
 */
export async function withAuthRedirect<T>(path: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    // ORDER MATTERS: ForbiddenError extends AuthRequiredError, so the
    // narrower case has to be tested first.
    //
    // A 403 means the account is signed in and this page is not for it.
    // Sending it to /login was an infinite redirect — /login sees a valid
    // session and bounces straight back. An admin signing in and landing on
    // the catalog hit exactly that: `course:list` is student-only (§5.1).
    if (err instanceof ForbiddenError) {
      // THE STATUS ALONE CANNOT DECIDE THIS. The API answers 403 for an
      // anonymous caller as well as for a signed-in one with the wrong role
      // — deliberately, because refusing is `can()`'s job and it has one
      // refusal (CLAUDE.md rule 2). Routing every 403 to /no-access sent
      // signed-out visitors to a page telling them they were signed in.
      //
      // So ask the question the remedy actually depends on: is there a
      // session? One extra call, only ever on the failure path.
      const me = await fetchMeOrNull();
      if (me) redirect(`/no-access?from=${encodeURIComponent(path)}`);
    }
    if (err instanceof AuthRequiredError) {
      redirect(loginRedirectPath(path));
    }
    throw err;
  }
}
