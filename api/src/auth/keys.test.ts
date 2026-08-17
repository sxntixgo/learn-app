import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadSigningKeys, PRIVATE_KEY_ENV, PUBLIC_KEY_ENV } from './keys.ts';

function pemPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('Ed25519 signing keys (design §4.1, §13)', () => {
  it('loads a PKCS#8 PEM private key from the environment', () => {
    const { privatePem } = pemPair();
    const log = vi.fn();
    const keys = loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem }, log);

    expect(keys.ephemeral).toBe(false);
    expect(keys.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(keys.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(log).not.toHaveBeenCalled();
  });

  it('accepts a base64-wrapped PEM, since env files do not carry newlines well', () => {
    const { privatePem } = pemPair();
    const keys = loadSigningKeys({ [PRIVATE_KEY_ENV]: Buffer.from(privatePem, 'utf8').toString('base64') }, vi.fn());
    expect(keys.ephemeral).toBe(false);
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('derives the public key from the private key, and accepts a matching one', () => {
    const { privatePem, publicPem } = pemPair();
    const derived = loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem }, vi.fn());
    const explicit = loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem, [PUBLIC_KEY_ENV]: publicPem }, vi.fn());
    expect(derived.publicKeyPem).toBe(explicit.publicKeyPem);
  });

  it('refuses a public key that does not match the private key', () => {
    const { privatePem } = pemPair();
    const other = pemPair();
    expect(() =>
      loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem, [PUBLIC_KEY_ENV]: other.publicPem }, vi.fn()),
    ).toThrow(/does not match/i);
  });

  it('refuses a key that is not Ed25519 — EdDSA is the contract with the future Go service', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadSigningKeys({ [PRIVATE_KEY_ENV]: pem }, vi.fn())).toThrow(/ed25519/i);
  });

  it('refuses an unparseable key rather than falling back to a generated one', () => {
    expect(() => loadSigningKeys({ [PRIVATE_KEY_ENV]: 'not a key' }, vi.fn())).toThrow(/could not be parsed/i);
  });

  it('generates an ephemeral keypair when none is configured, and says so loudly', () => {
    const log = vi.fn();
    const keys = loadSigningKeys({}, log);

    expect(keys.ephemeral).toBe(true);
    expect(keys.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(log).toHaveBeenCalled();
    const banner = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(banner).toContain('EPHEMERAL');
    expect(banner).toContain(PRIVATE_KEY_ENV);
    // No secret is ever printed — only the instruction to configure one.
    expect(banner).not.toContain('BEGIN PRIVATE KEY');
  });

  it('generates a DIFFERENT ephemeral keypair each time, so nothing can depend on it', () => {
    const a = loadSigningKeys({}, vi.fn());
    const b = loadSigningKeys({}, vi.fn());
    expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
  });

  it('treats an empty or whitespace env var as absent rather than as a key', () => {
    expect(loadSigningKeys({ [PRIVATE_KEY_ENV]: '   ' }, vi.fn()).ephemeral).toBe(true);
  });
});
