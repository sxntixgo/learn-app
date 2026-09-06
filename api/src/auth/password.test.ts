import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } from './password.ts';

describe('password hashing (design §13: Argon2id)', () => {
  it('produces an Argon2id PHC string with the configured cost parameters', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=19456,t=2,p=1');
  });

  it('salts: the same password hashes to two different strings, both verifying', async () => {
    const a = await hashPassword('correct-horse-battery-staple');
    const b = await hashPassword('correct-horse-battery-staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'correct-horse-battery-staple')).toBe(true);
    expect(await verifyPassword(b, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'correct-horse-battery-stapl')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('refuses to hash an unbounded password (CPU exhaustion primitive)', async () => {
    await expect(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(/at most/);
  });

  // =========================================================================
  // THE INHERITED CONSTRAINT (db/migrations/0005_identity.sql):
  // `users.password_hash` is nullable and NULL today. NULL means "this
  // account has no credential and cannot authenticate" — an unconditional
  // failure, never an empty hash, a wildcard, or a skipped check.
  // =========================================================================
  describe('a NULL password_hash is an unconditional failure', () => {
    const anyInput = [
      '',
      ' ',
      'correct-horse-battery-staple',
      'null',
      'undefined',
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'x'.repeat(MAX_PASSWORD_LENGTH + 1),
    ];

    for (const input of anyInput) {
      it(`fails for ${JSON.stringify(input.slice(0, 24))}`, async () => {
        expect(await verifyPassword(null, input)).toBe(false);
      });
    }

    it('fails for undefined and for a hash column that is empty or malformed', async () => {
      expect(await verifyPassword(undefined, 'correct-horse-battery-staple')).toBe(false);
      expect(await verifyPassword('', '')).toBe(false);
      expect(await verifyPassword('   ', '   ')).toBe(false);
      expect(await verifyPassword('not-a-hash', 'not-a-hash')).toBe(false);
      // A bcrypt/plaintext value in the column must not be honoured either:
      // this codebase mints Argon2id and nothing else.
      expect(await verifyPassword('$2b$12$abcdefghijklmnopqrstuv', 'anything')).toBe(false);
    });

    it('does the same Argon2id work for a missing credential as for a real one', async () => {
      // Not a bypass detector — a timing-leak detector. If a NULL hash
      // returned early, "no such account" would be distinguishable from
      // "wrong password" by a stopwatch, which enumerates accounts.
      const started = process.hrtime.bigint();
      expect(await verifyPassword(null, 'correct-horse-battery-staple')).toBe(false);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs).toBeGreaterThan(3);
    });
  });

  it('refuses to hash a non-string, rather than letting argon2 coerce it', async () => {
    // `password` arrives from a JSON body, so it can be a number, a boolean,
    // an object or absent. The callers validate first (auth/account-fields.ts),
    // but this is the last line before the native binding: coercing `123456`
    // to "123456" would mint a credential the user never chose, and handing
    // the binding a non-string is how you get a segfault instead of a 400.
    for (const bad of [123456789012, true, null, undefined, {}, ['x']]) {
      await expect(hashPassword(bad as unknown as string)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('treats a corrupt Argon2id digest in the column as a failed login, not a 500', async () => {
    // `usable` only checks the `$argon2id$` prefix, so a column value that is
    // truncated, half-written by a bad restore, or hand-edited gets as far as
    // the native verifier — which throws on an unparseable PHC string. If that
    // escaped, one damaged row would turn that account's every login attempt
    // into a 500 and hand the operator a stack trace instead of "wrong
    // password". It has to fail closed and quietly.
    for (const corrupt of [
      '$argon2id$',
      '$argon2id$v=19$',
      '$argon2id$v=19$m=19456,t=2,p=1$',
      '$argon2id$v=19$m=19456,t=2,p=1$not-base64!!$also-not-base64!!',
    ]) {
      await expect(verifyPassword(corrupt, 'correct-horse-battery-staple')).resolves.toBe(false);
    }
  });

  it('rejects an over-long candidate against a real hash without hashing it', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'correct-horse-battery-staple'.padEnd(MAX_PASSWORD_LENGTH + 1, 'x'))).toBe(false);
  });
});
