import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { ClonedRepo } from '@learn/api/content/clone';
import { cloneCourseRepo, removeClone } from '@learn/api/content/clone';
import { importCourse } from '@learn/api/content/import';
import type { EntityCounts, ImportCounts } from '@learn/api/content/import';
import { loadCourse } from '@learn/api/content/manifest';
import { markRepoSynced, upsertContentRepo } from '@learn/api/content/repos';
import { validateCourseDir } from './validate.ts';

const { Pool } = pg;

function formatCounts(label: string, counts: EntityCounts): string {
  return (
    `  ${label.padEnd(8)}` +
    `${String(counts.created).padStart(4)} created, ` +
    `${String(counts.updated).padStart(4)} updated, ` +
    `${String(counts.skipped).padStart(4)} skipped, ` +
    `${String(counts.archived).padStart(4)} archived`
  );
}

function formatSummary(slug: string, counts: ImportCounts): string {
  return [
    `${slug}: import ok`,
    formatCounts('courses', counts.courses),
    formatCounts('tracks', counts.tracks),
    formatCounts('modules', counts.modules),
    formatCounts('lessons', counts.lessons),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Argument parsing: two mutually exclusive modes.
//   npm run import -- <dir>
//   npm run import -- --url <git-url> [--ref <ref>]
// ---------------------------------------------------------------------------

type ParsedArgs = { mode: 'dir'; dir: string } | { mode: 'url'; url: string; ref: string | undefined };

function parseArgs(argv: string[]): ParsedArgs | undefined {
  if (argv[0] === '--url') {
    const url = argv[1];
    if (!url) return undefined;

    if (argv[2] === undefined) return { mode: 'url', url, ref: undefined };
    if (argv[2] !== '--ref') return undefined;
    const ref = argv[3];
    if (!ref || argv[4] !== undefined) return undefined;
    return { mode: 'url', url, ref };
  }

  const dirArg = argv[0];
  if (!dirArg || dirArg.startsWith('--') || argv[1] !== undefined) return undefined;
  return { mode: 'dir', dir: path.resolve(dirArg) };
}

/**
 * Validates, loads and imports one already-resolved course directory,
 * printing the same summary/error format regardless of whether the
 * directory came from the CLI's positional arg or from a fresh git clone.
 *
 * Returns whether the import succeeded — the URL-mode caller uses this to
 * decide whether to mark the repo as synced (never on a failed import).
 */
async function importAndReport(
  pool: pg.Pool,
  dir: string,
  opts: { commit: string | null; repoId: string | null },
): Promise<boolean> {
  const validation = await validateCourseDir(dir);
  if (!validation.ok) {
    for (const problem of validation.problems) {
      console.error(problem);
    }
    console.error(`\n${validation.problems.length} problem(s) — nothing was imported.`);
    process.exitCode = 1;
    return false;
  }

  const course = await loadCourse(dir);

  const client = await pool.connect();
  try {
    const result = await importCourse(client, course, opts);
    console.log(formatSummary(result.slug, result.counts));
    return true;
  } catch (err) {
    console.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('The previously imported version of this course is unchanged.');
    process.exitCode = 1;
    return false;
  } finally {
    client.release();
  }
}

/**
 * `npm run import -- --url <git-url> [--ref <ref>]` — clones the repo,
 * imports it exactly like directory mode, and always removes the clone
 * directory afterward (design §4: no content left on disk after an
 * import), whether the import succeeded or failed.
 */
async function importFromUrl(pool: pg.Pool, url: string, ref: string | undefined): Promise<void> {
  let clone: ClonedRepo;
  try {
    clone = await cloneCourseRepo(url, { ref });
  } catch (err) {
    console.error(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const client = await pool.connect();
    let repoId: string;
    try {
      repoId = await upsertContentRepo(client, url, ref ?? 'main');
    } finally {
      client.release();
    }

    const ok = await importAndReport(pool, clone.dir, { commit: clone.commit, repoId });
    if (ok) {
      const syncClient = await pool.connect();
      try {
        await markRepoSynced(syncClient, repoId);
      } finally {
        syncClient.release();
      }
    }
  } finally {
    await removeClone(clone.dir);
  }
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('Usage: npm run import -- <dir>');
    console.error('       npm run import -- --url <git-url> [--ref <ref>]');
    process.exitCode = 1;
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    if (parsed.mode === 'dir') {
      if (!existsSync(parsed.dir)) {
        console.error(`Course directory not found: ${parsed.dir}`);
        process.exitCode = 1;
        return;
      }
      // No commit sha: this is an import from a local directory, so there is
      // nothing truthful to record. URL mode below supplies one from the clone.
      await importAndReport(pool, parsed.dir, { commit: null, repoId: null });
    } else {
      await importFromUrl(pool, parsed.url, parsed.ref);
    }
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
