import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

// Plain-SQL migration runner (CLAUDE.md: never an ORM's migration tooling).
// Migrations live at db/migrations/NNNN_name.sql, resolved relative to this
// module rather than process.cwd() so `npm run migrate` works from anywhere.
const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

// Arbitrary fixed key identifying this app's migration lock. Any single
// int8-range constant works; it just needs to be stable and app-specific.
const ADVISORY_LOCK_KEY = 727_284_913;

export interface MigrationResult {
  applied: string[];
}

/**
 * Applies every migration in `migrationsDir` that isn't already recorded in
 * `schema_migrations`, each inside its own transaction. Safe to call
 * concurrently: the whole run is wrapped in a Postgres advisory lock, and
 * re-running after everything is applied is a no-op (not an error).
 */
export async function runMigrations(
  connectionString: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
      try {
        return await applyPendingMigrations(client, migrationsDir);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function applyPendingMigrations(
  client: pg.PoolClient,
  migrationsDir: string,
): Promise<MigrationResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((r) => r.version));

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (alreadyApplied.has(version)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied.push(version);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  return { applied };
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const { applied } = await runMigrations(connectionString);
  if (applied.length === 0) {
    console.log('No migrations to apply.');
  } else {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
