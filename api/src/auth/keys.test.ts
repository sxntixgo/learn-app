import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { getSigningKeys, loadSigningKeys, resetSigningKeys, PRIVATE_KEY_ENV, PUBLIC_KEY_ENV } from './keys.ts';

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

  it('refuses a public key that is a valid PEM but not Ed25519, naming the public env var', () => {
    // The private half being Ed25519 is not enough. A rotation that published
    // an RSA public key would leave the API minting EdDSA tokens that the
    // future Go verifier (design §4.1) could not check at all — and the error
    // has to name AUTH_JWT_PUBLIC_KEY, because the operator's first guess
    // will be that the private key is the broken one.
    const { privatePem } = pemPair();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPublicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    expect(() => loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem, [PUBLIC_KEY_ENV]: rsaPublicPem }, vi.fn())).toThrow(
      new RegExp(`${PUBLIC_KEY_ENV}.*ed25519`, 'is'),
    );
  });
});

describe('getSigningKeys (the process-wide cache)', () => {
  const savedPrivate = process.env[PRIVATE_KEY_ENV];
  const savedPublic = process.env[PUBLIC_KEY_ENV];

  afterEach(() => {
    if (savedPrivate === undefined) delete process.env[PRIVATE_KEY_ENV];
    else process.env[PRIVATE_KEY_ENV] = savedPrivate;
    if (savedPublic === undefined) delete process.env[PUBLIC_KEY_ENV];
    else process.env[PUBLIC_KEY_ENV] = savedPublic;
    resetSigningKeys();
    vi.restoreAllMocks();
  });

  it('resolves the keypair ONCE per process, not once per token', () => {
    // This is the difference between "every restart invalidates every token"
    // — the documented, deliberate cost of an ephemeral key — and "every
    // request invalidates every token", which would make an unconfigured
    // instance not merely inconvenient but unusable: the token minted by the
    // login response would already be unverifiable by the next request.
    // loadSigningKeys() is proven to generate a fresh pair on every call
    // above, so the caching is the only thing standing between the two.
    delete process.env[PRIVATE_KEY_ENV];
    delete process.env[PUBLIC_KEY_ENV];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetSigningKeys();

    const first = getSigningKeys();
    expect(first.ephemeral).toBe(true);
    expect(getSigningKeys()).toBe(first);
    expect(getSigningKeys().publicKeyPem).toBe(first.publicKeyPem);
    // And the "this is not fine in production" banner is printed once at
    // resolution, not on every request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resetSigningKeys replaces the cache, and clears it when given nothing', () => {
    // The seam exists so a test can install a known keypair; the empty call
    // is what makes the next resolution re-read the environment, which is
    // what any test that changes AUTH_JWT_PRIVATE_KEY depends on.
    const { privatePem } = pemPair();
    const installed = loadSigningKeys({ [PRIVATE_KEY_ENV]: privatePem }, vi.fn());
    resetSigningKeys(installed);
    expect(getSigningKeys()).toBe(installed);

    const other = pemPair();
    process.env[PRIVATE_KEY_ENV] = other.privatePem;
    delete process.env[PUBLIC_KEY_ENV];
    expect(getSigningKeys()).toBe(installed);

    resetSigningKeys();
    const reread = getSigningKeys();
    expect(reread).not.toBe(installed);
    expect(reread.publicKeyPem).toBe(other.publicPem);
  });
});
