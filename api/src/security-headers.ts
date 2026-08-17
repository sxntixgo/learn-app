import type { FastifyInstance } from 'fastify';

/**
 * Security headers for API responses.
 *
 * The API serves JSON to a first-party browser client, so it needs a much
 * smaller set than the web app: it renders no HTML, so a CSP would have
 * nothing to govern. What it does need is to never be sniffed as another
 * content type, and to never let an authenticated response linger in a cache.
 */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');

    // Deny framing outright: nothing here is meant to be embedded, and an API
    // that renders no HTML has no legitimate reason to be in a frame.
    reply.header('x-frame-options', 'DENY');

    // Authenticated JSON must not be cached. `/health` is the one route with
    // no actor behind it and no user data in it, so it is left alone; every
    // other response is either about a specific actor or gated by one, and a
    // shared cache holding those is a cross-user leak.
    if (request.url !== '/api/v1/health') {
      reply.header('cache-control', 'no-store, private');
      reply.header('pragma', 'no-cache');
    }

    return payload;
  });
}
