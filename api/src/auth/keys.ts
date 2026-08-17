import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

// The Ed25519 keypair that signs access tokens (design §13, §4.1).
//
// Why EdDSA specifically, and why this file is small on purpose: design §4.1
// lists "stateless EdDSA JWT auth" as one of the four things that keep the
// endpoint-at-a-time Go migration cheap — "a Go service needs only the
// public key. No shared session store, no TypeScript session logic to
// reimplement." That is only true if the public half really is sufficient,
// so the private key never leaves this process and the token carries
// everything a verifier needs.
//
// CLAUDE.md, public repository: "Never default a secret in code (no
// SECRET = 'changeme' fallback)." There is therefore no fallback key here.
// When the environment configures none, a FRESH keypair is generated per
// process and announced as ephemeral — every restart invalidates every
// token it signed, which is a visible, self-correcting nuisance in
// development and an obvious misconfiguration in production. A hardcoded
// default would be silent and permanent.

export const PRIVATE_KEY_ENV = 'AUTH_JWT_PRIVATE_KEY';
export const PUBLIC_KEY_ENV = 'AUTH_JWT_PUBLIC_KEY';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI PEM of the public half — the only thing a future Go verifier needs. */
  publicKeyPem: string;
  /** True when the keypair was generated at boot and dies with the process. */
  ephemeral: boolean;
}

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/**
 * Env vars travel as single lines through compose files and CI secrets, so a
 * PEM is accepted either verbatim (with real newlines) or base64-wrapped.
 */
function decodePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(`${PRIVATE_KEY_ENV}/${PUBLIC_KEY_ENV} could not be parsed: expected a PEM block, or base64 of one.`);
}

function requireEd25519(key: KeyObject, envName: string): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `${envName} must be an Ed25519 key (design §4.1: EdDSA is the contract with a future Go verifier), got ${String(
        key.asymmetricKeyType,
      )}.`,
    );
  }
}

function banner(): string {
  return [
    '',
    '='.repeat(72),
    '  WARNING: EPHEMERAL TOKEN SIGNING KEY.',
    '',
    `  No ${PRIVATE_KEY_ENV} is configured, so a throwaway Ed25519 keypair`,
    '  was generated for THIS PROCESS ONLY. Every access token it signs',
    '  becomes invalid the moment this process restarts, and a second',
    "  instance of the API would reject the first one's tokens outright.",
    '',
    '  This is fine for local development and is NOT fine in production.',
    `  Generate a real key and set ${PRIVATE_KEY_ENV}:`,
    '',
    '    openssl genpkey -algorithm ed25519 -out signing.pem',
    `    ${PRIVATE_KEY_ENV}="$(cat signing.pem)"      # or base64 -w0 signing.pem`,
    '',
    `  The public half (${PUBLIC_KEY_ENV}) is optional — it is derived from`,
    '  the private key — and is all a future Go service needs to verify.',
    '='.repeat(72),
    '',
  ].join('\n');
}

/**
 * Resolves the signing keypair from `env`, generating an ephemeral one when
 * none is configured.
 *
 * Pure with respect to module state: `getSigningKeys()` below is the cached
 * process-wide accessor. Anything that fails here throws — a misconfigured
 * key must stop the API, never quietly downgrade it to an ephemeral one,
 * because "the key you configured was ignored" is exactly the failure that
 * goes unnoticed until every session dies on a deploy.
 */
export function loadSigningKeys(env: Env = process.env, log: Log = (line) => console.warn(line)): SigningKeys {
  const configured = env[PRIVATE_KEY_ENV]?.trim();

  if (!configured) {
    const generated = generateKeyPairSync('ed25519');
    log(banner());
    return {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      publicKeyPem: generated.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ephemeral: true,
    };
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(decodePem(configured));
  } catch (err) {
    if (err instanceof Error && /could not be parsed/.test(err.message)) throw err;
    throw new Error(`${PRIVATE_KEY_ENV} could not be parsed as a private key PEM.`);
  }
  requireEd25519(privateKey, PRIVATE_KEY_ENV);

  const derived = createPublicKey(privateKey);
  const publicKeyPem = derived.export({ type: 'spki', format: 'pem' }).toString();

  const configuredPublic = env[PUBLIC_KEY_ENV]?.trim();
  if (configuredPublic) {
    // Checked rather than trusted: a public key that does not match the
    // private one means a half-finished key rotation, and publishing it to a
    // verifier would silently reject every token the API mints.
    const supplied = createPublicKey(decodePem(configuredPublic));
    requireEd25519(supplied, PUBLIC_KEY_ENV);
    if (supplied.export({ type: 'spki', format: 'pem' }).toString() !== publicKeyPem) {
      throw new Error(`${PUBLIC_KEY_ENV} does not match ${PRIVATE_KEY_ENV}.`);
    }
  }

  return { privateKey, publicKey: derived, publicKeyPem, ephemeral: false };
}

let cached: SigningKeys | undefined;

/** The process-wide signing keypair, resolved on first use (mirrors db.ts's lazy pool). */
export function getSigningKeys(): SigningKeys {
  cached ??= loadSigningKeys();
  return cached;
}

/** Test seam: forces the next getSigningKeys() to re-read the environment. */
export function resetSigningKeys(keys?: SigningKeys): void {
  cached = keys;
}
