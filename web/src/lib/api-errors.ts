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
  constructor() {
    super('Authentication required.');
    this.name = 'AuthRequiredError';
  }
}

export type FetchOutcome = 'ok' | 'auth-required' | 'not-found' | 'error';

/**
 * Classifies an HTTP status for the API client (web/src/lib/api.ts):
 *   - 2xx is `ok`.
 *   - 401/403 is `auth-required` — the actor has no session, or the one
 *     they have does not reach this resource. Either way the UI's answer is
 *     the same: send them to sign in (Task B).
 *   - 404 is `not-found` — callers turn this into `notFound()`, exactly as
 *     `fetchCourse` already did before this fix.
 *   - anything else is a genuine `error`, left for the caller to throw.
 */
export function classifyStatus(status: number): FetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth-required';
  if (status === 404) return 'not-found';
  return 'error';
}
