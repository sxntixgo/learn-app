/*
 * Same-origin proxy for the admin import stream (design plan phase 5).
 *
 * The browser cannot fetch the API directly here: there is no CORS
 * configuration on the API (nor should there be — CLAUDE.md rule 1: web
 * talks to the API over HTTP only, the API is not a public origin), and
 * every other interactive control in this app reaches the API from the
 * Next.js server rather than the browser (see the lesson reader's
 * actions.ts). A streaming response is the one thing a Server Action can't
 * forward, so this is a thin Route Handler instead: it re-POSTs the body to
 * the real API and pipes the response stream straight back, unbuffered.
 *
 * `force-dynamic` + `no-store`: this must never be cached — every call
 * kicks off a real clone and a real database write.
 */

export const dynamic = 'force-dynamic';

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }
  return base;
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const upstream = await fetch(`${apiBase()}/api/v1/admin/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    cache: 'no-store',
  });

  // Piped straight through — not read/parsed here — so the browser sees
  // each NDJSON line as soon as the API writes it, not after the whole
  // import finishes.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}
