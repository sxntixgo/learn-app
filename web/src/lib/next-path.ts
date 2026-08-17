/*
 * Validates the `next` query param used by the login page's redirect target
 * (Task C, the bug's own writeup: "an open redirect via ?next=https://evil
 * .example is a real vulnerability, and this is exactly where it appears").
 *
 * The only safe redirect target is a same-site relative path: one that
 * starts with exactly one '/' and stays there. Anything else - an absolute
 * URL, a protocol-relative URL ('//host/...', which the browser resolves
 * against its own scheme), the '/\' trick some browsers also treat as
 * protocol-relative, or a path-traversal segment - is rejected wholesale
 * rather than partially repaired, and falls back to '/'. Control characters
 * (CR/LF included) are rejected too, since a login form is exactly the kind
 * of place a header-injection payload would be aimed at if this value were
 * ever echoed into a redirect response by hand.
 */

const CONTROL_CHARACTER_CODE_MAX = 0x1f;
const DEL_CHARACTER_CODE = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= CONTROL_CHARACTER_CODE_MAX || code === DEL_CHARACTER_CODE) return true;
  }
  return false;
}

/** Returns `raw` if it is a safe same-site relative path, `/` otherwise. */
export function sanitizeNextPath(raw: string | null | undefined): string {
  const fallback = '/';

  if (typeof raw !== 'string' || raw === '') return fallback;
  if (hasControlCharacter(raw)) return fallback;

  // Exactly one leading '/', never '//' (protocol-relative) or '/\'
  // (browsers normalise this to protocol-relative too).
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;

  // Path segments only - never resolve '..' away silently. Query/hash are
  // stripped first so a '..' hidden after '?' or '#' can't slip past the
  // segment check.
  const pathPart = raw.split(/[?#]/, 1)[0] ?? raw;
  const segments = pathPart.split('/');
  if (segments.includes('..') || segments.includes('.')) return fallback;

  // Re-run the same checks against the percent-decoded form. `/%2f%2fevil.example`
  // passes every check above because `%2f` is not a path separator to this
  // code - and it is not one to a browser either, which is why it is not
  // exploitable here today. But it decodes to `//evil.example`, so any proxy
  // or framework that normalises the path before redirecting turns it into a
  // protocol-relative URL and off-site. Rejecting the encoded form costs
  // nothing and removes the dependency on who normalises what.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return fallback; // malformed percent-encoding
  }
  if (decoded !== pathPart) {
    if (hasControlCharacter(decoded)) return fallback;
    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) {
      return fallback;
    }
    const decodedSegments = decoded.split('/');
    if (decodedSegments.includes('..') || decodedSegments.includes('.')) return fallback;
  }

  return raw;
}

/**
 * The login page's own URL for redirecting an unauthenticated visitor back
 * to `path` afterward (Task B/C). The inverse of `sanitizeNextPath`: this
 * side only ever encodes one of our own route paths, so it does not need to
 * validate one.
 */
export function loginRedirectPath(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
