import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run migrate.test.ts');
}

const pool = new Pool({ connectionString });

// Explicitly resolve the migrations directory
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

async function resetDatabase() {
  // Drop everything the migrations might create so each run starts from empty,
  // letting this test suite run repeatedly against the same test database.
  await pool.query('DROP TABLE IF EXISTS lessons');
  await pool.query('DROP TABLE IF EXISTS schema_migrations');
}

describe('migrate', () => {
  afterAll(async () => {
    await resetDatabase();
    await pool.end();
  });

  it('applies migrations from empty and records the version', async () => {
    await resetDatabase();

    const result = await runMigrations(connectionString!, migrationsDir);

    expect(result.applied).toContain('0001_lessons');

    const table = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'lessons'`,
    );
    expect(table.rowCount).toBe(1);

    const migrations = await pool.query('select version from schema_migrations');
    expect(migrations.rowCount).toBe(1);
    expect(migrations.rows[0].version).toBe('0001_lessons');
  });

  it('is a no-op the second time and schema_migrations has exactly one row', async () => {
    await resetDatabase();

    await runMigrations(connectionString!);
    const second = await runMigrations(connectionString!);

    expect(second.applied).toEqual([]);

    const migrations = await pool.query('select version from schema_migrations');
    expect(migrations.rowCount).toBe(1);
  });
});
