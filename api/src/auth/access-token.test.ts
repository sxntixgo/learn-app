import { describe, it, expect } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { loadSigningKeys } from './keys.ts';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, verifyAccessToken } from './access-token.ts';

const keys = loadSigningKeys({}, () => {});
const otherKeys = loadSigningKeys({}, () => {});

const USER_ID = '11111111-2222-3333-4444-555555555555';

function base64url(value: object | string): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

describe('EdDSA access tokens (design §13)', () => {
  it('round-trips the subject and roles, signed with EdDSA', async () => {
    const token = await signAccessToken({ userId: USER_ID, roles: ['teacher', 'student'] }, keys);

    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as {
      alg: string;
    };
    expect(header.alg).toBe('EdDSA');

    const claims = await verifyAccessToken(token, keys);
    expect(claims).toEqual({ userId: USER_ID, roles: ['teacher', 'student'] });
  });

  it('defaults to a ~15 minute lifetime', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken({ userId: USER_ID, roles: ['student'] }, keys, -1);
    expect(await verifyAccessToken(token, keys)).toBeNull();
  });

  it('rejects a token signed by a different keypair', async () => {
    const token = await signAccessToken({ userId: USER_ID, roles: ['admin'] }, otherKeys);
    expect(await verifyAccessToken(token, keys)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken({ userId: USER_ID, roles: ['student'] }, keys);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    decoded.roles = ['admin'];
    const forged = `${header}.${base64url(decoded)}.${signature}`;

    expect(await verifyAccessToken(forged, keys)).toBeNull();
  });

  it('rejects alg:none — an unsigned token is not a token', async () => {
    const unsigned = `${base64url({ alg: 'none' })}.${base64url({
      sub: USER_ID,
      roles: ['admin'],
      iss: 'learn-app',
      aud: 'learn-app',
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    expect(await verifyAccessToken(unsigned, keys)).toBeNull();
  });

  it('rejects an HMAC token that uses the public key as its secret (algorithm confusion)', async () => {
    const header = base64url({ alg: 'HS256' });
    const payload = base64url({
      sub: USER_ID,
      roles: ['admin'],
      iss: 'learn-app',
      aud: 'learn-app',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const signature = createHmac('sha256', keys.publicKeyPem).update(`${header}.${payload}`).digest('base64url');

    expect(await verifyAccessToken(`${header}.${payload}.${signature}`, keys)).toBeNull();
  });

  it('rejects a token minted for a different audience or issuer', async () => {
    const foreign = await signAccessToken({ userId: USER_ID, roles: ['student'] }, keys, 600, {
      issuer: 'somewhere-else',
    });
    expect(await verifyAccessToken(foreign, keys)).toBeNull();
  });

  it('rejects garbage, empty strings, and non-Ed25519 keys', async () => {
    expect(await verifyAccessToken('', keys)).toBeNull();
    expect(await verifyAccessToken('not.a.token', keys)).toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await verifyAccessToken(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), keys)).toBeNull();
  });

  it('drops role values that are not real roles, rather than trusting the token', async () => {
    // Defence in depth: the signature proves this API minted the token, but
    // `can()` must never be handed a role string this codebase does not know.
    const token = await signAccessToken(
      { userId: USER_ID, roles: ['student', 'superuser' as never, ''] as never },
      keys,
    );
    expect(await verifyAccessToken(token, keys)).toEqual({ userId: USER_ID, roles: ['student'] });
  });

  it('rejects a token whose subject is not a uuid', async () => {
    const token = await signAccessToken({ userId: 'not-a-uuid', roles: ['student'] }, keys);
    expect(await verifyAccessToken(token, keys)).toBeNull();
  });
});
