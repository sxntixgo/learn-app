/*
 * Same-origin proxy for the account data export download (plan: "Account
 * deletion and data export"). GET /api/v1/me/export already answers with
 * `content-disposition: attachment` (api/src/routes/me.ts) — the browser
 * only needs to be pointed at a URL that carries the session cookie.
 *
 * That cannot be the API's own origin directly: the session cookie lives on
 * WEB's origin, not the API's (web/src/lib/auth-cookies.ts's `relaySetCookies`
 * re-issues it from Next's own response after every server-to-server call —
 * see its module comment), and the CSP's `connect-src 'self'` plus the API
 * carrying no CORS headers rule out a cross-origin request either way (same
 * constraint app/admin/imports/stream/route.ts documents). So this is a thin
 * Route Handler, same shape as that one: forward the visitor's own cookie
 * to the real API from the Next.js server, and pipe the response straight
 * back — body, status, and the two headers that make it a download —
 * unbuffered and unparsed, so a large export is never held whole in memory
 * here.
 *
 * A plain link/form GET, not a Server Action: a Server Action's return value
 * cannot become a browser download (Next has no way to hand a client a file
 * from one), and this is a read with no input to validate, so there is
 * nothing a Server Action would add.
 */

export const dynamic = 'force-dynamic';

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }
  return base;
}

export async function GET(request: Request): Promise<Response> {
  // Without this the API sees the anonymous actor and `me:export` 403s for
  // everyone, signed in or not — see admin/imports/stream/route.ts's own
  // comment on this exact mistake.
  const cookie = request.headers.get('cookie');

  const upstream = await fetch(`${apiBase()}/api/v1/me/export`, {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });

  // 403 (anonymous, or admin — me:export is SELF for student/teacher only)
  // is passed through as-is rather than translated: this route has no page
  // to redirect from, and the settings screen already hides the link that
  // would lead here for an actor who cannot use it (defence in depth, not
  // the only layer).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      ...(upstream.headers.get('content-disposition')
        ? { 'Content-Disposition': upstream.headers.get('content-disposition')! }
        : {}),
      'Cache-Control': 'no-store',
    },
  });
}
