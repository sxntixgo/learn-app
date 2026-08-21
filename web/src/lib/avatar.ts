/**
 * Turning the API's avatar URL into one the browser may actually load.
 *
 * The profile payload publishes `/api/v1/profiles/{handle}/avatar?v={digest}`
 * — a path on the API's origin. A browser cannot use it:
 *
 *  - the CSP is `img-src 'self' data:` (web/proxy.ts), so a cross-origin
 *    image is blocked outright, and
 *  - the session cookie lives on web's origin, not the API's, so even an
 *    allowed request would arrive anonymous.
 *
 * So the app serves avatars from its own origin through
 * `app/avatars/[handle]/route.ts`, and this maps one to the other.
 *
 * IT IS A PARSER, NOT A REWRITER. The input arrives in a JSON payload, and an
 * `<img src>` built from a string somebody else controls is how a page ends
 * up beaconing to a third party. So the shape is matched strictly and
 * anything else returns null — at which point the component draws the
 * identicon it also received. Nothing is ever passed through.
 */

/** Migration 0005's `users_handle_url_safe`, which the API validates against too. */
const AVATAR_URL_PATTERN = /^\/api\/v1\/profiles\/([a-z0-9][a-z0-9_-]{1,30})\/avatar\?v=([0-9a-f]{1,64})$/;

/**
 * The same-origin path for an API avatar URL, or null when the input is not
 * one of ours.
 */
export function localAvatarUrl(apiUrl: string | null | undefined): string | null {
  if (typeof apiUrl !== 'string') return null;
  const match = AVATAR_URL_PATTERN.exec(apiUrl);
  if (!match) return null;
  const [, handle, digest] = match;
  return `/avatars/${handle}?v=${digest}`;
}

/**
 * What the file picker offers. NOT a security control — the API decides the
 * format from the file's own magic bytes, and the `Content-Type` a browser
 * reports is whatever the OS guessed from a filename. An affordance;
 * api/src/profile/avatar.ts is the check.
 *
 * It lives here rather than beside the Server Action that uses it because a
 * `'use server'` module may export nothing but async functions — exporting
 * this string from there silently emptied the module and every action in it
 * vanished, with the build reporting only "the module has no exports at all".
 */
export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
