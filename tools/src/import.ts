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
    // Design §9.2/§9.3. Printed even when a manifest declares none: a row of
    // zeroes is how an author sees that the `badges:` key they just added is
    // not being read, which is exactly the case a missing line would hide.
    formatCounts('degrees', counts.degrees),
    formatCounts('badges', counts.badges),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Argument parsing: two mutually exclusive modes.
//   npm run import -- <dir>
//   npm run import -- --url <git-url> [--ref <ref>] [--allow-file-url]
//
// `--allow-file-url` is the operator-level half of clone.ts's `allowFileUrl`
// switch, and it is a SEPARATE argv token on purpose. A repo URL is one
// element of `process.argv`; there is no quoting, escaping or query string
// that makes one string become two array entries, so a URL can never turn the
// flag on for itself no matter who supplied it.
//
// Allowing it here costs nothing an operator does not already have: this CLI
// requires DATABASE_URL and a shell on the host, and its other mode imports
// any local directory you name. `file://` from an operator's shell is not a
// privilege — it is the same privilege spelled differently. The caller this
// protects is the ADMIN API ROUTE (Phase 6+), which takes a URL from an HTTP
// request and must call cloneCourseRepo(url) with no options at all.
// ---------------------------------------------------------------------------

type ParsedArgs =
  | { mode: 'dir'; dir: string }
  | { mode: 'url'; url: string; ref: string | undefined; allowFileUrl: boolean };

function parseArgs(argv: string[]): ParsedArgs | undefined {
  if (argv[0] === '--url') {
    const url = argv[1];
    if (!url) return undefined;

    let ref: string | undefined;
    let allowFileUrl = false;

    for (let i = 2; i < argv.length; ) {
      if (argv[i] === '--ref') {
        ref = argv[i + 1];
        if (!ref) return undefined;
        i += 2;
      } else if (argv[i] === '--allow-file-url') {
        allowFileUrl = true;
        i += 1;
      } else {
        return undefined;
      }
    }

    return { mode: 'url', url, ref, allowFileUrl };
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
async function importFromUrl(
  pool: pg.Pool,
  url: string,
  ref: string | undefined,
  allowFileUrl: boolean,
): Promise<void> {
  let clone: ClonedRepo;
  try {
    clone = await cloneCourseRepo(url, { ref, allowFileUrl });
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
    console.error('       npm run import -- --url <git-url> [--ref <ref>] [--allow-file-url]');
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
      await importFromUrl(pool, parsed.url, parsed.ref, parsed.allowFileUrl);
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
