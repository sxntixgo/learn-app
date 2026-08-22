import { createServer, type Server } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { checkHealth, healthUrl } from './healthcheck.ts';

/**
 * The probe that eighteen failed container health checks were unable to tell
 * us anything with. It is a file now precisely so it can be tested; these are
 * the cases a health probe has to get right.
 */
let server: Server | undefined;

async function serving(status: number): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}/api/v1/health`;
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

describe('checkHealth', () => {
  it('is true for 200', async () => {
    expect(await checkHealth(await serving(200))).toBe(true);
  });

  it('is false for any other status', async () => {
    // 503 is what the API would answer if it were up but unwell. A probe that
    // only checked "did I get a response" would call that healthy.
    for (const status of [204, 301, 404, 500, 503]) {
      expect(await checkHealth(await serving(status)), String(status)).toBe(false);
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('is false — not a crash — when nothing is listening', async () => {
    // The case the container hits during start-up, and the one the old
    // inline probe handled by throwing an uncaught exception.
    expect(await checkHealth('http://127.0.0.1:1/api/v1/health')).toBe(false);
  });

  it('is false when the server never answers, rather than hanging forever', async () => {
    server = createServer(() => {
      /* accept the connection and say nothing */
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');

    expect(await checkHealth(`http://127.0.0.1:${address.port}/api/v1/health`, 250)).toBe(false);
  });
});

describe('healthUrl', () => {
  it('follows API_PORT, so the probe cannot drift from the port the server binds', () => {
    expect(healthUrl({ API_PORT: '4567' })).toBe('http://127.0.0.1:4567/api/v1/health');
  });

  it('defaults to 3001 when API_PORT is unset or junk', () => {
    expect(healthUrl({})).toBe('http://127.0.0.1:3001/api/v1/health');
    expect(healthUrl({ API_PORT: 'not-a-number' })).toBe('http://127.0.0.1:3001/api/v1/health');
  });

  it('targets 127.0.0.1, never localhost', () => {
    // `localhost` can resolve to ::1 while the server listens on IPv4 only —
    // which is exactly what this API does inside a container.
    expect(healthUrl({})).not.toContain('localhost');
  });
});
