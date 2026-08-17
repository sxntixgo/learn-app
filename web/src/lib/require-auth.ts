import { redirect } from 'next/navigation';
import { AuthRequiredError } from './api-errors';
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
    if (err instanceof AuthRequiredError) {
      redirect(loginRedirectPath(path));
    }
    throw err;
  }
}
