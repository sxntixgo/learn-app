import { cookies } from 'next/headers';

/*
 * Relays the API's Set-Cookie headers onto web's own response (Task C/D).
 *
 * web talks to the API over plain server-to-server HTTP (CLAUDE.md rule 1) —
 * the browser never talks to the API directly. So when POST /api/v1/auth/
 * login (or /refresh, /logout) answers with Set-Cookie: learn_at=...;
 * learn_rt=..., those headers land on the `fetch()` Response inside our own
 * Next.js server and go no further on their own: they are NOT automatically
 * forwarded to the actual browser. Something has to read them off the API's
 * response and re-issue them from web's own origin via `next/headers`'
 * `cookies()` — that something is `relaySetCookies` below, called from
 * web/src/lib/api.ts's login/logout.
 *
 * `parseSetCookie` is kept pure and separate so the "turn one raw Set-Cookie
 * header into (name, value, attributes)" logic is testable without a
 * request scope — same reasoning as api-errors.ts / next-path.ts.
 */

export interface ParsedSetCookie {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  expires?: Date;
}

/** Parses one raw `Set-Cookie` header value. Null if it has no name=value pair. */
export function parseSetCookie(raw: string): ParsedSetCookie | null {
  const parts = raw.split(';').map((part) => part.trim());
  const first = parts[0];
  if (!first) return null;

  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const parsed: ParsedSetCookie = { name, value, httpOnly: false, secure: false };

  for (const attribute of parts.slice(1)) {
    if (attribute === '') continue;
    const eqIndex = attribute.indexOf('=');
    const key = (eqIndex === -1 ? attribute : attribute.slice(0, eqIndex)).trim().toLowerCase();
    const attrValue = eqIndex === -1 ? '' : attribute.slice(eqIndex + 1).trim();

    switch (key) {
      case 'path':
        parsed.path = attrValue;
        break;
      case 'max-age': {
        const maxAge = Number(attrValue);
        if (Number.isFinite(maxAge)) parsed.maxAge = maxAge;
        break;
      }
      case 'httponly':
        parsed.httpOnly = true;
        break;
      case 'secure':
        parsed.secure = true;
        break;
      case 'samesite': {
        const sameSite = attrValue.toLowerCase();
        if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') parsed.sameSite = sameSite;
        break;
      }
      case 'expires': {
        const expires = new Date(attrValue);
        if (!Number.isNaN(expires.getTime())) parsed.expires = expires;
        break;
      }
      default:
        // Domain and any other attribute: not needed. `auth/cookies.ts`
        // never sets Domain, so web's own default (its own host) is
        // already correct.
        break;
    }
  }

  return parsed;
}

/**
 * The path a relayed cookie should carry ON WEB'S ORIGIN.
 *
 * The API scopes the refresh cookie to `/api/v1/auth` — sound reasoning, and
 * its own comment says why: a credential only the auth routes need should
 * not ride along on every other request. That scoping is about the API's
 * origin, where those routes exist.
 *
 * On web's origin they do not. The browser never talks to the API directly
 * (proxy.ts's CSP is `connect-src 'self'`), and Next serves nothing under
 * `/api/v1/auth`. A refresh cookie scoped there is a cookie the browser will
 * never send anywhere — so the session simply ended when the 15-minute access
 * token expired, with a perfectly good refresh token sitting unused in the
 * jar.
 *
 * Re-scoped to `/` so proxy.ts can see it and refresh. That is a real
 * widening of where the token travels, and it is the cost of the token being
 * usable at all here: every path on this origin is the same Next server, the
 * cookie stays httpOnly + secure + SameSite=Lax, and no page script can read
 * it.
 */
function pathOnThisOrigin(parsed: ParsedSetCookie): string | undefined {
  if (parsed.name === REFRESH_COOKIE_NAME) return '/';
  return parsed.path;
}

/** Mirrors api/src/auth/cookies.ts. Duplicated rather than imported: web must not depend on the API package. */
const REFRESH_COOKIE_NAME = 'learn_rt';

/**
 * Re-issues every Set-Cookie header on `res` (an API response) as a cookie
 * on web's own outgoing response. A no-op when the API set no cookies —
 * most API responses don't.
 */
export async function relaySetCookies(res: Response): Promise<void> {
  const raw = res.headers.getSetCookie();
  if (raw.length === 0) return;

  const store = await cookies();
  for (const header of raw) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;
    store.set(parsed.name, parsed.value, {
      path: pathOnThisOrigin(parsed),
      maxAge: parsed.maxAge,
      httpOnly: parsed.httpOnly,
      secure: parsed.secure,
      sameSite: parsed.sameSite,
      expires: parsed.expires,
    });
  }
}
