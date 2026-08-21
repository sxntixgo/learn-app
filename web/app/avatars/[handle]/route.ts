/*
 * Same-origin proxy for avatar images.
 *
 * The reason this exists rather than pointing `<img src>` at the API is the
 * same one behind settings/account/export/route.ts and
 * admin/imports/stream/route.ts: the CSP is `img-src 'self' data:`
 * (web/proxy.ts), and the session cookie lives on THIS origin, not the API's.
 * A cross-origin avatar would be blocked by the first and anonymous under the
 * second.
 *
 * The URL is built by src/lib/avatar.ts, which parses the API's published
 * path rather than rewriting it, so `handle` here is always something that
 * matched the handle grammar. It is validated again below anyway — this is a
 * route, and a route's parameters come from whoever typed the URL, not from
 * the component that usually links to it.
 *
 * `?v=` is ignored. The API serves the current image whatever is passed; the
 * digest is in the URL so that a REPLACED avatar gets a new URL and a cache
 * cannot keep showing the old face.
 */

export const dynamic = 'force-dynamic';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}$/;

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }
  return base;
}

export async function GET(request: Request, context: { params: Promise<{ handle: string }> }): Promise<Response> {
  const { handle } = await context.params;
  if (!HANDLE_PATTERN.test(handle)) {
    return new Response(null, { status: 404 });
  }

  // Forwarded so the API sees the real viewer. The avatar endpoint is public,
  // but it is rate-limited per IP alongside the profile route, and passing
  // the cookie keeps this proxy from being the one place where a signed-in
  // reader looks anonymous.
  const cookie = request.headers.get('cookie');
  const ifNoneMatch = request.headers.get('if-none-match');

  const upstream = await fetch(`${apiBase()}/api/v1/profiles/${encodeURIComponent(handle)}/avatar`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
    },
    cache: 'no-store',
  });

  if (upstream.status === 304) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: upstream.headers.get('etag') ?? '',
        'Cache-Control': upstream.headers.get('cache-control') ?? 'public, max-age=86400',
      },
    });
  }

  if (!upstream.ok) {
    // No placeholder body: the caller already has the identicon seed and
    // draws that instead. A 404 here is an ordinary outcome, not an error
    // page.
    return new Response(null, { status: upstream.status === 429 ? 429 : 404 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      // Pinned rather than forwarded. The API only ever stores WebP it
      // encoded itself, and this is the header a browser decides what to do
      // with the bytes from — it should not be relayed from an upstream
      // response verbatim.
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      ETag: upstream.headers.get('etag') ?? '',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'public, max-age=86400',
    },
  });
}
