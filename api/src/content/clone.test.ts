import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cloneCourseRepo, removeClone } from './clone.ts';

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  return run('git', args, { cwd });
}

// Matches clone.ts's own TEMP_PREFIX — kept independent here (not imported)
// so this assertion catches a change to that prefix as a real behavior
// change rather than silently tracking it.
const CLONE_PREFIX = 'learn-clone-';

async function cloneTempEntries(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith(CLONE_PREFIX));
}

interface BareRepo {
  bareDir: string;
  workDir: string;
  commit: string;
}

/**
 * Builds a real git repo in a fresh temp dir — one commit containing a
 * minimal course — then `git clone --bare` it. A `file://` URL at the bare
 * repo gives every test here a real git clone with no network dependency,
 * which is what keeps this file hermetic in CI (no access to github.com).
 */
async function makeBareRepo(defaultBranch: string): Promise<BareRepo> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'clone-src-'));
  await git(['init', '--quiet', `--initial-branch=${defaultBranch}`], workDir);
  await git(['config', 'user.email', 'test@example.com'], workDir);
  await git(['config', 'user.name', 'Test'], workDir);

  await mkdir(path.join(workDir, 'modules/01-intro'), { recursive: true });
  await writeFile(
    path.join(workDir, 'course.yaml'),
    'schema: 1\nslug: clone-test-course\ntitle: Clone Test\nmodules:\n' +
      '  - id: intro\n    title: Intro\n    lessons:\n      - modules/01-intro/one.md\n',
  );
  await writeFile(path.join(workDir, 'modules/01-intro/one.md'), '---\ntitle: One\n---\n\nHello.\n');

  await git(['add', '-A'], workDir);
  await git(['commit', '--quiet', '-m', 'initial'], workDir);
  const { stdout } = await git(['rev-parse', 'HEAD'], workDir);
  const commit = stdout.trim();

  const bareDir = await mkdtemp(path.join(tmpdir(), 'clone-bare-'));
  await run('git', ['clone', '--quiet', '--bare', workDir, bareDir]);

  return { bareDir, workDir, commit };
}

describe('cloneCourseRepo', () => {
  let bareMain: BareRepo;
  let bareTrunk: BareRepo;

  beforeAll(async () => {
    bareMain = await makeBareRepo('main');
    bareTrunk = await makeBareRepo('trunk');
  });

  afterAll(async () => {
    for (const d of [bareMain.bareDir, bareMain.workDir, bareTrunk.bareDir, bareTrunk.workDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('clones a file:// URL at depth 1 and resolves HEAD to the real commit sha', async () => {
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`);
    try {
      expect(clone.commit).toBe(bareMain.commit);
      expect(existsSync(path.join(clone.dir, 'course.yaml'))).toBe(true);

      const { stdout } = await git(['rev-list', '--count', 'HEAD'], clone.dir);
      expect(stdout.trim()).toBe('1'); // --depth 1: exactly one commit of history
    } finally {
      await removeClone(clone.dir);
    }
  });

  it("falls back to the repo's actual default branch when main does not exist and no ref was requested", async () => {
    const clone = await cloneCourseRepo(`file://${bareTrunk.bareDir}`);
    try {
      expect(clone.commit).toBe(bareTrunk.commit);
      expect(existsSync(path.join(clone.dir, 'course.yaml'))).toBe(true);
    } finally {
      await removeClone(clone.dir);
    }
  });

  it('does not fall back when an explicit ref is requested and missing, and cleans up its temp dir', async () => {
    const before = await cloneTempEntries();

    await expect(cloneCourseRepo(`file://${bareMain.bareDir}`, { ref: 'no-such-branch' })).rejects.toThrow();

    const after = await cloneTempEntries();
    expect(after).toEqual(before);
  });

  it('removes its own temp directory when the clone fails outright', async () => {
    const before = await cloneTempEntries();

    await expect(cloneCourseRepo('file:///no/such/path/at/all')).rejects.toThrow();

    const after = await cloneTempEntries();
    expect(after).toEqual(before);
  });

  it('removeClone deletes a successful clone directory', async () => {
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`);
    expect(existsSync(clone.dir)).toBe(true);

    await removeClone(clone.dir);
    expect(existsSync(clone.dir)).toBe(false);
  });

  it('removeClone is a no-op on an already-removed directory', async () => {
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`);
    await removeClone(clone.dir);
    await expect(removeClone(clone.dir)).resolves.toBeUndefined();
  });
});
