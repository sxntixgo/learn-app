import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { parseConnectionString, redactConnectionString } from './pg-conn.ts';

const { Pool } = pg;
const run = promisify(execFile);

export interface RestoreOptions {
  force?: boolean;
}

/**
 * A database counts as "empty" when the public schema has no tables yet.
 * pg_restore recreates every table from the dump, so running it against a
 * schema that already has tables — even ones with zero rows — fails with
 * "already exists" for each one unless the caller has opted into
 * overwriting them (see `force` below).
 */
export async function isDatabaseEmpty(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
    );
    return rows[0]!.n === '0';
  } finally {
    await pool.end();
  }
}

export class NotEmptyError extends Error {
  constructor(target: string) {
    super(
      `Target database is not empty (${redactConnectionString(target)}). ` +
        `Restoring here would overwrite existing data. Pass --force to proceed anyway.`,
    );
    this.name = 'NotEmptyError';
  }
}

/**
 * Restores `dumpFile` (a pg_dump -Fc custom-format dump) into
 * `targetConnectionString` via pg_restore.
 *
 * Refuses to run against a non-empty database unless `force` is set —
 * restoring onto live data is destructive and irreversible, and that
 * refusal is the whole point of this module (see restore.test.ts).
 */
export async function runRestore(
  dumpFile: string,
  targetConnectionString: string,
  opts: RestoreOptions = {},
): Promise<void> {
  if (!existsSync(dumpFile)) {
    throw new Error(`Dump file not found: ${dumpFile}`);
  }

  if (!opts.force) {
    const empty = await isDatabaseEmpty(targetConnectionString);
    if (!empty) {
      throw new NotEmptyError(targetConnectionString);
    }
  }

  const { host, port, user, password, database } = parseConnectionString(targetConnectionString);

  // --clean --if-exists: a no-op against the empty database the guard above
  // just confirmed, and exactly what a --force restore over existing
  // objects needs in order to succeed instead of failing on "already
  // exists". --no-owner: the role restoring is not guaranteed to be the
  // role that ran pg_dump (e.g. restoring a backup onto a different host).
  // Password travels only via PGPASSWORD, never argv.
  await run(
    'pg_restore',
    [
      '-h',
      host,
      '-p',
      port,
      '-U',
      user,
      '-d',
      database,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--exit-on-error',
      dumpFile,
    ],
    { env: { ...process.env, PGPASSWORD: password } },
  );
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const args = process.argv.slice(2);
  const dumpFile = args[0];
  let into: string | undefined;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--into' && args[i + 1] !== undefined) {
      into = args[++i];
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  if (!dumpFile || dumpFile.startsWith('--') || !into) {
    console.error('Usage: npm run restore -- <dump-file> --into <database-url> [--force]');
    process.exitCode = 1;
    return;
  }

  try {
    await runRestore(dumpFile, into, { force });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(`Restored ${dumpFile} into ${redactConnectionString(into)}`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
