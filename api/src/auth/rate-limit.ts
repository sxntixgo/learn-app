// Login rate limiting (design §13: "Login rate-limited per IP and per
// account, with backoff").
//
// Two keys per attempt, because the two attacks are different shapes:
//
//   per IP       one host trying many accounts (spraying). The account
//                counters barely move; the IP counter is what stops it.
//   per account  many hosts trying one account (credential stuffing). No
//                single IP counter moves; the account counter is what stops
//                it.
//
// An attempt is refused if EITHER key is locked, so neither shape has a way
// around it by varying the other half.
//
// Backoff doubles per failure past the threshold and is capped, so a
// determined attacker's own failures do the work of slowing them down —
// while a legitimate user who mistypes their password four times is not
// locked out for a day. The cap is the part that keeps the mechanism from
// becoming a denial-of-service tool pointed at a real account.
//
// SCOPE, stated plainly: this is per-process, in memory. That is the right
// size for the design's single-container deployment (design §4: Postgres is
// the only stateful service) and it is NOT a distributed rate limiter. If
// the API is ever run as more than one replica, this belongs in Postgres or
// a shared store, and the count would otherwise be per-replica.

export interface RateLimitOptions {
  /** Failures allowed before the key is locked. */
  maxAttempts: number;
  /** Failures older than this are forgotten entirely. */
  windowMs: number;
  /** Lockout applied at the threshold; doubles with each further failure. */
  baseLockoutMs: number;
  /** Ceiling on the lockout, so a locked-out account always recovers. */
  maxLockoutMs: number;
  /** Injectable clock, so the backoff can be tested without sleeping. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may try again. Always ≥ 1 while locked. */
  retryAfterSeconds: number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
}

/** Defaults for the login route: five tries, then a minute that keeps doubling. */
export const DEFAULT_LOGIN_RATE_LIMIT: Omit<RateLimitOptions, 'now'> = {
  maxAttempts: 5,
  windowMs: 15 * 60_000,
  baseLockoutMs: 60_000,
  maxLockoutMs: 30 * 60_000,
};

export class LoginRateLimiter {
  readonly #options: Required<Omit<RateLimitOptions, 'now'>>;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  /**
   * How long a key's failures are remembered, measured from its last
   * failure. Never shorter than the longest lockout: if it were, waiting out
   * a lockout would also erase the failures that caused it, the backoff
   * could never reach its second step, and the limiter would degrade into a
   * fixed delay an attacker can simply sleep through.
   */
  readonly #forgetAfterMs: number;
  #lastSweepAt: number;

  constructor(options: Partial<RateLimitOptions> = {}) {
    this.#options = { ...DEFAULT_LOGIN_RATE_LIMIT, ...options };
    this.#now = options.now ?? (() => Date.now());
    this.#forgetAfterMs = Math.max(this.#options.windowMs, this.#options.maxLockoutMs);
    this.#lastSweepAt = this.#now();
  }

  /** Live entry count. Exposed so the pruning behaviour is testable. */
  get size(): number {
    return this.#entries.size;
  }

  /** How long `key` is locked for, in ms; 0 when it is not locked. */
  #lockoutRemaining(key: string, at: number): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    if (at - entry.lastFailureAt > this.#forgetAfterMs) return 0;
    if (entry.failures < this.#options.maxAttempts) return 0;

    const steps = entry.failures - this.#options.maxAttempts;
    const lockout = Math.min(this.#options.baseLockoutMs * 2 ** steps, this.#options.maxLockoutMs);
    return Math.max(0, entry.lastFailureAt + lockout - at);
  }

  /** May an attempt carrying these keys proceed? */
  check(keys: readonly string[]): RateLimitDecision {
    const at = this.#now();
    let worst = 0;
    for (const key of keys) {
      worst = Math.max(worst, this.#lockoutRemaining(key, at));
    }
    if (worst === 0) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(worst / 1000)) };
  }

  /** Records a failed attempt against every key. */
  recordFailure(keys: readonly string[]): void {
    const at = this.#now();
    this.#sweep(at);

    for (const key of keys) {
      const entry = this.#entries.get(key);
      // A failure after the window has fully elapsed starts a fresh count
      // rather than resuming an old one — otherwise a user who mistyped
      // their password twice last month starts today one strike from a
      // lockout.
      if (!entry || at - entry.lastFailureAt > this.#forgetAfterMs) {
        this.#entries.set(key, { failures: 1, lastFailureAt: at });
      } else {
        entry.failures += 1;
        entry.lastFailureAt = at;
      }
    }
  }

  /** Clears the counters for these keys — call on a successful login. */
  reset(keys: readonly string[]): void {
    for (const key of keys) this.#entries.delete(key);
  }

  /**
   * Drops entries that can no longer affect a decision. Run on failures
   * only (the write path), at most once per window, so the common case
   * costs nothing.
   */
  #sweep(at: number): void {
    if (at - this.#lastSweepAt < this.#options.windowMs) return;
    this.#lastSweepAt = at;

    for (const [key, entry] of this.#entries) {
      if (at - entry.lastFailureAt > this.#forgetAfterMs) this.#entries.delete(key);
    }
  }
}
