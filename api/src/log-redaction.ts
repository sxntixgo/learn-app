import type { FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// SECRETS DO NOT BELONG IN THE REQUEST LOG.
//
// Fastify's default request serializer logs `req.url` verbatim, query string
// included. `GET /api/v1/invites/lookup?token=<256-bit invite token>` was
// therefore written to stdout in plaintext on every invite preview — straight
// into `docker compose logs`, and into anything shipping those logs onward.
//
// That directly contradicted what invites/token.ts says about its own token:
// "It is never stored, never logged, and cannot be re-derived." An invite
// token is the ONLY gate on registration (design §13: "registration only via
// invite token"), so a live one in a log is an account bound to somebody
// else's address.
//
// The route no longer takes the token in the query string (it moved to the
// X-Invite-Token header, which this serializer does not log either). This
// exists so that the NEXT parameter someone puts in a URL is not a repeat of
// the same incident: the redaction is by parameter NAME, applied to every
// route, so it holds for code nobody has written yet.
// ---------------------------------------------------------------------------

/**
 * Query parameters whose values never appear in a log line.
 *
 * Matched case-insensitively as whole names. Deliberately broad — a false
 * positive costs one unreadable value in a debug session, a false negative
 * costs a credential.
 */
const SENSITIVE_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'setuptoken',
  'setup_token',
  'invite',
  'invitetoken',
  'invite_token',
  'password',
  'secret',
  'code',
  'key',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'authorization',
  'signature',
  'sig',
]);

export const REDACTED = '[redacted]';

/**
 * Rewrites a URL so no sensitive query value survives into a log.
 *
 * Works on the raw string rather than `new URL(...)`: the value here is an
 * origin-form path (`/a/b?c=d`), a fragment is impossible (browsers never
 * send one), and re-serializing through URL would normalise escaping in ways
 * that make a logged URL differ from the one actually requested.
 */
export function redactUrl(url: string): string {
  const split = url.indexOf('?');
  if (split === -1) return url;

  const path = url.slice(0, split);
  const query = url.slice(split + 1);
  if (query === '') return url;

  const redacted = query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const eq = pair.indexOf('=');
      // A bare flag (`?debug`) carries no value to leak.
      if (eq === -1) return pair;

      const rawName = pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // Malformed percent-encoding: fall back to the raw name. Redacting
        // on the undecoded spelling is still better than not redacting.
      }
      return SENSITIVE_PARAMS.has(name.trim().toLowerCase()) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');

  return `${path}?${redacted}`;
}

/**
 * The `req` serializer, mirroring the fields Fastify's default one emits.
 *
 * Headers are NOT logged here, which is what makes moving a secret out of the
 * query string and into a header an actual improvement rather than a shuffle.
 */
export function redactingRequestSerializer(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
