import type { FastifyReply } from 'fastify';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.ts';
import { REFRESH_TOKEN_TTL_DAYS } from './refresh-token.ts';

// Session cookies (design §13: "httpOnly + Secure + SameSite cookie").
//
// Cookies rather than an Authorization header, deliberately: the reader is a
// server-rendered Next.js app, and a token in JavaScript-readable storage is
// one XSS away from being exfiltrated. httpOnly takes that off the table.
//
//   httpOnly   no script on any page can read either token.
//   secure     never sent over plaintext HTTP. Browsers treat localhost as a
//              trustworthy origin, so this holds in development too.
//   sameSite   'lax': not attached to cross-site POSTs, which is what stops
//              a third-party page from driving the refresh or logout routes
//              on a signed-in visitor's behalf. 'strict' would additionally
//              drop the cookie on a plain link INTO the app, logging the
//              reader out every time they follow one — the wrong trade for a
//              reading platform.
//
// The refresh cookie is scoped to the auth routes: it is a credential that
// only /api/v1/auth/* has any use for, so it is not attached to the hundreds
// of ordinary requests that could log or leak it.

export const ACCESS_COOKIE = 'learn_at';
export const REFRESH_COOKIE = 'learn_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const BASE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const;

export interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  /** The refresh token's own expiry — the cookie should not outlive the row. */
  refreshExpiresAt: Date;
}

/** Attaches a freshly minted pair of session cookies to `reply`. */
export function setSessionCookies(reply: FastifyReply, session: SessionCookies): void {
  reply.setCookie(ACCESS_COOKIE, session.accessToken, {
    ...BASE,
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });

  // maxAge derived from the row rather than assumed, so a rotated token's
  // cookie expires with the family instead of outliving it by up to a day.
  const maxAge = Math.max(1, Math.floor((session.refreshExpiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
    ...BASE,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.min(maxAge, REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60),
  });
}

/**
 * Removes both cookies. Called on logout AND on every failed refresh —
 * including a detected reuse, where leaving a dead refresh cookie in place
 * would have the client retry a revoked family forever.
 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { ...BASE, path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...BASE, path: REFRESH_COOKIE_PATH });
}
