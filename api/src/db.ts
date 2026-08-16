import pg from 'pg';

const { Pool } = pg;

// Single shared pg Pool for the API process. Built lazily (on first
// getPool() call, i.e. the first request) rather than at import time, so
// that whatever loads DATABASE_URL from .env — vitest.setup.ts in tests,
// index.ts's main() when run standalone — has a chance to run first. Tests
// point this at TEST_DATABASE_URL by calling setPool() with a pool built
// from that connection string (mirrors how tools/src/migrate.ts opens its
// own Pool per connectionString rather than reading env vars deep in code).
let pool: pg.Pool | undefined;

/** Returns the shared pool used by request handlers, creating it on first use. */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

/** Replaces the shared pool — used by tests to target TEST_DATABASE_URL. */
export function setPool(newPool: pg.Pool): void {
  pool = newPool;
}

/** Closes the current pool so nothing keeps the process (or vitest) alive. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
