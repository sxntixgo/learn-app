import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { redactUrl, redactingRequestSerializer, REDACTED } from './log-redaction.ts';
import { LOGGER_OPTIONS } from './index.ts';

describe('redactUrl', () => {
  it('leaves a URL with no query string alone', () => {
    expect(redactUrl('/api/v1/courses')).toBe('/api/v1/courses');
  });

  it('redacts the value of a sensitive parameter but keeps its name', () => {
    // The name stays so a log still shows WHICH parameter was sent — that is
    // the part worth debugging; the value is the part worth hiding.
    expect(redactUrl('/api/v1/invites/lookup?token=abc123')).toBe(`/api/v1/invites/lookup?token=${REDACTED}`);
  });

  it('leaves harmless parameters readable', () => {
    expect(redactUrl('/api/v1/me/activity?weeks=53')).toBe('/api/v1/me/activity?weeks=53');
  });

  it('redacts only the sensitive parameter in a mixed query', () => {
    expect(redactUrl('/x?limit=10&token=secret&page=2')).toBe(`/x?limit=10&token=${REDACTED}&page=2`);
  });

  it('matches parameter names case-insensitively', () => {
    expect(redactUrl('/x?Token=secret')).toBe(`/x?Token=${REDACTED}`);
    expect(redactUrl('/x?ACCESS_TOKEN=secret')).toBe(`/x?ACCESS_TOKEN=${REDACTED}`);
  });

  it('redacts a percent-encoded parameter name', () => {
    // `%74oken` is `token`. Decoding before matching means an odd encoding is
    // not a way past the list.
    expect(redactUrl('/x?%74oken=secret')).toBe(`/x?%74oken=${REDACTED}`);
  });

  it('survives malformed percent-encoding rather than throwing', () => {
    // decodeURIComponent throws on a lone `%`. A logger must never be the
    // thing that fails a request.
    expect(() => redactUrl('/x?%ZZ=1&token=secret')).not.toThrow();
    expect(redactUrl('/x?%ZZ=1&token=secret')).toContain(`token=${REDACTED}`);
  });

  it('leaves a valueless flag alone', () => {
    expect(redactUrl('/x?debug')).toBe('/x?debug');
  });

  it('keeps an empty query string as it was', () => {
    expect(redactUrl('/x?')).toBe('/x?');
  });

  it('does not redact a parameter that merely CONTAINS a sensitive name', () => {
    // `tokenCount` is not a token. Whole-name matching keeps the redaction
    // from eating unrelated telemetry.
    expect(redactUrl('/x?tokenCount=3')).toBe('/x?tokenCount=3');
  });
});

describe('redactingRequestSerializer', () => {
  it('emits the same fields as the default serializer, with the url redacted', () => {
    const serialized = redactingRequestSerializer({
      method: 'GET',
      url: '/api/v1/invites/lookup?token=abc',
      host: 'learn.lan',
      ip: '10.0.0.5',
      socket: { remotePort: 54321 },
    } as unknown as Parameters<typeof redactingRequestSerializer>[0]);

    expect(serialized).toEqual({
      method: 'GET',
      url: `/api/v1/invites/lookup?token=${REDACTED}`,
      host: 'learn.lan',
      remoteAddress: '10.0.0.5',
      remotePort: 54321,
    });
  });
});

/**
 * THE ACTUAL INCIDENT, as a test.
 *
 * The finding was not "this function could leak" — it was that a real Fastify
 * configured the way api/src/index.ts configures it wrote a live invite token
 * to stdout. So this asserts on log OUTPUT from a real server, not on the
 * helper in isolation, and it fails if someone reverts the serializer.
 */
describe('a token in a request URL never reaches the log', () => {
  async function capture(url: string, serializers?: object): Promise<string> {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) }, ...serializers },
    });
    app.get('/api/v1/invites/lookup', async (_req, reply) => reply.code(410).send({ message: 'gone' }));
    await app.inject({ method: 'GET', url });
    await app.close();
    return lines.join('\n');
  }

  const SECRET = 'S3CRET_INVITE_TOKEN_do_not_log_me';

  it('would have leaked under the default serializer — the bug this replaced', async () => {
    // Pinned so the test above is known to be testing something real. If a
    // future Fastify stops logging the URL, this fails and the redaction can
    // be reconsidered rather than cargo-culted.
    const logged = await capture(`/api/v1/invites/lookup?token=${SECRET}`);
    expect(logged).toContain(SECRET);
  });

  it('does not leak with the redacting serializer wired in', async () => {
    const logged = await capture(`/api/v1/invites/lookup?token=${SECRET}`, {
      serializers: { req: redactingRequestSerializer },
    });

    expect(logged).not.toContain(SECRET);
    expect(logged).toContain(REDACTED);
  });

  it('does not log request headers, which is what makes the header safe', async () => {
    // The route now takes the token in X-Invite-Token. That is only an
    // improvement if headers stay out of the log — so assert it rather than
    // assume it.
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: { write: (line: string) => void lines.push(line) },
        serializers: { req: redactingRequestSerializer },
      },
    });
    app.get('/api/v1/invites/lookup', async (_req, reply) => reply.code(410).send({ message: 'gone' }));
    await app.inject({
      method: 'GET',
      url: '/api/v1/invites/lookup',
      headers: { 'x-invite-token': SECRET },
    });
    await app.close();

    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

/**
 * ...AND THAT THE REAL SERVER IS ACTUALLY WIRED TO IT.
 *
 * Everything above tests the serializer in isolation, which is worth nothing
 * if `buildServer` does not use it — and a mutation run proved exactly that:
 * reverting api/src/index.ts to `logger: true` left every test above green.
 *
 * Capturing the real output does not work: pino writes through sonic-boom
 * directly to fd 1, so hooking `process.stdout.write` never sees it (tried,
 * and the mutation still survived). Asserting on the wiring is what actually
 * catches the revert.
 */
describe('buildServer wires the redacting serializer in', () => {
  it('uses the redacting req serializer, not pino default', () => {
    expect(LOGGER_OPTIONS.serializers.req).toBe(redactingRequestSerializer);
  });

  it('and buildServer actually passes those options to Fastify', () => {
    // The linkage, checked in the source. Asserting on the exported object
    // alone left `logger: true` a surviving mutation — the constant was
    // correct and simply unused. Reading the file is the same technique
    // tools/src/docker-web.test.ts uses for wiring it cannot execute here.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/logger:\s*LOGGER_OPTIONS/);
    expect(source, 'index.ts fell back to pino default request logging').not.toMatch(/logger:\s*true/);
  });
});
