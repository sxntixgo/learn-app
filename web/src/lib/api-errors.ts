/*
 * How web/src/lib/api.ts turns an API response status into something a
 * Server Component can act on, instead of the blanket `throw new Error(...)`
 * every fetch helper used to do (the bug this fixes: a 403 from can() became
 * an unhandled exception and Next rendered a 500 for anyone not signed in).
 *
 * Kept as pure, DB/next-free logic — same reasoning as heatmap.ts/theme.ts —
 * so the status-to-outcome mapping is testable without mocking `fetch` or
 * `next/headers`.
 */

/**
 * Thrown by web/src/lib/api.ts when the API answers 401 or 403. A page that
 * needs a session catches this and redirects to /login?next=<path> (Task B);
 * it is a real Error subclass so callers that already do
 * `err instanceof Error ? err.message : ...` (the enrol/publish Server
 * Actions) keep working unchanged.
 */
export class AuthRequiredError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * A 403: the caller HAS a session and it does not reach this resource.
 *
 * A SUBCLASS of AuthRequiredError, deliberately. A dozen call sites in api.ts
 * ask "may this actor do X?" by catching AuthRequiredError and returning
 * false — `canGrade`, `hasInvites`, and friends — and every one of them means
 * "the API refused on authorization grounds", which is as true of a 403 as of
 * a 401. Subclassing keeps all of them correct without a single edit.
 *
 * The base class keeps its name even though "auth required" now reads a
 * little oddly for the parent of both. Renaming it to AuthorizationError
 * would be more accurate and would touch every one of those call sites for
 * no behavioural gain; this comment is the cheaper fix.
 *
 * What the distinction is FOR is the remedy. 401 means sign in. 403 means
 * signing in again changes nothing — which is exactly the loop this split
 * exists to end.
 */
export class ForbiddenError extends AuthRequiredError {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export type FetchOutcome = 'ok' | 'auth-required' | 'forbidden' | 'not-found' | 'error';

/**
 * Classifies an HTTP status for the API client (web/src/lib/api.ts):
 *   - 2xx is `ok`.
 *   - 401 is `auth-required` — there is no session. Sign in.
 *   - 403 is `forbidden` — there IS a session and it does not reach this
 *     resource. These were one outcome until an admin account signed in and
 *     hit the catalog: `course:list` is a student-only power (§5.1), the
 *     catalog 403'd, the UI sent them to /login, /login saw a valid session
 *     and sent them back, forever. Signing in again cannot fix a 403, so the
 *     two cannot share a remedy.
 *   - 404 is `not-found` — callers turn this into `notFound()`, exactly as
 *     `fetchCourse` already did before this fix.
 *   - anything else is a genuine `error`, left for the caller to throw.
 */
export function classifyStatus(status: number): FetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'auth-required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'error';
}
