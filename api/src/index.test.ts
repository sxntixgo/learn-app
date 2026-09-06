import { describe, it, expect, afterEach } from 'vitest';
import { buildServer } from './index.ts';
import { PROFILE_RATE_LIMIT_ENV, ProfileRateLimitError } from './auth/profile-rate-limit.ts';
import { LoginRateLimiter } from './auth/rate-limit.ts';
import { DEFAULT_PROFILE_RATE_LIMIT } from './routes/profiles.ts';

describe('API Server', () => {
  it('should start the server', async () => {
    const fastify = await buildServer();
    expect(fastify).toBeDefined();
    await fastify.close();
  });

  it('should respond to /api/v1/health with status ok', async () => {
    const fastify = await buildServer();
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe('ok');
    await fastify.close();
  });

  // ===========================================================================
  // The §11 public-profile limiter, wired from the environment.
  //
  // auth/profile-rate-limit.test.ts covers the parsing; these cover that the
  // parsed value actually REACHES the route — the gap that made the setting a
  // test-only DI seam before. A malformed handle is used throughout: the
  // limiter counts before the handle is validated (so scanning costs the same
  // as reading), which means these assertions never touch the database.
  // ===========================================================================
  describe(`${PROFILE_RATE_LIMIT_ENV} reaches GET /api/v1/profiles/:handle`, () => {
    const before = process.env[PROFILE_RATE_LIMIT_ENV];
    const MALFORMED = '/api/v1/profiles/not!a!handle';

    afterEach(() => {
      if (before === undefined) delete process.env[PROFILE_RATE_LIMIT_ENV];
      else process.env[PROFILE_RATE_LIMIT_ENV] = before;
    });

    it('serves 60 reads and refuses the 61st when the variable is unset', async () => {
      // The production-is-unchanged proof, taken at the route rather than at
      // the parser: nothing about an unconfigured deployment moved.
      delete process.env[PROFILE_RATE_LIMIT_ENV];
      const fastify = await buildServer();
      try {
        for (let i = 0; i < DEFAULT_PROFILE_RATE_LIMIT.maxAttempts; i++) {
          expect((await fastify.inject({ method: 'GET', url: MALFORMED })).statusCode).toBe(404);
        }
        const limited = await fastify.inject({ method: 'GET', url: MALFORMED });
        expect(limited.statusCode).toBe(429);
        // The minute-long lockout, not a token one-second Retry-After.
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(55);
        expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
      } finally {
        await fastify.close();
      }
    });

    it('honours a configured limit', async () => {
      process.env[PROFILE_RATE_LIMIT_ENV] = '1';
      const fastify = await buildServer();
      try {
        expect((await fastify.inject({ method: 'GET', url: MALFORMED })).statusCode).toBe(404);
        expect((await fastify.inject({ method: 'GET', url: MALFORMED })).statusCode).toBe(429);
      } finally {
        await fastify.close();
      }
    });

    it('refuses to boot on a value that would remove the protection', async () => {
      // Loudly, at boot, before Fastify exists — not quietly at 3am in an
      // access log. `main()` turns this into a non-zero exit.
      process.env[PROFILE_RATE_LIMIT_ENV] = 'off';
      await expect(buildServer()).rejects.toThrow(ProfileRateLimitError);
      await expect(buildServer()).rejects.toThrow(PROFILE_RATE_LIMIT_ENV);
    });

    it('refuses to boot on a typo', async () => {
      process.env[PROFILE_RATE_LIMIT_ENV] = '60/min';
      await expect(buildServer()).rejects.toThrow(ProfileRateLimitError);
    });

    it('lets an injected limiter win, so the route tests keep their seam', async () => {
      process.env[PROFILE_RATE_LIMIT_ENV] = '1';
      const fastify = await buildServer({
        profileRateLimiter: new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 }),
      });
      try {
        for (let i = 0; i < 3; i++) {
          expect((await fastify.inject({ method: 'GET', url: MALFORMED })).statusCode).toBe(404);
        }
        expect((await fastify.inject({ method: 'GET', url: MALFORMED })).statusCode).toBe(429);
      } finally {
        await fastify.close();
      }
    });
  });
});
