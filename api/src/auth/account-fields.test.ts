import { describe, it, expect } from 'vitest';
import {
  HANDLE_PATTERN,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  RESERVED_HANDLES,
  parseHandle,
  parsePassword,
} from './account-fields.ts';

// These two functions are the ONLY definition of "what a new account may be
// called and what may authenticate as it", and they now have two call sites:
// the first-run bootstrap (auth/bootstrap.ts) and an invited registration
// (invites/accept.ts). The module header names the failure worth engineering
// against — "the second call site quietly accepting a handle or a password the
// first one would have refused" — and that failure is invisible from either
// call site's own tests, because each only ever sees its own inputs. So the
// rule is pinned here, once, at the boundaries.

describe('parseHandle', () => {
  it('normalizes case and surrounding whitespace', () => {
    // A handle is a URL segment (/u/<handle>, design §11). Two accounts whose
    // handles differ only by case or padding would be two URLs for what a
    // human reads as one name, so normalization happens before the uniqueness
    // check the database performs, not after.
    expect(parseHandle('admin', '  Ada_Lovelace ')).toEqual({ ok: true, value: 'ada_lovelace' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { handle: 'ops' }],
    ['an array', ['ops']],
  ])('refuses %s, naming the field', (_label, raw) => {
    // The wizard posts JSON, so the field can be absent or any JSON type. A
    // non-string reaching `.trim()` would be a TypeError — a 500 on the one
    // route that is unauthenticated by design — instead of a 400.
    const result = parseHandle('student', raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('student.handle is required.');
  });

  // HANDLE_PATTERN's `{1,30}` quantifier counts the characters AFTER the
  // leading one, which makes both ends of the range easy to get wrong by one.
  // The database enforces the same rule (migration 0005:
  // users_handle_url_safe), so a parse that is one character looser does not
  // produce a bad handle — it produces a 500 where there should have been a
  // 400.
  it.each([
    ['two characters (the shortest allowed)', 'ab', true],
    ['one character', 'a', false],
    ['thirty-one characters (the longest allowed)', `a${'b'.repeat(30)}`, true],
    ['thirty-two characters', `a${'b'.repeat(31)}`, false],
  ])('accepts/refuses %s', (_label, handle, expected) => {
    expect(parseHandle('admin', handle).ok).toBe(expected);
    // The pattern and the parser must not be able to disagree.
    expect(HANDLE_PATTERN.test(handle)).toBe(expected);
  });

  it.each([
    ['a leading hyphen', '-ops'],
    ['a leading underscore', '_ops'],
    ['a space', 'not a handle'],
    ['a slash, which would forge a path segment', 'ops/admin'],
    ['a dot', 'ops.admin'],
    ['an at sign', 'ops@admin'],
    ['non-ASCII', 'opsé'],
    ['the empty string', ''],
    ['only whitespace', '   '],
    ['a newline, which could split a log line', 'ops\nadmin'],
  ])('refuses %s with the shape message', (_label, handle) => {
    const result = parseHandle('admin', handle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/must be 2-31 characters/);
  });

  it('refuses every reserved handle, including one that only differs by case', () => {
    // Design §11 puts handles at /u/<handle>. These are held back so no
    // account can present itself to another student as platform
    // infrastructure — and because normalization runs first, claiming "ADMIN"
    // must be refused for the same reason claiming "admin" is.
    for (const reserved of RESERVED_HANDLES) {
      const lower = parseHandle('admin', reserved);
      expect(lower.ok).toBe(false);
      if (lower.ok) continue;
      // "u" is refused one step earlier, by the two-character minimum — the
      // reserved list still carries it so that relaxing the length rule
      // cannot quietly hand out the prefix of every profile URL.
      expect(lower.message).toContain(reserved.length < 2 ? 'must be 2-31 characters' : 'reserved');

      expect(parseHandle('admin', reserved.toUpperCase()).ok).toBe(false);
    }
  });

  it('does not reserve a handle that merely contains a reserved word', () => {
    // The check is exact-match on purpose: reserving every substring would
    // deny ordinary names ("administrator" is held back, "adminah" is not).
    expect(parseHandle('admin', 'adminah')).toEqual({ ok: true, value: 'adminah' });
    expect(parseHandle('admin', 'my-api')).toEqual({ ok: true, value: 'my-api' });
  });
});

describe('parsePassword', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number that is long enough as a string', 123456789012],
  ])('refuses %s as a password', (_label, raw) => {
    const result = parsePassword('admin', raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('at least 12');
  });

  it.each([
    ['exactly the minimum length', MIN_PASSWORD_LENGTH, true],
    ['one character short of the minimum', MIN_PASSWORD_LENGTH - 1, false],
    ['exactly the maximum length', MAX_PASSWORD_LENGTH, true],
    ['one character over the maximum', MAX_PASSWORD_LENGTH + 1, false],
  ])('accepts/refuses a password of %s', (_label, length, expected) => {
    expect(parsePassword('admin', 'x'.repeat(length)).ok).toBe(expected);
  });

  it('refuses an over-long password with the upper-bound message, not the lower one', () => {
    // The upper bound is not cosmetic: auth/password.ts hashes with Argon2id
    // at 19 MiB per call, so an unbounded "password" posted to the
    // unauthenticated setup route is a memory exhaustion primitive. A caller
    // told "at least 12 characters" would keep making it longer.
    const result = parsePassword('admin', 'x'.repeat(MAX_PASSWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`at most ${MAX_PASSWORD_LENGTH}`);
  });

  it('never trims or normalizes the password it returns', () => {
    // Trimming would silently change the credential: the account would be
    // created with one secret and the user would be typing another. Unicode
    // normalization would do the same thing less visibly.
    const padded = '  spaces  matter  ';
    expect(parsePassword('admin', padded)).toEqual({ ok: true, value: padded });

    const composed = 'é-not-precomposed';
    expect(parsePassword('admin', composed)).toEqual({ ok: true, value: composed });
  });
});
