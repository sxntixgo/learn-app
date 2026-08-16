import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

// First-run setup token (design §5.2).
//
// "On first boot the app generates a one-time token and prints it to the
// container logs; the first-account form requires it. Without this, an
// internet-reachable instance is claimable by whoever finds the URL first —
// and that window silently re-opens on every database reset or deploy to a
// fresh volume, which is precisely when it would go unnoticed."
//
// The plaintext exists in exactly two places and nowhere else: the log line
// printed once at boot, and the operator's clipboard. The database stores
// only a SHA-256 digest.
//
// SHA-256 and not Argon2id, deliberately: this is a 256-bit random token, not
// a human-chosen password. There is no dictionary to attack and nothing to
// slow an attacker down — a KDF here would buy nothing and only invite the
// misreading that the two kinds of secret are interchangeable. Password
// hashing (Argon2id, design §13) is a separate concern handled elsewhere in
// Phase 6.

const SETUP_TOKEN_BYTES = 32;

/** A fresh 256-bit setup token, URL-safe so it survives a copy-paste into a form. */
export function generateSetupToken(): string {
  return randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
}

/** The only form of the token that is ever persisted. */
export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface EnsureSetupTokenOptions {
  /** Where the banner goes. Defaults to stdout, i.e. the container logs. */
  log?: (line: string) => void;
}

export interface EnsureSetupTokenResult {
  /** True when the instance has already been claimed and no token was issued. */
  bootstrapped: boolean;
  /** The plaintext token, which the caller must not store. Null once bootstrapped. */
  token: string | null;
}

function banner(token: string): string {
  return [
    '',
    '='.repeat(72),
    '  THIS INSTANCE HAS NOT BEEN CLAIMED YET.',
    '',
    '  Open /setup and paste this one-time token to create the first',
    '  account (an operator account and its linked student account):',
    '',
    `  SETUP TOKEN: ${token}`,
    '',
    '  It is stored only as a hash, it is printed only here, and it stops',
    '  working the moment the first account is created. Restart to get a',
    '  new one — that also invalidates this one.',
    '='.repeat(72),
    '',
  ].join('\n');
}

/**
 * Issues (or re-issues) the first-run setup token and prints it, unless the
 * instance has already been claimed.
 *
 * Called once per boot. While the instance is unclaimed this ROTATES the
 * token on every boot rather than reusing the stored one — it has to: only
 * the hash is kept, so a previously printed token can never be printed again,
 * and an operator who lost the log line would otherwise have no way back in
 * short of editing the database. Rotating keeps exactly one token valid at a
 * time and makes "restart the container" the recovery path.
 */
export async function ensureSetupToken(
  pool: pg.Pool,
  options: EnsureSetupTokenOptions = {},
): Promise<EnsureSetupTokenResult> {
  const log = options.log ?? ((line: string) => console.log(line));

  const existing = await pool.query<{ bootstrapped_at: Date | null }>(
    'select bootstrapped_at from instance_state where id = 1',
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error('instance_state has no row — run migrations before starting the API');
  }
  if (row.bootstrapped_at !== null) {
    return { bootstrapped: true, token: null };
  }

  const token = generateSetupToken();
  // `where bootstrapped_at is null` again, not just as a guard against the
  // read above going stale, but because it is the only thing standing between
  // a boot that races a claim and a setup token being re-armed on an instance
  // somebody already owns.
  const updated = await pool.query(
    `update instance_state
        set setup_token_hash = $1, setup_token_issued_at = now()
      where id = 1 and bootstrapped_at is null`,
    [hashSetupToken(token)],
  );
  if (updated.rowCount === 0) {
    return { bootstrapped: true, token: null };
  }

  log(banner(token));
  return { bootstrapped: false, token };
}
