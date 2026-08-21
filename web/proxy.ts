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

export function proxy(request: NextRequest): NextResponse {
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

  const response = NextResponse.next({ request: { headers: requestHeaders } });

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
