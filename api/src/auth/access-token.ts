import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '../policy/can.ts';
import { KNOWN_ROLES } from '../policy/can.ts';
import type { SigningKeys } from './keys.ts';
import { getSigningKeys } from './keys.ts';

// The access token (design §13): "EdDSA-signed JWT access token, ~15
// minutes, httpOnly + Secure + SameSite cookie."
//
// Short-lived by design, because it is the one credential that is NOT
// checked against the database on every request. Fifteen minutes bounds how
// long a stale role claim can survive — and design §13's other half closes
// even that window for the cases that matter: "role is in the token for
// cheap reads; privileged mutations re-check the database, so a demotion
// takes effect immediately rather than at next refresh" (see auth/roles.ts).

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Both `iss` and `aud`. A token minted for anything else is not ours. */
export const TOKEN_ISSUER = 'learn-app';

/** The only accepted signature algorithm. Never widened, never read from the token. */
const ALGORITHM = 'EdDSA';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  userId: string;
  roles: Role[];
}

interface SignOverrides {
  issuer?: string;
  audience?: string;
}

/**
 * Mints an access token. `ttlSeconds` and `overrides` exist for tests
 * (expiry and foreign-issuer cases); production callers pass neither.
 */
export async function signAccessToken(
  claims: AccessTokenClaims,
  keys: SigningKeys = getSigningKeys(),
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  overrides: SignOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: claims.roles })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setIssuer(overrides.issuer ?? TOKEN_ISSUER)
    .setAudience(overrides.audience ?? TOKEN_ISSUER)
    .sign(keys.privateKey);
}

/**
 * Verifies an access token, returning its claims or null.
 *
 * Null for every failure — expired, tampered, foreign key, wrong issuer,
 * unparseable — and never a throw, because the caller (the actor hook) turns
 * "no valid token" into an anonymous actor rather than into a 500. The
 * distinction between kinds of invalid token is deliberately not surfaced:
 * nothing downstream may branch on it.
 */
export async function verifyAccessToken(
  token: string,
  keys: SigningKeys = getSigningKeys(),
): Promise<AccessTokenClaims | null> {
  if (typeof token !== 'string' || token === '') return null;

  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      // Pinned. This is what makes `alg: none` and the HS256-with-the-public-
      // key confusion attack fail at the library boundary rather than
      // depending on a check further in.
      algorithms: [ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_ISSUER,
      clockTolerance: 0,
      requiredClaims: ['sub', 'exp', 'iat'],
    });

    const subject = payload.sub;
    // A subject that is not a users.id shape cannot be one, and every
    // downstream query interpolates it as a uuid parameter.
    if (typeof subject !== 'string' || !UUID_PATTERN.test(subject)) return null;

    // The signature proves this API minted the token; the filter makes sure a
    // role string this codebase does not know can never reach can(), whatever
    // a future signer puts in the claim.
    const rawRoles = Array.isArray(payload.roles) ? payload.roles : [];
    const roles = rawRoles.filter((role): role is Role => typeof role === 'string' && KNOWN_ROLES.has(role as Role));

    return { userId: subject, roles };
  } catch {
    return null;
  }
}
