import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { ensureSetupToken, generateSetupToken, hashSetupToken } from './setup-token.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run setup-token.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors me.test.ts / progress.test.ts's own copy — each DB-touching test
// file owns its migration bootstrap.
async function applyMigrations(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [version]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

/** instance_state is a singleton, so every test in this file resets it. */
async function resetInstanceState(): Promise<void> {
  await pool.query(
    'update instance_state set bootstrapped_at = null, setup_token_hash = null, setup_token_issued_at = null where id = 1',
  );
}

interface InstanceStateRow {
  bootstrapped_at: Date | null;
  setup_token_hash: string | null;
  setup_token_issued_at: Date | null;
}

async function readInstanceState(): Promise<InstanceStateRow> {
  const { rows } = await pool.query<InstanceStateRow>(
    'select bootstrapped_at, setup_token_hash, setup_token_issued_at from instance_state where id = 1',
  );
  return rows[0]!;
}

describe('setup token', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(resetInstanceState);

  afterAll(async () => {
    await resetInstanceState();
    await pool.end();
  });

  describe('hashSetupToken', () => {
    it('is a stable sha256 hex digest of the token', () => {
      const token = 'a-token';
      expect(hashSetupToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
      expect(hashSetupToken(token)).toHaveLength(64);
      expect(hashSetupToken(token)).toBe(hashSetupToken(token));
    });

    it('differs for different tokens', () => {
      expect(hashSetupToken('a')).not.toBe(hashSetupToken('b'));
    });
  });

  describe('generateSetupToken', () => {
    it('is long, URL-safe and unpredictable', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateSetupToken()));
      expect(tokens.size).toBe(50);
      for (const token of tokens) {
        expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/); // >= 32 bytes of entropy, base64url
      }
    });
  });

  describe('ensureSetupToken', () => {
    it('issues a token on an unbootstrapped instance and stores only its hash', async () => {
      const logged: string[] = [];
      const result = await ensureSetupToken(pool, { log: (line) => logged.push(line) });

      expect(result.bootstrapped).toBe(false);
      expect(result.token).not.toBeNull();

      const state = await readInstanceState();
      expect(state.setup_token_hash).toBe(hashSetupToken(result.token!));
      expect(state.setup_token_issued_at).toBeInstanceOf(Date);
      expect(state.bootstrapped_at).toBeNull();
    });

    it('never writes the plaintext token to the database', async () => {
      const result = await ensureSetupToken(pool, { log: () => {} });
      const { rows } = await pool.query('select * from instance_state where id = 1');
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(result.token!);
    });

    it('prints the plaintext token to the logs, exactly once', async () => {
      const logged: string[] = [];
      const result = await ensureSetupToken(pool, { log: (line) => logged.push(line) });

      const occurrences = logged.filter((line) => line.includes(result.token!));
      expect(occurrences).toHaveLength(1);
      expect(logged.join('\n')).toMatch(/SETUP TOKEN/);
    });

    it('rotates the token on every boot while the instance is unclaimed', async () => {
      // The plaintext is unrecoverable once printed, so a restart has to
      // reprint something usable — which means issuing a new token and
      // invalidating the old one.
      const first = await ensureSetupToken(pool, { log: () => {} });
      const firstHash = (await readInstanceState()).setup_token_hash;

      const second = await ensureSetupToken(pool, { log: () => {} });
      const secondHash = (await readInstanceState()).setup_token_hash;

      expect(second.token).not.toBe(first.token);
      expect(secondHash).not.toBe(firstHash);
      expect(secondHash).toBe(hashSetupToken(second.token!));
    });

    it('issues nothing, and logs no token, once the instance is bootstrapped', async () => {
      await pool.query('update instance_state set bootstrapped_at = now(), setup_token_hash = null where id = 1');

      const logged: string[] = [];
      const result = await ensureSetupToken(pool, { log: (line) => logged.push(line) });

      expect(result).toEqual({ bootstrapped: true, token: null });
      expect(logged.join('\n')).not.toMatch(/SETUP TOKEN/);
      expect((await readInstanceState()).setup_token_hash).toBeNull();
    });
  });
});
