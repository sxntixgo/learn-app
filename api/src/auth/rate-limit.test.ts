import { describe, it, expect } from 'vitest';
import { LoginRateLimiter } from './rate-limit.ts';

function limiterAt(clock: { now: number }): LoginRateLimiter {
  return new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 200_000,
    baseLockoutMs: 10_000,
    maxLockoutMs: 80_000,
    now: () => clock.now,
  });
}

describe('login rate limiting (design §13: per IP and per account, with backoff)', () => {
  it('allows the configured number of failures, then locks out', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);
    const keys = ['ip:203.0.113.9', 'account:someone@example.test'];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(limiter.check(keys).allowed).toBe(true);
      limiter.recordFailure(keys);
    }

    const decision = limiter.check(keys);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(10);
  });

  it('backs off exponentially, capped', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);
    const keys = ['ip:203.0.113.9'];

    for (let i = 0; i < 3; i += 1) limiter.recordFailure(keys);
    expect(limiter.check(keys).retryAfterSeconds).toBe(10);

    // Wait out the lockout, fail again: the next one is twice as long.
    clock.now += 10_000;
    expect(limiter.check(keys).allowed).toBe(true);
    limiter.recordFailure(keys);
    expect(limiter.check(keys).retryAfterSeconds).toBe(20);

    clock.now += 20_000;
    limiter.recordFailure(keys);
    expect(limiter.check(keys).retryAfterSeconds).toBe(40);

    clock.now += 40_000;
    limiter.recordFailure(keys);
    expect(limiter.check(keys).retryAfterSeconds).toBe(80);

    // Capped, so a long-running attack cannot push a legitimate user's
    // lockout out to days.
    clock.now += 80_000;
    limiter.recordFailure(keys);
    expect(limiter.check(keys).retryAfterSeconds).toBe(80);
  });

  it('keeps counting while a lockout is still in force, even past the window', () => {
    // The forgetting window can never be shorter than the longest lockout:
    // if it were, waiting out a lockout would also erase the failures that
    // caused it, and the backoff could never get past its first step.
    const clock = { now: 1_000_000 };
    const limiter = new LoginRateLimiter({
      maxAttempts: 2,
      windowMs: 1_000,
      baseLockoutMs: 10_000,
      maxLockoutMs: 40_000,
      now: () => clock.now,
    });

    limiter.recordFailure(['ip:x']);
    limiter.recordFailure(['ip:x']);
    clock.now += 10_000;
    limiter.recordFailure(['ip:x']);
    expect(limiter.check(['ip:x']).retryAfterSeconds).toBe(20);
  });

  it('forgets failures once the window passes with no further attempts', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);
    const keys = ['ip:203.0.113.9'];

    for (let i = 0; i < 3; i += 1) limiter.recordFailure(keys);
    expect(limiter.check(keys).allowed).toBe(false);

    clock.now += 200_001;
    expect(limiter.check(keys).allowed).toBe(true);
    // And the counter really is back to zero, not merely unlocked.
    limiter.recordFailure(keys);
    expect(limiter.check(keys).allowed).toBe(true);
  });

  it('clears the counter on a successful login', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);
    const keys = ['ip:203.0.113.9', 'account:someone@example.test'];

    limiter.recordFailure(keys);
    limiter.recordFailure(keys);
    limiter.reset(keys);

    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check(keys).allowed).toBe(true);
      limiter.recordFailure(keys);
    }
    expect(limiter.check(keys).allowed).toBe(false);
  });

  it('counts per IP and per account independently', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    // One attacker, one IP, three different accounts: the IP is what stops
    // them, and no single account is locked out by it.
    for (const account of ['a@example.test', 'b@example.test', 'c@example.test']) {
      limiter.recordFailure(['ip:203.0.113.9', `account:${account}`]);
    }

    expect(limiter.check(['ip:203.0.113.9', 'account:d@example.test']).allowed).toBe(false);
    // A different IP reaching for one of those accounts is still fine — that
    // account has only one failure against it.
    expect(limiter.check(['ip:198.51.100.4', 'account:a@example.test']).allowed).toBe(true);
  });

  it('locks an account that is attacked from many IPs (credential stuffing)', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      limiter.recordFailure([`ip:${ip}`, 'account:victim@example.test']);
    }

    expect(limiter.check(['ip:198.51.100.4', 'account:victim@example.test']).allowed).toBe(false);
  });

  it('blocks if ANY key is locked, and reports the longest wait', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 4; i += 1) limiter.recordFailure(['account:victim@example.test']);
    const decision = limiter.check(['ip:198.51.100.4', 'account:victim@example.test']);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(20);
  });

  it('never reports a retry-after of zero while locked', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure(['ip:x']);

    clock.now += 9_999;
    const decision = limiter.check(['ip:x']);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('prunes stale entries so the map cannot grow without bound', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 500; i += 1) limiter.recordFailure([`ip:10.0.0.${i}`]);
    expect(limiter.size).toBe(500);

    clock.now += 200_001;
    limiter.recordFailure(['ip:10.1.0.1']);
    expect(limiter.size).toBe(1);
  });
});
