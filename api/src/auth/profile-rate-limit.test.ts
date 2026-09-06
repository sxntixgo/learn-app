import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CRAMPED_PROFILE_RATE_LIMIT,
  LOUD_PROFILE_RATE_LIMIT,
  MAX_PROFILE_RATE_LIMIT,
  PROFILE_RATE_LIMIT_ENV,
  ProfileRateLimitError,
  describeProfileRateLimit,
  parseProfileRateLimit,
} from './profile-rate-limit.ts';
import { LoginRateLimiter } from './rate-limit.ts';
import { DEFAULT_PROFILE_RATE_LIMIT } from '../routes/profiles.ts';

/**
 * The knob on the ONE public, unauthenticated, database-backed route. Two
 * things these tests exist to hold:
 *
 *   1. Unset must mean exactly what the hardcoded constant meant. A knob that
 *      moves production the day it is added is a regression however good its
 *      validation is.
 *   2. Every spelling that would REMOVE the protection is refused, loudly and
 *      by name. See the module header: `0`, `-1` and a typo all converge on
 *      the same outage in LoginRateLimiter's arithmetic — one request per
 *      minute per address, which is the opposite of what whoever typed them
 *      was reaching for.
 */
describe('parseProfileRateLimit', () => {
  describe('unset — production is unchanged', () => {
    it('is exactly DEFAULT_PROFILE_RATE_LIMIT when the variable is unset', () => {
      expect(parseProfileRateLimit(undefined)).toEqual({ value: DEFAULT_PROFILE_RATE_LIMIT, warning: null });
    });

    it('is the literal 60-per-60s tuning, so the default itself cannot drift unnoticed', () => {
      // Deliberately not written as `toEqual(DEFAULT_PROFILE_RATE_LIMIT)` —
      // that assertion passes even if both sides move together. These are the
      // numbers §11 has shipped since Phase 11.
      expect(parseProfileRateLimit(undefined).value).toEqual({
        maxAttempts: 60,
        windowMs: 60_000,
        baseLockoutMs: 60_000,
        maxLockoutMs: 60_000,
      });
    });

    it('behaves identically to the hardcoded limiter: 60 through, the 61st refused for a minute', () => {
      // The shape that matters, exercised rather than inspected.
      let now = 1_000_000;
      const limiter = new LoginRateLimiter({ ...parseProfileRateLimit(undefined).value, now: () => now });
      const keys = ['profile-ip:203.0.113.7'];

      for (let i = 0; i < 60; i++) {
        expect(limiter.check(keys).allowed).toBe(true);
        limiter.recordFailure(keys);
      }
      const refused = limiter.check(keys);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBe(60);

      // And the lockout expires with the window, never compounding — the
      // invariant routes/profiles.ts documents and this variable must not be
      // able to break.
      now += 60_001;
      expect(limiter.check(keys).allowed).toBe(true);
    });

    it('treats an empty or whitespace value as unset, not as an error', () => {
      // A half-edited `.env` line ("API_PROFILE_RATE_LIMIT=") means "I have
      // not chosen", and the answer to that is today's behaviour.
      for (const raw of ['', '   ', '\t\n']) {
        expect(parseProfileRateLimit(raw)).toEqual({ value: DEFAULT_PROFILE_RATE_LIMIT, warning: null });
      }
    });

    it('returns a fresh object, so a caller cannot mutate the shared default', () => {
      expect(parseProfileRateLimit(undefined).value).not.toBe(DEFAULT_PROFILE_RATE_LIMIT);
    });
  });

  describe('a number — requests per minute, per address', () => {
    it('sets maxAttempts and NOTHING else', () => {
      // The whole surface of this variable. windowMs / baseLockoutMs /
      // maxLockoutMs stay equal to each other, which is what stops a lockout
      // from compounding on an address that once burst.
      expect(parseProfileRateLimit('240').value).toEqual({
        maxAttempts: 240,
        windowMs: DEFAULT_PROFILE_RATE_LIMIT.windowMs,
        baseLockoutMs: DEFAULT_PROFILE_RATE_LIMIT.baseLockoutMs,
        maxLockoutMs: DEFAULT_PROFILE_RATE_LIMIT.maxLockoutMs,
      });
    });

    it('trims surrounding whitespace', () => {
      expect(parseProfileRateLimit('  120  ').value.maxAttempts).toBe(120);
    });

    it('accepts leading zeros as plain decimal', () => {
      expect(parseProfileRateLimit('0060').value.maxAttempts).toBe(60);
    });

    it.each([CRAMPED_PROFILE_RATE_LIMIT, 60, 120, LOUD_PROFILE_RATE_LIMIT])(
      'accepts %i quietly — an ordinary production tuning',
      (limit) => {
        expect(parseProfileRateLimit(String(limit))).toEqual({
          value: { ...DEFAULT_PROFILE_RATE_LIMIT, maxAttempts: limit },
          warning: null,
        });
      },
    );

    it('accepts the ceiling itself', () => {
      expect(parseProfileRateLimit(String(MAX_PROFILE_RATE_LIMIT)).value.maxAttempts).toBe(MAX_PROFILE_RATE_LIMIT);
    });
  });

  describe('"off" is not expressible — every spelling of it is refused', () => {
    // The security judgement, pinned. This endpoint has no account key to
    // fall back on, so the IP bucket is the only thing between a scraper and
    // an enumeration of every handle on the instance. Nothing legitimate
    // needs the limiter gone, and a knob one typo away from removing it is a
    // bad trade — so there is no sentinel for it, in any spelling.
    it.each(['off', 'none', 'no', 'false', 'unlimited', 'infinity', 'inf', 'disable', 'disabled', 'OFF', 'None'])(
      'refuses %s',
      (raw) => {
        expect(() => parseProfileRateLimit(raw)).toThrow(ProfileRateLimitError);
        expect(() => parseProfileRateLimit(raw)).toThrow(PROFILE_RATE_LIMIT_ENV);
        // The refusal explains itself rather than just saying "invalid".
        expect(() => parseProfileRateLimit(raw)).toThrow(/no way to switch this limiter off/);
      },
    );

    it('refuses 0, which would serve ONE profile view per minute per address', () => {
      // Measured against the real LoginRateLimiter: with maxAttempts 0 the
      // `failures < maxAttempts` guard is false from the first request on, so
      // the lockout branch runs immediately. Coercing this to "unlimited"
      // would be guessing at an intent the value does not carry; coercing it
      // to the default would silently ignore the operator.
      expect(() => parseProfileRateLimit('0')).toThrow(ProfileRateLimitError);
      expect(() => parseProfileRateLimit('0')).toThrow(/Zero does not mean "unlimited"/);
      expect(() => parseProfileRateLimit('0')).toThrow(PROFILE_RATE_LIMIT_ENV);
    });

    it.each(['00', '000', ' 0 '])('refuses %s too — the padded zero the spelling check does not see', (raw) => {
      expect(() => parseProfileRateLimit(raw)).toThrow(ProfileRateLimitError);
    });

    it.each(['-1', '-60', '-0'])('refuses %s — negative is the "unlimited" idiom elsewhere, not here', (raw) => {
      expect(() => parseProfileRateLimit(raw)).toThrow(/does not mean\s+"unlimited" here/);
      expect(() => parseProfileRateLimit(raw)).toThrow(PROFILE_RATE_LIMIT_ENV);
    });

    it('refuses a number so large the limiter is present in name only', () => {
      const raw = String(MAX_PROFILE_RATE_LIMIT + 1);
      expect(() => parseProfileRateLimit(raw)).toThrow(ProfileRateLimitError);
      expect(() => parseProfileRateLimit(raw)).toThrow(/indistinguishable from no limit/);
      expect(() => parseProfileRateLimit(raw)).toThrow(String(MAX_PROFILE_RATE_LIMIT));
    });

    it.each(['999999999', '99999999999999999999'])('refuses %s — "off", spelled with digits', (raw) => {
      expect(() => parseProfileRateLimit(raw)).toThrow(ProfileRateLimitError);
    });
  });

  describe('nonsense is refused, never coerced', () => {
    // Each of these becomes NaN in the limiter's arithmetic, where every
    // comparison against NaN is false: the endpoint 429s from the second
    // request onwards and answers `Retry-After: NaN`. A typo must fail at
    // boot, where someone is watching.
    it.each([
      'sixty',
      '60/min',
      '60 per minute',
      '1m',
      '60s',
      '60.0',
      '0.5',
      '1e3',
      '0x3c',
      '+60',
      '60,000',
      '6 0',
      'true',
      'yes',
      'null',
      'NaN',
    ])('refuses %s', (raw) => {
      expect(() => parseProfileRateLimit(raw)).toThrow(ProfileRateLimitError);
      expect(() => parseProfileRateLimit(raw)).toThrow(PROFILE_RATE_LIMIT_ENV);
    });

    it('names the variable and the unit in the message, so the fix is obvious', () => {
      let message = '';
      try {
        parseProfileRateLimit('60/min');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(PROFILE_RATE_LIMIT_ENV);
      expect(message).toContain('whole number of requests per minute');
      expect(message).toContain(String(MAX_PROFILE_RATE_LIMIT));
      // And it says what unset gets you, so "put it back" is one step.
      expect(message).toContain(String(DEFAULT_PROFILE_RATE_LIMIT.maxAttempts));
    });
  });

  describe('the boot warning', () => {
    it('warns above the loud threshold — a harness setting, not a production one', () => {
      const { value, warning } = parseProfileRateLimit(String(LOUD_PROFILE_RATE_LIMIT + 1));
      expect(value.maxAttempts).toBe(LOUD_PROFILE_RATE_LIMIT + 1);
      expect(warning).toContain(PROFILE_RATE_LIMIT_ENV);
      expect(warning).toContain('scraper');
      expect(warning).toContain('not a');
    });

    it('warns for the value the e2e harness uses — the accepted-but-loud case', () => {
      const { value, warning } = parseProfileRateLimit('5000');
      expect(value.maxAttempts).toBe(5000);
      // Accepted: the harness genuinely is one address making a year of
      // profile views in a minute. Never silent: the same value in a
      // deployment would be a mistake.
      expect(warning).not.toBeNull();
      expect(warning).toContain('83x');
    });

    it('warns below the cramped threshold — ordinary browsing would 429', () => {
      const { value, warning } = parseProfileRateLimit(String(CRAMPED_PROFILE_RATE_LIMIT - 1));
      expect(value.maxAttempts).toBe(CRAMPED_PROFILE_RATE_LIMIT - 1);
      expect(warning).toContain(PROFILE_RATE_LIMIT_ENV);
      expect(warning).toContain('429');
      // A shared address is the reason this bites, so the warning points at
      // the setting that decides what an address is.
      expect(warning).toContain('API_TRUST_PROXY');
    });

    it('says nothing at all for an ordinary value', () => {
      expect(parseProfileRateLimit('120').warning).toBeNull();
    });
  });

  it('describes the effective setting for the boot log', () => {
    expect(describeProfileRateLimit(parseProfileRateLimit(undefined).value)).toBe(
      '60 requests per 60s per address, then a 60s lockout',
    );
    expect(describeProfileRateLimit(parseProfileRateLimit('5000').value)).toContain('5000 requests per 60s');
  });

  it('the value playwright.config.ts hands the e2e API is one this module accepts', () => {
    // The harness sets this variable in `webServer.env`, and a rejected value
    // there would stop the API from booting at all — a whole-suite failure
    // whose cause is one line in a config file. Cheaper to catch here.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
    const match = /API_PROFILE_RATE_LIMIT:\s*'(\d+)'/.exec(config);
    expect(match, 'playwright.config.ts should set API_PROFILE_RATE_LIMIT for the e2e API').not.toBeNull();

    const parsed = parseProfileRateLimit(match![1]);
    expect(parsed.value.maxAttempts).toBeGreaterThan(DEFAULT_PROFILE_RATE_LIMIT.maxAttempts);
    expect(parsed.value.maxAttempts).toBeLessThanOrEqual(MAX_PROFILE_RATE_LIMIT);
  });
});
