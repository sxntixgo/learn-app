import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseConnectionString } from './pg-conn.ts';

const run = promisify(execFile);

// Repo-root/backups, resolved relative to this module (not process.cwd())
// so `npm run backup` behaves the same from anywhere — same reasoning as
// migrate.ts's DEFAULT_MIGRATIONS_DIR.
const DEFAULT_BACKUP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backups');
const DEFAULT_KEEP = 7;

// The only filenames retention pruning is ever allowed to touch. A backup
// tool that prunes "whatever's oldest in the directory" is one misconfigured
// --out away from deleting something that isn't a backup at all.
const BACKUP_FILENAME_RE = /^learn-app-\d{8}-\d{6}\.dump$/;

export interface BackupResult {
  file: string;
  bytes: number;
  deletedFiles: string[];
}

export interface BackupOptions {
  outDir?: string;
  keep?: number;
  /** Overrides the clock the timestamp is derived from — for tests only. */
  now?: Date;
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Runs `pg_dump -Fc` (custom format: compressed, and selectively restorable
 * — never plain SQL) against `connectionString`, writing a timestamped file
 * into `outDir`, then prunes down to the newest `keep` backups.
 */
export async function runBackup(connectionString: string, opts: BackupOptions = {}): Promise<BackupResult> {
  const outDir = opts.outDir ?? DEFAULT_BACKUP_DIR;
  const keep = opts.keep ?? DEFAULT_KEEP;
  const now = opts.now ?? new Date();

  await mkdir(outDir, { recursive: true });

  const file = path.join(outDir, `learn-app-${timestamp(now)}.dump`);
  const { host, port, user, password, database } = parseConnectionString(connectionString);

  // Host/port/user/dbname as separate flags, password only via PGPASSWORD —
  // never in argv, and never in a log line (nothing below logs the command).
  await run('pg_dump', ['-h', host, '-p', port, '-U', user, '-Fc', '-f', file, database], {
    env: { ...process.env, PGPASSWORD: password },
  });

  const { size } = await stat(file);
  const deletedFiles = await pruneOldBackups(outDir, keep);

  return { file, bytes: size, deletedFiles };
}

async function pruneOldBackups(dir: string, keep: number): Promise<string[]> {
  const entries = await readdir(dir);
  // Lexical sort is chronological order here: the fixed-width, zero-padded
  // YYYYMMDD-HHMMSS timestamp sorts identically as a string and as a date.
  const backups = entries.filter((f) => BACKUP_FILENAME_RE.test(f)).sort();
  const excess = backups.length - keep;
  if (excess <= 0) return [];

  const toDelete = backups.slice(0, excess);
  for (const f of toDelete) {
    await unlink(path.join(dir, f));
  }
  return toDelete;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
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

  const args = process.argv.slice(2);
  let outDir: string | undefined;
  let keep: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1] !== undefined) {
      outDir = args[++i];
    } else if (args[i] === '--keep' && args[i + 1] !== undefined) {
      const parsed = Number(args[++i]);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(`--keep must be a positive integer, got: ${args[i]}`);
        process.exitCode = 1;
        return;
      }
      keep = parsed;
    }
  }

  let result: BackupResult;
  try {
    result = await runBackup(connectionString, { outDir, keep });
  } catch (err) {
    console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${result.file} (${formatBytes(result.bytes)})`);
  if (result.deletedFiles.length > 0) {
    console.log(`Pruned ${result.deletedFiles.length} old backup(s): ${result.deletedFiles.join(', ')}`);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
