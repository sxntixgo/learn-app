import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security response headers for every HTML route.
 *
 * This runs here rather than in `next.config.ts` headers because the CSP
 * carries a per-request nonce, and a static config cannot generate one. Next
 * reads the nonce out of the `content-security-policy` request header we set
 * here and stamps it onto the framework's own inline bootstrap scripts, which
 * is what lets `script-src` avoid `'unsafe-inline'`.
 *
 * The file is `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention
 * and the exported function with it. The nonce mechanism is unchanged — Next
 * still discovers the nonce by reading the request header — but `proxy` runs
 * only on the `nodejs` runtime, which cannot be configured back to `edge`.
 * Nothing here needed the edge runtime; `crypto.getRandomValues` and `btoa`
 * are both Node globals.
 */

/** Builds the policy. Exported so the test can assert on it directly. */
export function buildCsp(nonce: string): string {
  return [
    // Deny by default, then open only what this app demonstrably loads.
    "default-src 'none'",

    // Next's inline bootstrap gets the nonce. 'strict-dynamic' lets those
    // trusted scripts pull in the chunk bundles they need without listing
    // every hashed filename.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,

    // WEAKER THAN IDEAL, deliberately: Next injects critical CSS as inline
    // <style>, and Shiki emits inline style ATTRIBUTES on every highlighted
    // span (highlighting happens at render time — CLAUDE.md rule 4). Both are
    // governed by style-src in browsers without CSP3 attribute support, so
    // dropping 'unsafe-inline' would strip the palette from every code block.
    // The exposure is style injection, not script execution.
    "style-src 'self' 'unsafe-inline'",

    // The control identified by the Phase 5 hardening review: a content repo
    // can put <img src="https://tracker.example/x.png"> in a lesson, which
    // would make an authenticated reader's browser call out. Same-origin,
    // data:, and blob: — no remote origin, ever. Avatars are served from our
    // own API through app/avatars/[handle]/route.ts, which is what keeps
    // them 'self'.
    //
    // `blob:` is here for ONE thing: the avatar picker previews the file the
    // person just chose, and `URL.createObjectURL` produces a blob: URL. It
    // is not a widening toward remote content — a blob: URL can only be
    // minted by script already running on this page, and script-src is
    // nonce + 'strict-dynamic' with no 'unsafe-inline', so anything able to
    // create one has code execution already. Without it the preview is
    // silently blocked and the picker shows an empty frame; e2e/specs/
    // avatar.spec.ts asserts the preview renders, so removing this turns a
    // test red rather than degrading in production.
    "img-src 'self' data: blob:",

    // Without this the browser's fetch of /manifest.webmanifest (triggered
    // by <link rel="manifest">) falls back to default-src 'none' and is
    // blocked — even though the server 200s it. manifest-src is what that
    // fetch is actually governed by (design decision #6 / plan Phase 14).
    "manifest-src 'self'",

    // Fonts are self-hosted by next/font at build time under /_next/static.
    "font-src 'self'",

    // The browser only ever talks to this origin; the API is reached through
    // Next's own proxy routes.
    "connect-src 'self'",

    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** True when the request genuinely arrived over TLS. */
export function isSecureRequest(request: NextRequest): boolean {
  // Behind Caddy the hop to Next is plain HTTP, so trust the forwarded proto.
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  return request.nextUrl.protocol === 'https:';
}

// -----------------------------------------------------------------------------
// SESSION REFRESH
//
// The API mints a 15-minute access token and a long-lived, rotating refresh
// token, with reuse detection (design §13). It has done since Phase 6. The
// web app never called `/api/v1/auth/refresh` — so in practice a session
// lasted fifteen minutes and then dumped you at the login form, with a
// perfectly good refresh token in the jar that nothing ever spent.
//
// It happens HERE because this is the only place in a Next app that can both
// read the incoming cookies and set new ones on the way out. A Server
// Component render cannot set a cookie, which is why api.ts could never have
// done it.
//
// THE HAZARD, and why the conditions below are narrow. Rotation means a
// refresh token is single-use, and presenting a spent one is treated as
// THEFT: the API revokes the whole family, writes an audit row, and clears
// both cookies. Two requests refreshing concurrently would therefore not
// merely race — the loser would look like an attacker and destroy the
// session. So a refresh is attempted only for a top-level document
// navigation, which the browser makes one of at a time. Prefetches, RSC
// payloads, images and actions are all left alone; they will be re-issued
// with the fresh cookie once the document lands.
//
// Residual risk, stated rather than hidden: two tabs navigating in the same
// instant can still collide, and the loser loses the session. Eliminating
// that needs a lock the middleware does not have. It trades a rare forced
// re-login for a session that works at all, which is the better side of the
// trade — but it is a trade.
// -----------------------------------------------------------------------------

const ACCESS_COOKIE = 'learn_at';
const REFRESH_COOKIE = 'learn_rt';

/** A real page load, not a prefetch, an RSC fetch, an action, or a subresource. */
function isDocumentNavigation(request: NextRequest): boolean {
  if (request.method !== 'GET') return false;
  if (!request.headers.get('accept')?.includes('text/html')) return false;
  // Next's own client sends these on payload fetches and prefetches.
  if (request.headers.has('rsc') || request.headers.has('next-router-prefetch')) return false;
  if (request.headers.get('sec-fetch-dest') === 'iframe') return false;

  // NOT ON A CROSS-SITE NAVIGATION. Found by reviewing this for abuse rather
  // than for correctness: SameSite=Lax attaches the session cookies to a
  // top-level cross-site GET, so any page anywhere could send a visitor here
  // and force a rotation. Two at once — two windows opened together — and the
  // second presents a token the first already spent, which the API correctly
  // treats as theft and answers by revoking the whole family.
  //
  // That is a third party logging someone out at will, with no credentials
  // and no access to anything. A cross-site arrival now simply renders
  // signed-out, and the visitor's next same-origin navigation refreshes.
  //
  // Absent header: older browsers only. Treated as untrusted, because the
  // cost of not refreshing is one sign-in and the cost of refreshing is a
  // session somebody else can destroy.
  const site = request.headers.get('sec-fetch-site');
  if (site !== 'same-origin' && site !== 'none') return false;

  return true;
}

function shouldRefresh(request: NextRequest): boolean {
  // The access cookie carries maxAge = its own TTL, so the browser drops it
  // at expiry. Absent-but-refresh-present is precisely "expired, renewable".
  return (
    !request.cookies.has(ACCESS_COOKIE) && request.cookies.has(REFRESH_COOKIE) && isDocumentNavigation(request)
  );
}

function apiBase(): string | undefined {
  return process.env.NEXT_PUBLIC_API_BASE_URL;
}

/**
 * Spends the refresh token for a new pair. Returns the API's Set-Cookie
 * headers, or null if it declined — in which case the API has already
 * cleared both cookies and the visitor gets the login page, which is the
 * correct outcome for an expired or revoked session.
 */
async function refreshSession(request: NextRequest): Promise<string[] | null> {
  const base = apiBase();
  if (!base) return null;
  const forwardedFor = request.headers.get('x-forwarded-for');

  try {
    const response = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: request.headers.get('cookie') ?? '',
        // Only when there IS one. Sending an empty x-forwarded-for is worse
        // than sending none: with API_TRUST_PROXY on the API parses it where
        // it would otherwise use the socket address, and a degenerate value
        // collapses per-IP rate-limit keys together.
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = response.headers.getSetCookie();
    return setCookie.length > 0 ? setCookie : null;
  } catch {
    // A refresh that cannot reach the API must not take the page down with
    // it. The request proceeds unauthenticated and lands on /login.
    return null;
  }
}

/**
 * Re-scopes the refresh cookie to `/` on the way out.
 *
 * The API scopes it to `/api/v1/auth`, which is right on ITS origin and
 * meaningless on this one — nothing is served there, so the browser would
 * hold a cookie it never sends and the next refresh would never happen.
 * src/lib/auth-cookies.ts does the same thing for the login response; this is
 * the same rule on the refresh path, and the two must agree or a refreshed
 * session would silently revert to unrenewable.
 */
function rescopeRefreshCookie(header: string): string {
  if (!header.startsWith(`${REFRESH_COOKIE}=`)) return header;
  return header.replace(/;\s*Path=[^;]*/i, '; Path=/');
}

/** `name=value` pairs from Set-Cookie headers, for splicing into the request. */
function cookiePairs(setCookieHeaders: string[]): { name: string; value: string }[] {
  return setCookieHeaders
    .map((header) => header.split(';', 1)[0] ?? '')
    .map((pair) => {
      const index = pair.indexOf('=');
      return index === -1 ? null : { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter((pair): pair is { name: string; value: string } => pair !== null);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildCsp(nonce);

  // Next reads the CSP off the REQUEST headers to discover the nonce
  // (`getScriptNonceFromHeader` in app-render), which is why it is set on
  // both sides below.
  //
  // Belt AND braces, established by mutation: removing this request-header
  // line alone changes nothing, because Next's router copies every header
  // the proxy puts on the RESPONSE back onto `req.headers` before rendering
  // (`resolve-routes.js`: `resHeaders[key] = value; req.headers[key] =
  // value`). The response header is therefore load-bearing on its own today.
  // The documented contract is the request header, so it stays — but do not
  // read a passing test as proof that this line is what makes the nonce
  // work.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  // Refresh BEFORE the render, and splice the new access token into the
  // request the render will see. Setting it only on the response would leave
  // this page rendering unauthenticated — a redirect to /login on the very
  // request that just renewed the session.
  const refreshed = shouldRefresh(request) ? await refreshSession(request) : null;
  if (refreshed) {
    const jar = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
    for (const { name, value } of cookiePairs(refreshed)) {
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
    requestHeaders.set(
      'cookie',
      [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    );
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // Hand the browser the rotated pair, verbatim — attributes included, so
  // maxAge and the re-scoped path come straight from the API.
  if (refreshed) for (const header of refreshed) response.headers.append('set-cookie', rescopeRefreshCookie(header));

  response.headers.set('content-security-policy', csp);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );

  // HSTS only over real TLS. Sending it on plain-HTTP localhost pins a
  // developer's browser to https://localhost for two years and makes the dev
  // loop miserable — a self-inflicted outage that is tedious to undo.
  if (isSecureRequest(request)) {
    response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  }

  return response;
}

export const config = {
  // Static assets are immutable and carry no user data; skipping them keeps
  // this off the hot path for every font and chunk.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
