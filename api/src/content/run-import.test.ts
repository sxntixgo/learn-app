import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ImportProgressEvent } from './run-import.ts';
import { runImportPipeline } from './run-import.ts';

// ---------------------------------------------------------------------------
// Direct pipeline tests — NOT through HTTP.
//
// The admin API route (api/src/routes/admin.ts) never passes
// allowFileUrl, so a real success can only be driven through HTTP against a
// network-reachable https:// remote, which this hermetic suite has no
// access to (same reasoning as tools/src/import-url.test.ts, which drives
// the CLI's URL mode against a `file://` bare repo with the CLI's own
// --allow-file-url escape hatch). This file exercises runImportPipeline
// directly, the one place allowFileUrl is legitimately turned on, to prove
// the pipeline itself — clone -> validate -> parse -> write, with
// import_runs bookkeeping at every stage — works end to end. The route's
// own tests (admin.test.ts) cover what HTTP can prove: the 403/400 paths
// and that a file:// URL posted to the API is refused.
// ---------------------------------------------------------------------------

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run run-import.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.resolve(here, '../../../tools/src/migrate.ts');
const cliEnv = { ...process.env, DATABASE_URL: connectionString };

const CLONE_PREFIX = 'learn-clone-';

async function cloneTempEntries(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith(CLONE_PREFIX));
}

async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  return run('git', args, { cwd });
}

interface SourceRepo {
  bareDir: string;
  workDir: string;
  commit: string;
  url: string;
}

async function commitAndBare(workDir: string): Promise<SourceRepo> {
  await git(['add', '-A'], workDir);
  await git(['commit', '--quiet', '-m', 'initial'], workDir);
  const { stdout } = await git(['rev-parse', 'HEAD'], workDir);

  const bareDir = await mkdtemp(path.join(tmpdir(), 'run-import-bare-'));
  await run('git', ['clone', '--quiet', '--bare', workDir, bareDir]);

  return { bareDir, workDir, commit: stdout.trim(), url: `file://${bareDir}` };
}

async function initRepo(): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'run-import-src-'));
  await git(['init', '--quiet', '--initial-branch=main'], workDir);
  await git(['config', 'user.email', 'test@example.com'], workDir);
  await git(['config', 'user.name', 'Test'], workDir);
  return workDir;
}

/** A valid one-lesson course — the happy path fixture. */
async function makeValidRepo(slug: string): Promise<SourceRepo> {
  const workDir = await initRepo();
  await mkdir(path.join(workDir, 'modules/01-intro'), { recursive: true });
  await writeFile(
    path.join(workDir, 'course.yaml'),
    `schema: 1\nslug: ${slug}\ntitle: Run Import Test\nmodules:\n` +
      `  - id: intro\n    title: Intro\n    lessons:\n      - modules/01-intro/one.md\n`,
  );
  await writeFile(path.join(workDir, 'modules/01-intro/one.md'), '---\ntitle: One\n---\n\nHello from a clone.\n');
  return commitAndBare(workDir);
}

/** A manifest that parses fine but references a lesson file that does not exist — a validate-stage failure with a known slug. */
async function makeMissingLessonRepo(slug: string): Promise<SourceRepo> {
  const workDir = await initRepo();
  await mkdir(path.join(workDir, 'modules/01-intro'), { recursive: true });
  await writeFile(
    path.join(workDir, 'course.yaml'),
    `schema: 1\nslug: ${slug}\ntitle: Run Import Test\nmodules:\n` +
      `  - id: intro\n    title: Intro\n    lessons:\n      - modules/01-intro/does-not-exist.md\n`,
  );
  return commitAndBare(workDir);
}

/** A manifest whose lesson names a track course.yaml never declares — passes validate-only (validateCourseDir doesn't cross-check tracks) but fails inside importCourse's write stage. */
async function makeBadTrackRepo(slug: string): Promise<SourceRepo> {
  const workDir = await initRepo();
  await mkdir(path.join(workDir, 'modules/01-intro'), { recursive: true });
  await writeFile(
    path.join(workDir, 'course.yaml'),
    `schema: 1\nslug: ${slug}\ntitle: Run Import Test\nmodules:\n` +
      `  - id: intro\n    title: Intro\n    lessons:\n      - modules/01-intro/one.md\n`,
  );
  await writeFile(
    path.join(workDir, 'modules/01-intro/one.md'),
    '---\ntitle: One\ntrack: no-such-track\n---\n\nBroken.\n',
  );
  return commitAndBare(workDir);
}

async function cleanupRepo(repo: SourceRepo): Promise<void> {
  await rm(repo.bareDir, { recursive: true, force: true });
  await rm(repo.workDir, { recursive: true, force: true });
}

describe.sequential('runImportPipeline', () => {
  const pool = new Pool({ connectionString });

  beforeAll(async () => {
    await run(process.execPath, [migrateCli], { env: cliEnv });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function collectEvents(url: string, opts: { ref?: string; allowFileUrl?: boolean } = {}) {
    const client = await pool.connect();
    const events: ImportProgressEvent[] = [];
    try {
      const result = await runImportPipeline(client, { url, ...opts }, (event) => events.push(event));
      return { result, events };
    } finally {
      client.release();
    }
  }

  async function cleanupRun(slug: string, url: string): Promise<void> {
    await pool.query('delete from import_runs where course_slug = $1 or repo_id = (select id from content_repos where url = $2)', [slug, url]);
    await pool.query('delete from courses where slug = $1', [slug]);
    await pool.query('delete from content_repos where url = $1', [url]);
  }

  it('clones, validates, parses, and writes a valid repo, streaming every stage and recording one success row', async () => {
    const slug = 'run-import-happy';
    const repo = await makeValidRepo(slug);
    try {
      const before = await cloneTempEntries();

      const { result, events } = await collectEvents(repo.url, { allowFileUrl: true });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.slug).toBe(slug);
      expect(result.commitSha).toBe(repo.commit);
      expect(result.counts.lessons).toMatchObject({ created: 1, updated: 0, skipped: 0, archived: 0 });

      expect(events.map((e) => e.stage)).toEqual(['cloning', 'validating', 'parsing', 'writing', 'done']);
      const done = events.at(-1)!;
      expect(done.importRunId).toBe(result.importRunId);
      expect(done.slug).toBe(slug);

      const runRow = await pool.query(
        `select status, commit_sha, course_slug, repo_id from import_runs where id = $1`,
        [result.importRunId],
      );
      expect(runRow.rows[0]).toMatchObject({ status: 'success', commit_sha: repo.commit, course_slug: slug });
      expect(runRow.rows[0].repo_id).not.toBeNull();

      const repoRow = await pool.query(`select last_synced_at from content_repos where url = $1`, [repo.url]);
      expect(repoRow.rows[0].last_synced_at).not.toBeNull();

      // No content left on disk after the import (design §4).
      expect(await cloneTempEntries()).toEqual(before);
    } finally {
      await cleanupRun(slug, repo.url);
      await cleanupRepo(repo);
    }
  });

  it('refuses a file:// URL when allowFileUrl is not passed — the exact call the admin route makes', async () => {
    const slug = 'run-import-refused';
    const repo = await makeValidRepo(slug);
    let importRunId: string | undefined;
    try {
      const { result, events } = await collectEvents(repo.url); // no allowFileUrl

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.problems.join('\n')).toMatch(/Refusing to clone file:\/\//);
      expect(result.problems.join('\n')).toMatch(/only https:\/\/ and ssh:\/\/ remotes are allowed/);

      expect(events.map((e) => e.stage)).toEqual(['cloning', 'failed']);
      const failed = events.at(-1)!;
      expect(failed.importRunId).toBeTruthy();
      importRunId = failed.importRunId;

      const runRow = await pool.query(`select status, repo_id, course_slug from import_runs where id = $1`, [
        failed.importRunId,
      ]);
      expect(runRow.rows[0]).toMatchObject({ status: 'failed', repo_id: null, course_slug: null });
    } finally {
      // Never actually cloned, so no content_repos row exists for this URL.
      if (importRunId) await pool.query('delete from import_runs where id = $1', [importRunId]);
      await cleanupRepo(repo);
    }
  });

  it('fails validation on a manifest referencing a missing lesson file, returning the full problem list and recording a failed row with the known slug', async () => {
    const slug = 'run-import-missing-lesson';
    const repo = await makeMissingLessonRepo(slug);
    try {
      const { result, events } = await collectEvents(repo.url, { allowFileUrl: true });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.problems.some((p) => p.includes('modules/01-intro/does-not-exist.md'))).toBe(true);

      expect(events.map((e) => e.stage)).toEqual(['cloning', 'validating', 'failed']);
      const failed = events.at(-1)!;
      expect(failed.problems).toEqual(result.problems);

      const runRow = await pool.query(
        `select status, course_slug, commit_sha, log from import_runs where id = $1`,
        [failed.importRunId],
      );
      expect(runRow.rows[0]).toMatchObject({ status: 'failed', course_slug: slug, commit_sha: repo.commit });
      expect(runRow.rows[0].log.problems).toEqual(result.problems);

      // The temp clone directory is still removed on a validate-stage failure.
      expect(await cloneTempEntries()).toEqual([]);
    } finally {
      await cleanupRun(slug, repo.url);
      await cleanupRepo(repo);
    }
  });

  it('fails at the write stage on an undeclared track, relying on importCourse’s own row rather than writing a second one', async () => {
    const slug = 'run-import-bad-track';
    const repo = await makeBadTrackRepo(slug);
    try {
      const { result, events } = await collectEvents(repo.url, { allowFileUrl: true });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.problems.join('\n')).toMatch(/no-such-track/);

      expect(events.map((e) => e.stage)).toEqual(['cloning', 'validating', 'parsing', 'writing', 'failed']);

      const runs = await pool.query(`select status, course_slug from import_runs where course_slug = $1`, [slug]);
      // Exactly one row for this attempt — proves run-import.ts did not
      // double-write on top of importCourse's own bookkeeping.
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({ status: 'failed', course_slug: slug });
    } finally {
      await cleanupRun(slug, repo.url);
      await cleanupRepo(repo);
    }
  });
});
