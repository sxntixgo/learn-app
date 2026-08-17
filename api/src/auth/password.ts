import { randomBytes } from 'node:crypto';
import type { Algorithm } from '@node-rs/argon2';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

// Password hashing (design §13: "Passwords hashed with Argon2id").
//
// Two properties this module exists to guarantee, both of which are easy to
// lose by accident elsewhere:
//
//   1. A NULL `users.password_hash` is an UNCONDITIONAL failure.
//      db/migrations/0005_identity.sql lands that column nullable and NULL:
//      "NULL means this account has no credential and cannot authenticate —
//      whatever verifies a password later must treat NULL as an
//      unconditional failure rather than as an empty hash." Below, the null
//      case cannot reach a `true` return: the result is `&&`-ed with a flag
//      that is false whenever the stored value is not an Argon2id digest, so
//      even a hypothetically matching verify cannot produce a success.
//
//   2. Failure looks and COSTS the same whether or not the account exists.
//      A caller that returns early for an unknown email leaks account
//      existence through a stopwatch. So when there is no usable stored
//      hash, this module still performs a full Argon2id verification against
//      a decoy digest before returning false. Callers therefore always call
//      verifyPassword(row?.password_hash ?? null, candidate) — never
//      `if (!row) return 401` before the hash work.

// OWASP Password Storage Cheat Sheet's Argon2id baseline: m=19 MiB, t=2,
// p=1. Deliberately the low-memory/high-iteration end of the recommended
// set, because this runs in a self-hosted single-container deployment where
// a 64 MiB-per-login hash is a denial-of-service surface, not a hardening
// measure.
const MEMORY_COST_KIB = 19456;
const TIME_COST = 2;
const PARALLELISM = 1;
const OUTPUT_LENGTH = 32;

const ARGON2ID_PREFIX = '$argon2id$';

/**
 * Longest password this module will hash or verify. Matches
 * auth/bootstrap.ts's own bound: without it, a megabyte-long "password" is a
 * CPU exhaustion primitive pointed at the one endpoint that is
 * unauthenticated by definition.
 */
export const MAX_PASSWORD_LENGTH = 200;

// @node-rs/argon2 exports `Algorithm` as an ambient const enum, which
// `verbatimModuleSyntax` (tsconfig.base.json) forbids importing as a value.
// The discriminant is part of that crate's public API — Argon2d 0, Argon2i 1,
// Argon2id 2 — and password.test.ts asserts the digest really comes out as
// `$argon2id$...`, so a wrong number here fails loudly rather than silently
// hashing with the wrong variant.
const ARGON2ID = 2 as Algorithm;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: MEMORY_COST_KIB,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
  outputLen: OUTPUT_LENGTH,
} as const;

// The decoy is hashed from fresh random bytes on first use, not from a
// constant in the source. It is not a secret — it exists only to consume the
// same CPU a real verification would — but a literal here would read like
// one, and this repository is public (CLAUDE.md: "never default a secret in
// code"). Computed once per process and reused; the promise itself is the
// cache, so concurrent first calls share one hash.
let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= argon2Hash(randomBytes(32).toString('base64url'), OPTIONS);
  return decoy;
}

/** Hashes a password for storage in `users.password_hash`. */
export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string') {
    throw new TypeError('password must be a string');
  }
  if (plaintext.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return argon2Hash(plaintext, OPTIONS);
}

/**
 * Verifies a candidate password against a stored hash.
 *
 * `storedHash` is deliberately typed to accept null/undefined: that is what
 * `users.password_hash` holds for an account with no credential, and what a
 * caller has for an email that matches no account at all. Both return false,
 * after the same work.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  candidate: string | null | undefined,
): Promise<boolean> {
  // "Usable" is narrow on purpose: only a digest this codebase could have
  // minted. A bcrypt string, a plaintext password accidentally written to
  // the column, an empty string, or NULL are all equally not-a-credential.
  const usable = typeof storedHash === 'string' && storedHash.startsWith(ARGON2ID_PREFIX);
  const input = typeof candidate === 'string' ? candidate : '';
  const bounded = input.length <= MAX_PASSWORD_LENGTH;

  // Every path below runs one Argon2id verification, against the real hash
  // when there is one and against the decoy otherwise.
  const target = usable ? storedHash : await decoyHash();
  const probe = bounded ? input : input.slice(0, MAX_PASSWORD_LENGTH);

  let matched = false;
  try {
    matched = await argon2Verify(target, probe);
  } catch {
    // A corrupt or unparseable digest is a failed verification, not a 500.
    matched = false;
  }

  // The `usable &&` is the load-bearing part: no stored credential can ever
  // yield true here, whatever the decoy did.
  return usable && bounded && matched;
}
