import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { importCourse } from '@learn/api/content/import';
import type { EntityCounts, ImportCounts } from '@learn/api/content/import';
import { loadCourse } from '@learn/api/content/manifest';
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

/**
 * `npm run import -- <dir>` — imports one course directory into the database.
 *
 * Validate, then load, then import, in that order and as three separate steps:
 * `validateCourseDir` reports EVERY problem in the repo at once, which is what
 * an author fixing content needs, while `importCourse` fails on the first
 * problem because it is holding a transaction open. Running the validator
 * first means the common case — a content repo with several mistakes in it —
 * produces the full list rather than one error per attempt.
 */
async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const dirArg = process.argv[2];
  if (!dirArg) {
    console.error('Usage: npm run import -- <dir>');
    process.exitCode = 1;
    return;
  }

  const dir = path.resolve(dirArg);
  if (!existsSync(dir)) {
    console.error(`Course directory not found: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const validation = await validateCourseDir(dir);
  if (!validation.ok) {
    for (const problem of validation.problems) {
      console.error(problem);
    }
    console.error(`\n${validation.problems.length} problem(s) — nothing was imported.`);
    process.exitCode = 1;
    return;
  }

  const course = await loadCourse(dir);

  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      // No commit sha: this is an import from a local directory, so there is
      // nothing truthful to record. Phase 5's git clone supplies one.
      const result = await importCourse(client, course, { commit: null });
      console.log(formatSummary(result.slug, result.counts));
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('The previously imported version of this course is unchanged.');
    process.exitCode = 1;
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
