import { createHash, randomBytes } from 'node:crypto';

// Invite tokens (design §12, §13).
//
// "Invite tokens are stored hashed, single-use, expiring, and bound to the
// invited email."
//
// Deliberately the same construction as the first-run setup token
// (api/src/auth/setup-token.ts), for the same reasons, and kept as its own
// module rather than imported from there because the two secrets have
// different lifetimes and different call sites — sharing the function would
// invite a future change to one to silently change the other.
//
// SHA-256 and not Argon2id: this is a 256-bit random token, not a
// human-chosen password. There is no dictionary to attack and nothing an
// attacker can do with a partial preimage, so a KDF would buy nothing and
// only suggest the two kinds of secret are interchangeable. Password hashing
// (Argon2id, §13) is api/src/auth/password.ts's job.
//
// The plaintext exists in exactly two places: the response to the person who
// issued the invite, and the link they send. It is never stored, never
// logged, and cannot be re-derived — an invite whose link was lost is
// revoked and re-issued, not recovered.

const INVITE_TOKEN_BYTES = 32;

/** How long an invite lives when the issuer does not say. */
export const DEFAULT_INVITE_TTL_DAYS = 14;

/** The bounds an issuer may choose between. */
export const MIN_INVITE_TTL_DAYS = 1;
export const MAX_INVITE_TTL_DAYS = 90;

/** A fresh 256-bit invite token, URL-safe so it survives being pasted into a link. */
export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** The only form of the token that is ever persisted. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// CLAIM TOKENS — the second half of "an invite link is spent when opened".
//
// The URL token survives one request. Opening the link consumes it and mints
// one of these, which travels in a response BODY and lives in an httpOnly
// cookie, never in a URL — so the proxy access log, browser history and
// Referer never see it. The accept step presents this, not the link token.
//
// Same construction as the URL token, and deliberately not the same function:
// these two have different lifetimes (14 days versus minutes) and different
// call sites, exactly the reasoning in this file's header for keeping invite
// and setup tokens apart.
// ---------------------------------------------------------------------------

/** How long a claim lives once a link has been opened. */
export const CLAIM_TOKEN_TTL_MINUTES = 30;

/** A fresh 256-bit claim token. */
export function generateClaimToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** The only form of the claim token that is ever persisted. */
export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
