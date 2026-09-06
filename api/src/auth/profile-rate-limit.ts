import type { RateLimitOptions } from './rate-limit.ts';
import { TRUST_PROXY_ENV } from './trust-proxy.ts';
import { DEFAULT_PROFILE_RATE_LIMIT } from '../routes/profiles.ts';

// ---------------------------------------------------------------------------
// HOW MANY PUBLIC PROFILE READS ONE ADDRESS GETS PER MINUTE.
//
// GET /api/v1/profiles/:handle is the one unauthenticated, database-backed
// route in the API (design §11), so it is the one that has to defend itself
// with an IP bucket instead of a session. routes/profiles.ts explains the
// tuning; this module only decides where the NUMBER comes from, which until
// now was "hardcoded, 60".
//
// WHY IT NEEDS TO BE A KNOB AT ALL. The bucket is per `request.ip`, and
// `request.ip` is whatever API_TRUST_PROXY resolved to — so every reader
// behind one NAT, one office egress, or one misconfigured proxy shares a
// single allowance of 60/min for a PUBLIC page. .env.example already tells
// operators the two limiters key on that setting; this is the other half of
// that sentence. The e2e suite is the same shape in miniature: every
// Playwright worker plus the Next server share 127.0.0.1, and the suite
// opens /u/:handle far more often in a minute than a person ever would.
//
// ---------------------------------------------------------------------------
// WHY "OFF" IS NOT EXPRESSIBLE. Decided deliberately, and the reason is the
// point of this module:
//
//   * A configurable limiter is a disablable one. This endpoint is public and
//     unauthenticated — there is no account key to fall back on (keying on
//     the handle would let one attacker lock every visitor out of a popular
//     profile), so the IP bucket is the ONLY thing standing between a scraper
//     and an enumeration of every handle on the instance. The route counts
//     BEFORE it touches the database precisely so that enumeration is not
//     free; "off" hands that back.
//   * Nothing needs it. Every real reason to touch this setting — NAT, a
//     load test, this repo's own Playwright suite — wants a HIGHER finite
//     number, not the absence of one. A sentinel that no legitimate
//     deployment needs, but that one typo can reach, is a bad trade.
//   * Its failure is silent. A limiter that is off throws nothing, logs
//     nothing and serves every request; the misconfiguration is visible only
//     in an access log nobody is reading, months later.
//
// So there is no 0, no -1, no "off", no "none", no "unlimited". Every one of
// those spellings is refused BY NAME at boot. `MAX_PROFILE_RATE_LIMIT` closes
// the other door: a number large enough to be indistinguishable from no limit
// is refused as well, so "off" cannot be spelled with enough digits either.
//
// ---------------------------------------------------------------------------
// WHY NONSENSE IS REFUSED RATHER THAN COERCED. This is not fastidiousness —
// LoginRateLimiter's arithmetic turns each of these into the OPPOSITE of what
// the operator was reaching for. Measured against the real class:
//
//   maxAttempts = 0     first request allowed, then 429 for 60s, forever
//   maxAttempts = -1    identical: `failures < maxAttempts` is false, so the
//                       lockout branch runs from the first request on
//   maxAttempts = NaN   identical, and it answers `Retry-After: NaN`, because
//                       every comparison against NaN is false
//
// An operator who writes `API_PROFILE_RATE_LIMIT=0` or `=-1` means "stop
// limiting me". What they would get is ONE profile view per minute per
// address — the public page effectively taken down, by the setting meant to
// open it up. `=sixty` or `=60/min` gets the same outage from a typo. None of
// these is a value to clamp into range: the intent behind them cannot be
// recovered, so the only honest response is to refuse at boot, where an
// operator is watching, rather than at 3am in an access log.
//
// ---------------------------------------------------------------------------
// WHY ONE NUMBER AND NOT FOUR. `RateLimitOptions` has four fields, and this
// variable sets exactly one of them: `maxAttempts`. The other three are held
// at 60_000ms because routes/profiles.ts's header documents an INVARIANT
// between them — the lockout and the forget window must be the same length,
// or every request that gets through after the threshold doubles the next
// lockout and an address that once burst never fully recovers. Exposing
// `windowMs`, `baseLockoutMs` and `maxLockoutMs` individually would let a
// deployment break that invariant with a plausible-looking .env line, and
// nothing about the problem this knob solves requires it. With the window
// fixed at a minute, the variable reads as exactly what it is: requests per
// minute, per address.
// ---------------------------------------------------------------------------

export const PROFILE_RATE_LIMIT_ENV = 'API_PROFILE_RATE_LIMIT';

/**
 * The ceiling. ~1 700 requests/second from a single address is orders of
 * magnitude past any human, any NAT'd office and this repo's own e2e suite;
 * past it the limiter is nominally present and practically absent, which is
 * the "off" this module refuses to make expressible.
 */
export const MAX_PROFILE_RATE_LIMIT = 100_000;

/**
 * Above this, the setting is a harness/trusted-network choice rather than a
 * production one, so it is accepted but never silently.
 */
export const LOUD_PROFILE_RATE_LIMIT = 600;

/**
 * Below this, ordinary browsing 429s: one profile view is more than one
 * request, and a whole office can be behind one address.
 */
export const CRAMPED_PROFILE_RATE_LIMIT = 10;

export interface ParseProfileRateLimitResult {
  /** Ready to hand to `new LoginRateLimiter(...)`. */
  value: Omit<RateLimitOptions, 'now'>;
  /** A line worth printing at boot, or null when the setting is unremarkable. */
  warning: string | null;
}

/** Refusals carry this so a caller can tell a bad setting from a bug. */
export class ProfileRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileRateLimitError';
  }
}

const CANNOT_BE_DISABLED =
  `There is no way to switch this limiter off: /api/v1/profiles/:handle is public and ` +
  `unauthenticated, and the per-IP bucket is the only thing limiting handle enumeration. ` +
  `Raise the number instead, or unset ${PROFILE_RATE_LIMIT_ENV} to get the default of ` +
  `${DEFAULT_PROFILE_RATE_LIMIT.maxAttempts}.`;

/**
 * Turns `API_PROFILE_RATE_LIMIT` into the profile limiter's options.
 *
 * Accepted spellings:
 *
 *   unset / ""      — the shipped default, {@link DEFAULT_PROFILE_RATE_LIMIT}.
 *                     Byte-identical to the behaviour before this variable
 *                     existed, which is the contract this module keeps.
 *   a whole number  — requests per minute, per address. 1 to
 *                     {@link MAX_PROFILE_RATE_LIMIT}. Warns when it is high
 *                     enough to stop being a production setting, or low
 *                     enough to lock out ordinary reading.
 *
 * Everything else throws {@link ProfileRateLimitError} — see the module
 * header for why coercing would be worse than refusing.
 */
export function parseProfileRateLimit(raw: string | undefined): ParseProfileRateLimitResult {
  const value = (raw ?? '').trim();

  // Unset, or set-but-empty (a half-edited .env line). Both mean "I have not
  // chosen", and the answer to that is today's production behaviour.
  if (value === '') {
    return { value: { ...DEFAULT_PROFILE_RATE_LIMIT }, warning: null };
  }

  // Every "turn it off" idiom, named individually so the refusal can say what
  // the operator was reaching for rather than "not a number".
  if (/^(off|none|no|false|unlimited|infinity|inf|disabled?)$/i.test(value)) {
    throw new ProfileRateLimitError(
      `${PROFILE_RATE_LIMIT_ENV}="${value}" is refused. ${CANNOT_BE_DISABLED}`,
    );
  }

  // Refused before the digit check so `-1` — the "unlimited" idiom in several
  // other rate limiters — gets the reason it is wrong here, not a shrug.
  if (/^-\d+$/.test(value)) {
    throw new ProfileRateLimitError(
      `${PROFILE_RATE_LIMIT_ENV}=${value} is refused. A negative limit does not mean ` +
        `"unlimited" here — it locks every address out after its first request, taking the ` +
        `public profile page down. ${CANNOT_BE_DISABLED}`,
    );
  }

  // Plain decimal digits only. `60.0`, `1e3`, `0x3c`, `+60`, `60/min`, `1m`
  // and `sixty` all land here: each would become NaN in the limiter's
  // arithmetic, where every comparison against NaN is false and the endpoint
  // answers `Retry-After: NaN` from the second request onwards.
  if (!/^\d+$/.test(value)) {
    throw new ProfileRateLimitError(
      `${PROFILE_RATE_LIMIT_ENV}="${value}" is not a whole number of requests per minute. ` +
        `It is not a duration, a rate expression like "60/min", or an on/off switch — set it ` +
        `to an integer between 1 and ${MAX_PROFILE_RATE_LIMIT}, or unset it for the default ` +
        `of ${DEFAULT_PROFILE_RATE_LIMIT.maxAttempts}.`,
    );
  }

  const maxAttempts = Number(value);

  // "0", and also "00" / "000", which the spelling check above does not see.
  if (maxAttempts === 0) {
    throw new ProfileRateLimitError(
      `${PROFILE_RATE_LIMIT_ENV}=${value} is refused. Zero does not mean "unlimited" — it ` +
        `locks every address out after its first request, so the public profile page would ` +
        `serve one view per minute per address. ${CANNOT_BE_DISABLED}`,
    );
  }

  if (maxAttempts > MAX_PROFILE_RATE_LIMIT) {
    throw new ProfileRateLimitError(
      `${PROFILE_RATE_LIMIT_ENV}=${value} exceeds the maximum of ${MAX_PROFILE_RATE_LIMIT} ` +
        `requests per minute per address, which is indistinguishable from no limit at all on ` +
        `a public, unauthenticated endpoint. ${CANNOT_BE_DISABLED}`,
    );
  }

  const options: Omit<RateLimitOptions, 'now'> = { ...DEFAULT_PROFILE_RATE_LIMIT, maxAttempts };

  if (maxAttempts > LOUD_PROFILE_RATE_LIMIT) {
    return {
      value: options,
      warning:
        `${PROFILE_RATE_LIMIT_ENV}=${maxAttempts} lets a single address read ${maxAttempts} ` +
        `public profiles a minute — ${Math.round(maxAttempts / DEFAULT_PROFILE_RATE_LIMIT.maxAttempts)}x ` +
        `the default of ${DEFAULT_PROFILE_RATE_LIMIT.maxAttempts}. At that rate a scraper can ` +
        `enumerate handles freely; this is a test-harness or trusted-network setting, not a ` +
        `production one.`,
    };
  }

  if (maxAttempts < CRAMPED_PROFILE_RATE_LIMIT) {
    return {
      value: options,
      warning:
        `${PROFILE_RATE_LIMIT_ENV}=${maxAttempts} is below ${CRAMPED_PROFILE_RATE_LIMIT} ` +
        `requests per minute. One profile page view costs more than one request, and everyone ` +
        `behind a shared address counts as one reader (see ${TRUST_PROXY_ENV}), so ordinary ` +
        `browsing will be refused with 429.`,
    };
  }

  return { value: options, warning: null };
}

/** How the effective setting reads in a boot log line. */
export function describeProfileRateLimit(options: Omit<RateLimitOptions, 'now'>): string {
  const seconds = Math.round(options.windowMs / 1000);
  return `${options.maxAttempts} requests per ${seconds}s per address, then a ${Math.round(options.maxLockoutMs / 1000)}s lockout`;
}
