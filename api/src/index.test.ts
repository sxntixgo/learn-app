import { describe, it, expect } from 'vitest';
import { buildServer } from './index.ts';

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
});
