import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './index.ts';

describe('API security headers', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('sets nosniff, referrer-policy and frame-options on every response', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets them on error responses too, not just successful ones', async () => {
    // A 403 from can() is short-circuited well before any route handler, which
    // is exactly the path where a header set inside a handler would be missed.
    const res = await server.inject({ method: 'GET', url: '/api/v1/me' });

    expect(res.statusCode).toBe(403);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets them on a 404 for a route that does not exist', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/no-such-route' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('forbids caching of authenticated JSON', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/courses' });

    // Every route except /health is either about a specific actor or gated by
    // one. A shared cache holding these is a cross-user leak.
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('leaves /health cacheable — it has no actor and no user data', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.headers['cache-control']).toBeUndefined();
  });
});
