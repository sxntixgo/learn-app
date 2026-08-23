import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor, Role } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { signAccessToken } from '../auth/access-token.ts';
import { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } from '../auth/password.ts';
import { MIN_PASSWORD_LENGTH } from '../auth/account-fields.ts';
import { loadRoles } from '../auth/roles.ts';
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeDeviceSessions,
  revokeSession,
  rotateRefreshToken,
} from '../auth/refresh-token.ts';
import { clearSessionCookies, setSessionCookies, REFRESH_COOKIE } from '../auth/cookies.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';
import type { SigningKeys } from '../auth/keys.ts';
import { getSigningKeys } from '../auth/keys.ts';

// The auth routes (design §13): login, refresh, logout, logout-all.
//
// These four are the only routes in the codebase that create or destroy a
// session. Everything else consults `request.actor` and `can()` and never
// thinks about tokens at all.
//
// Two rules hold across all of them:
//
//   1. NO ORACLES. Every login failure — unknown email, wrong password, an
//      account whose password_hash is NULL (design's inherited constraint:
//      "no credential, authentication is impossible") — produces the same
//      401, the same body, and the same Argon2id work. auth/password.ts
//      guarantees the last of those; this file guarantees the first two by
//      never branching on which one happened.
//   2. FAILURE CLEARS COOKIES. A refresh that fails for any reason clears
//      both cookies. Otherwise a client holding a token from a revoked
//      family retries it forever, and each retry re-enters reuse detection.

const MAX_EMAIL_LENGTH = 254;
const MAX_DEVICE_LABEL_LENGTH = 64;

/** One message for every credential failure. Nothing downstream may vary it. */
const INVALID_CREDENTIALS = 'Invalid email or password.';
const NO_SESSION = 'Not signed in.';

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export interface AuthRouteDeps {
  can?: typeof defaultCan;
  /** Test seam only — see auth/actor.ts. */
  actor?: Actor;
  /** Injectable so a test can configure a small attempt count. */
  loginRateLimiter?: LoginRateLimiter;
  signingKeys?: SigningKeys;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
  deviceLabel?: unknown;
}

interface UserRow {
  id: string;
  email: string | null;
  handle: string | null;
  display_name: string | null;
  password_hash: string | null;
}

interface SessionUser {
  id: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
  roles: Role[];
}

function sessionUser(row: UserRow, roles: Role[]): SessionUser {
  return { id: row.id, email: row.email, handle: row.handle, displayName: row.display_name, roles };
}

/**
 * Rate-limit keys for one attempt: the client address and the account being
 * reached for. Both, always — see auth/rate-limit.ts for why either alone
 * has a trivial workaround.
 */
function limitKeys(request: FastifyRequest, email: string | null): string[] {
  const keys = [`ip:${request.ip}`];
  if (email) keys.push(`account:${email}`);
  return keys;
}

/** Device labels are echoed back in a future "your sessions" screen; keep them boring. */
function normalizeDeviceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, MAX_DEVICE_LABEL_LENGTH);
}

async function startSession(
  reply: FastifyReply,
  keys: SigningKeys,
  user: UserRow,
  roles: Role[],
  deviceLabel: string | null,
): Promise<void> {
  const pool = getPool();

  // "One per device" (design §13): a fresh login on a device supersedes that
  // device's previous session instead of leaving a second live family behind
  // that nothing will ever revoke.
  await revokeDeviceSessions(pool, user.id, deviceLabel);

  const refresh = await issueRefreshToken(pool, { userId: user.id, deviceLabel });
  const accessToken = await signAccessToken({ userId: user.id, roles }, keys);

  setSessionCookies(reply, {
    accessToken,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  });
}

/** Registers /api/v1/auth/* (design §13). */
export function registerAuthRoutes(fastify: FastifyInstance, deps: AuthRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;
  const rateLimiter = deps.loginRateLimiter ?? new LoginRateLimiter();
  const keys = () => deps.signingKeys ?? getSigningKeys();

  fastify.post<{ Body: LoginBody }>('/api/v1/auth/login', async (request, reply) => {
    const body = request.body ?? {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === 'string' ? body.password : null;
    const deviceLabel = normalizeDeviceLabel(body.deviceLabel);

    // Shape errors are answered before anything else and do not depend on
    // whether the account exists, so they are not an oracle.
    if (!email || email.length > MAX_EMAIL_LENGTH || password === null) {
      return reply.code(400).send({ message: 'email and password are required.' });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      // Refused before hashing: this is the one unauthenticated endpoint that
      // does expensive work on request input.
      return reply.code(400).send({ message: `password must be at most ${MAX_PASSWORD_LENGTH} characters.` });
    }

    const throttleKeys = limitKeys(request, email);
    const decision = rateLimiter.check(throttleKeys);
    if (!decision.allowed) {
      // Checked BEFORE the lookup and the hash, so a locked-out attacker
      // cannot use the endpoint as a CPU sink either.
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      return reply.code(429).send({ message: 'Too many login attempts. Try again later.' });
    }

    const found = await getPool().query<UserRow>(
      'select id, email, handle, display_name, password_hash from users where email = $1',
      [email],
    );
    const user = found.rows[0];

    // Called unconditionally, with null when there is no such account: same
    // work, same shape, whether or not the email exists — and a NULL
    // password_hash (an account with no credential) can never verify.
    const ok = await verifyPassword(user?.password_hash ?? null, password);
    if (!user || !ok) {
      rateLimiter.recordFailure(throttleKeys);
      return reply.code(401).send({ message: INVALID_CREDENTIALS });
    }

    rateLimiter.reset(throttleKeys);

    const roles = await loadRoles(getPool(), user.id);
    await startSession(reply, keys(), user, roles, deviceLabel);

    await getPool().query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'auth.login', $2, $3::jsonb)`,
      [user.id, user.handle, JSON.stringify({ deviceLabel, roles })],
    );

    return reply.code(200).send({ user: sessionUser(user, roles) });
  });

  fastify.post('/api/v1/auth/refresh', async (request, reply) => {
    const presented = request.cookies?.[REFRESH_COOKIE];
    if (typeof presented !== 'string' || presented === '') {
      clearSessionCookies(reply);
      return reply.code(401).send({ message: NO_SESSION });
    }

    const rotated = await rotateRefreshToken(getPool(), presented);
    if (!rotated.ok) {
      // Deliberately one response for 'unknown', 'expired', 'revoked' and
      // 'reuse'. A client cannot act differently on them, and telling an
      // attacker that their stolen token was the one that tripped detection
      // only helps them time the next attempt.
      request.log.warn({ reason: rotated.reason }, 'refresh token rejected');
      clearSessionCookies(reply);
      return reply.code(401).send({ message: 'Your session has expired. Please sign in again.' });
    }

    const found = await getPool().query<UserRow>(
      'select id, email, handle, display_name, password_hash from users where id = $1',
      [rotated.userId],
    );
    const user = found.rows[0];
    if (!user) {
      clearSessionCookies(reply);
      return reply.code(401).send({ message: 'Your session has expired. Please sign in again.' });
    }

    // Roles are re-read here as well as at login, so the new access token
    // carries the current set rather than copying a stale claim forward.
    const roles = await loadRoles(getPool(), user.id);
    const accessToken = await signAccessToken({ userId: user.id, roles }, keys());

    setSessionCookies(reply, {
      accessToken,
      refreshToken: rotated.token,
      refreshExpiresAt: rotated.expiresAt,
    });

    return reply.code(200).send({ user: sessionUser(user, roles) });
  });

  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    // Keyed off the refresh cookie rather than the actor: signing out must
    // work when the access token has already expired, which is precisely
    // when a user reaches for it.
    const presented = request.cookies?.[REFRESH_COOKIE];
    if (typeof presented === 'string' && presented !== '') {
      await revokeSession(getPool(), presented);
    }
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  /**
   * Change your own password (design §13).
   *
   * THE ONLY CREDENTIAL-CHANGE PATH IN THE SYSTEM. §2 excludes password-reset
   * mail and SMTP from the design entirely, so there is no "forgot password"
   * and no admin override: an account that cannot use this route can never
   * change its password at all. That is why the matrix grants it to admin as
   * well, unlike `me:delete`.
   *
   * THE CURRENT PASSWORD IS REQUIRED even though the caller already holds a
   * valid session. A session proves possession of a browser, not knowledge of
   * the credential — an unlocked laptop should not be able to lock its owner
   * out of their own instance.
   *
   * Rate-limited on the same limiter as login, keyed the same way. This is a
   * password-guessing oracle otherwise: unlimited attempts at
   * `currentPassword` with no lockout.
   */
  fastify.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
    '/api/v1/auth/password',
    async (request, reply) => {
      const actor = actorFor(request, deps);

      if (!can(actor, 'me:password:update', { userId: actor.id })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const body = request.body ?? {};
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      // Shape first, before the expensive verify and before anything is read
      // — same order as every other route here.
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ message: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      }
      if (newPassword.length > MAX_PASSWORD_LENGTH) {
        return reply.code(400).send({ message: `newPassword must be at most ${MAX_PASSWORD_LENGTH} characters.` });
      }
      if (newPassword === currentPassword) {
        return reply.code(400).send({ message: 'The new password must be different from the current one.' });
      }

      const throttleKeys = [`pw-ip:${request.ip}`, `pw-account:${actor.id}`];
      const decision = rateLimiter.check(throttleKeys);
      if (!decision.allowed) {
        reply.header('Retry-After', String(decision.retryAfterSeconds));
        return reply.code(429).send({ message: 'Too many attempts. Try again later.' });
      }

      const pool = getPool();
      const { rows } = await pool.query<{ password_hash: string | null }>(
        'select password_hash from users where id = $1',
        [actor.id],
      );
      const stored = rows[0];
      if (!stored || !(await verifyPassword(stored.password_hash, currentPassword))) {
        rateLimiter.recordFailure(throttleKeys);
        // Same shape as a failed login, deliberately: this must not become a
        // way to confirm a password from inside a stolen session any faster
        // than the login route allows from outside one.
        return reply.code(401).send({ message: 'Incorrect password.' });
      }
      rateLimiter.reset(throttleKeys);

      await pool.query('update users set password_hash = $2 where id = $1', [actor.id, await hashPassword(newPassword)]);

      // EVERY OTHER SESSION GOES. Changing a password because someone else may
      // know it accomplishes nothing while their session keeps working.
      await revokeAllForUser(pool, actor.id);

      // ...and a fresh one for this device, so the person who just did it is
      // not signed out by their own action.
      const roles = await loadRoles(pool, actor.id);
      const refresh = await issueRefreshToken(pool, { userId: actor.id, deviceLabel: null });
      setSessionCookies(reply, {
        accessToken: await signAccessToken({ userId: actor.id, roles }, keys()),
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt,
      });

      return reply.code(204).send();
    },
  );

  fastify.post('/api/v1/auth/logout-all', async (request, reply) => {
    const actor = actorFor(request, deps);

    // Through the policy seam like every other route: an anonymous actor is
    // refused by can(), not by a check written here.
    if (!can(actor, 'session:revoke:all', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const families = await revokeAllForUser(getPool(), actor.id);
    await getPool().query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'auth.logout_all', null, $2::jsonb)`,
      [actor.id, JSON.stringify({ families })],
    );

    clearSessionCookies(reply);
    return reply.code(204).send();
  });
}
