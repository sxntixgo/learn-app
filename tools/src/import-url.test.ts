import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run import-url.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.join(here, 'migrate.ts');
const importCliPath = path.join(here, 'import.ts');
const cliEnv = { ...process.env, DATABASE_URL: connectionString };

// Matches clone.ts's TEMP_PREFIX, kept independent so a change to it shows up
// here as a real behavior change rather than being silently tracked.
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
}

/**
 * Writes a one-lesson course into a fresh git working directory, commits it,
 * then makes a bare clone of that working directory — the bare repo is what
 * gets imported via a `file://` URL, giving these tests a real git clone
 * with no network dependency (CI has no access to github.com).
 */
async function makeSourceRepo(slug: string, lessonBody: string): Promise<SourceRepo> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'import-url-src-'));
  await git(['init', '--quiet', '--initial-branch=main'], workDir);
  await git(['config', 'user.email', 'test@example.com'], workDir);
  await git(['config', 'user.name', 'Test'], workDir);

  await mkdir(path.join(workDir, 'modules/01-intro'), { recursive: true });
  await writeFile(
    path.join(workDir, 'course.yaml'),
    `schema: 1\nslug: ${slug}\ntitle: URL Import Test\nmodules:\n` +
      `  - id: intro\n    title: Intro\n    lessons:\n      - modules/01-intro/one.md\n`,
  );
  await writeFile(path.join(workDir, 'modules/01-intro/one.md'), lessonBody);

  await git(['add', '-A'], workDir);
  await git(['commit', '--quiet', '-m', 'initial'], workDir);
  const { stdout } = await git(['rev-parse', 'HEAD'], workDir);

  const bareDir = await mkdtemp(path.join(tmpdir(), 'import-url-bare-'));
  await run('git', ['clone', '--quiet', '--bare', workDir, bareDir]);

  return { bareDir, workDir, commit: stdout.trim() };
}

async function importCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [importCliPath, ...args], { env: cliEnv });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe.sequential('import CLI — URL mode', () => {
  const pool = new Pool({ connectionString });
  const slug = 'import-url-test-course';
  let repo: SourceRepo;

  beforeAll(async () => {
    await run(process.execPath, [migrateCli], { env: cliEnv });
    repo = await makeSourceRepo(slug, '---\ntitle: One\n---\n\nHello from a clone.\n');
  });

  afterAll(async () => {
    await pool.query(`delete from import_runs where course_slug = $1`, [slug]);
    await pool.query(`delete from courses where slug = $1`, [slug]);
    await pool.query(`delete from content_repos where url = $1`, [`file://${repo.bareDir}`]);
    await pool.end();
    await rm(repo.bareDir, { recursive: true, force: true });
    await rm(repo.workDir, { recursive: true, force: true });
  });

  it('clones, imports, records the commit sha and repo row, and removes the temp clone directory', async () => {
    const before = await cloneTempEntries();
    const url = `file://${repo.bareDir}`;

    const { stdout, code } = await importCli(['--url', url]);

    expect(code).toBe(0);
    expect(stdout).toContain(`${slug}: import ok`);
    expect(stdout).toMatch(/lessons\s+1 created/);

    const course = await pool.query(`select imported_commit, repo_id from courses where slug = $1`, [slug]);
    expect(course.rows[0].imported_commit).toBe(repo.commit);
    expect(course.rows[0].repo_id).not.toBeNull();

    const repoRow = await pool.query(
      `select url, default_ref, last_synced_at from content_repos where url = $1`,
      [url],
    );
    expect(repoRow.rows).toHaveLength(1);
    expect(repoRow.rows[0].default_ref).toBe('main');
    expect(repoRow.rows[0].last_synced_at).not.toBeNull();

    const runs = await pool.query(
      `select repo_id, commit_sha from import_runs where course_slug = $1 order by started_at`,
      [slug],
    );
    expect(runs.rows[0].commit_sha).toBe(repo.commit);
    expect(runs.rows[0].repo_id).toBe(course.rows[0].repo_id);

    // The temp clone directory must not survive a successful import (design
    // §4: no content left on disk after import).
    const after = await cloneTempEntries();
    expect(after).toEqual(before);
  });

  it('is a no-op at the lesson level on re-import of the same unchanged commit', async () => {
    const { stdout, code } = await importCli(['--url', `file://${repo.bareDir}`]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/lessons\s+0 created,\s+0 updated,\s+1 skipped,\s+0 archived/);
  });

  it('removes the temp clone directory after a FAILED import too', async () => {
    const badSlug = `${slug}-broken`;
    const badRepo = await makeSourceRepo(badSlug, '---\ntitle: One\ntrack: no-such-track\n---\n\nBroken.\n');

    try {
      const before = await cloneTempEntries();

      const { code, stderr } = await importCli(['--url', `file://${badRepo.bareDir}`]);

      expect(code).toBe(1);
      expect(stderr).toMatch(/no-such-track/);

      const after = await cloneTempEntries();
      expect(after).toEqual(before);

      const rows = await pool.query(`select 1 from courses where slug = $1`, [badSlug]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await pool.query(`delete from import_runs where course_slug = $1`, [badSlug]);
      await pool.query(`delete from content_repos where url = $1`, [`file://${badRepo.bareDir}`]);
      await rm(badRepo.bareDir, { recursive: true, force: true });
      await rm(badRepo.workDir, { recursive: true, force: true });
    }
  });
});
