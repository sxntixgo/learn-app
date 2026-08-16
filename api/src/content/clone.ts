import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Cloning a content repo (design §8): the first stage of the import pipeline,
// upstream of loadCourse/importCourse. This module is deliberately git-only
// and DB-free — it knows nothing about content_repos or import_runs, so the
// same clone can be reused from a CLI, an admin API route, or a future CI
// validator with no change here (mirrors the loadCourse/importCourse split
// in manifest.ts and import.ts).
//
// Phase 5 hardening (design §8.1: "Clone limits: depth 1, size cap, timeout,
// and a URL scheme allowlist so a repo URL cannot become file:///etc"). The
// URL is the whole attack surface of this module: `git clone` will happily
// read the local filesystem (`file://`), speak plaintext (`git://`, `http://`)
// or execute a command (`ext::sh -c …`) if you let the URL choose. So the URL
// is checked against an allowlist before git sees it, and git is then told
// again, through GIT_ALLOW_PROTOCOL, which transports it may use at all.
// ---------------------------------------------------------------------------

const DEFAULT_REF = 'main';

/** Prefix for every temp directory this module creates — lets tests and
 * operators recognise a leaked clone directory at a glance. */
const TEMP_PREFIX = 'learn-clone-';

/** A clone that has not finished in this long is a hung remote, not a big
 * repo: `--depth 1` of a documentation repo is seconds. */
export const DEFAULT_CLONE_TIMEOUT_MS = 120_000;

/** Refuse a content repo larger than this. Generous for prose and code
 * samples; far below anything that threatens the host's disk. */
export const DEFAULT_MAX_CLONE_BYTES = 256 * 1024 * 1024;

/** How often the size cap is re-measured while git is still running. */
const DEFAULT_SIZE_POLL_MS = 250;

/** Cap on captured child output, so a hostile remote cannot make the
 * importer buffer unbounded stderr. */
const MAX_CAPTURED_OUTPUT = 4096;

export interface ClonedRepo {
  /** Absolute path to the freshly cloned working tree. */
  dir: string;
  /** The commit HEAD resolved to after clone (`git rev-parse HEAD`), recorded on `courses.imported_commit` and `import_runs.commit_sha`. */
  commit: string;
}

export interface CloneOptions {
  /**
   * Branch/tag to check out. Defaults to `main`. When omitted, a clone that
   * fails because `main` does not exist retries once against the repo's
   * actual default branch (design brief: "default ref main with a sensible
   * fallback if the repo's default differs") — an explicitly requested ref
   * that fails is never silently substituted.
   */
  ref?: string;
  /** Abort the clone after this many milliseconds. Default `DEFAULT_CLONE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Abort the clone once the working tree exceeds this many bytes. Default `DEFAULT_MAX_CLONE_BYTES`. */
  maxBytes?: number;
  /** How often to re-measure the clone against `maxBytes`. Exposed for tests. */
  sizePollMs?: number;
  /**
   * Permit a `file://` URL.
   *
   * THIS IS AN INTERNAL SWITCH, NOT A SETTING. It is a TypeScript argument, so
   * the only way to turn it on is to write code that turns it on: no repo URL,
   * no manifest field, no HTTP request body and no config file can reach it,
   * because none of them are function arguments. A caller that takes a URL
   * from a user must simply never pass it — see the note on `assertAllowedRepoUrl`.
   *
   * It exists because the test suites for this module and for the import CLI
   * clone from `file://` bare repos to stay hermetic (CI has no network), and
   * deleting those tests to satisfy the allowlist would trade a real
   * regression net for a cosmetic one.
   */
  allowFileUrl?: boolean;
}

/** Transports git may use, in `GIT_ALLOW_PROTOCOL` form. */
const ALLOWED_GIT_PROTOCOLS = ['https', 'ssh'];

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** `git@github.com:org/repo.git` — scp-like syntax, which git treats as ssh. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/\/)\S+$/;
/** Whitespace or a C0/DEL control character. A newline in a repo URL would
 * let it forge extra lines in an operator's log, and none of the transports
 * we allow has a legitimate use for one. */
const UNSAFE_URL_CHAR = (code: number): boolean => code <= 0x20 || code === 0x7f;

/**
 * Refuses any repo URL that is not an `https://` or `ssh://` remote (or the
 * scp-like `git@host:path` spelling of ssh).
 *
 * Explicitly refused, and each for its own reason:
 *
 * - `file://` and bare local paths — design §8.1's named example: "a repo URL
 *   cannot become `file:///etc`". This is arbitrary local filesystem read.
 * - `ext::sh -c …` — git's ext transport runs a command. Remote code
 *   execution disguised as a URL.
 * - `git://` and `http://` — unauthenticated plaintext, so the content that
 *   arrives is whatever the network says it is.
 * - Anything starting with `-` — never reaches git as an option (every call
 *   site passes `--` first and `spawn` never involves a shell), but a URL that
 *   looks like a flag is hostile input regardless, and rejecting it here means
 *   the argv discipline is not the only thing standing between us and it.
 *
 * `allowFileUrl` is described on `CloneOptions`: a code-level switch a
 * user-supplied string cannot set. When an admin API route eventually calls
 * `cloneCourseRepo`, it passes a URL and nothing else, and `file://` is
 * refused for it with no further thought required.
 */
export function assertAllowedRepoUrl(url: string, opts: { allowFileUrl?: boolean } = {}): void {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Refusing to clone: the repository URL is empty.');
  }
  if ([...url].some((ch) => UNSAFE_URL_CHAR(ch.codePointAt(0)!))) {
    throw new Error('Refusing to clone: the repository URL contains whitespace or control characters.');
  }
  if (url.startsWith('-')) {
    throw new Error(`Refusing to clone ${url}: a repository URL may not begin with "-".`);
  }

  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();

  if (scheme === undefined) {
    if (SCP_LIKE.test(url)) return; // git@host:path — ssh
    throw refusedUrl(url, opts.allowFileUrl);
  }
  if (opts.allowFileUrl && scheme === 'file' && url.startsWith('file://')) return;
  if (ALLOWED_GIT_PROTOCOLS.includes(scheme) && url.startsWith(`${scheme}://`)) return;

  throw refusedUrl(url, opts.allowFileUrl);
}

function refusedUrl(url: string, allowFileUrl: boolean | undefined): Error {
  return new Error(
    `Refusing to clone ${url}: only https:// and ssh:// remotes are allowed ` +
      `(git@host:path is accepted as ssh)${allowFileUrl ? ', plus file:// for this internal caller' : ''}. ` +
      `file://, git://, http:// and git's ext:: transport are refused.`,
  );
}

/**
 * Clones a git repository at `--depth 1` into a fresh temporary directory
 * and resolves the commit it landed on.
 *
 * The caller owns the returned directory and MUST remove it with
 * `removeClone` once done — this function only guarantees its OWN temp
 * directory is gone if cloning itself fails. Design §4 requires no content
 * left on disk after an import; that is what keeps the app container
 * disposable and the backup story a single `pg_dump`.
 *
 * Three limits apply, and it is worth being precise about what each one buys:
 *
 * - **Scheme allowlist** — enforced twice: once here (`assertAllowedRepoUrl`)
 *   and once by git itself (`GIT_ALLOW_PROTOCOL`), which also covers
 *   transports a redirect or a submodule might try to reach for.
 * - **Timeout** — the clone is killed by process GROUP, not just the direct
 *   child. `git` delegates to `git-remote-https`/`ssh`, and killing only the
 *   parent leaves those holding the socket.
 * - **Size cap** — the working tree is measured WHILE git runs and the clone
 *   is killed the moment it goes over. What that guarantees: a repo designed
 *   to fill the disk is stopped in the act. What it does NOT guarantee: an
 *   exact ceiling. Between two polls git may write more, so the real bound is
 *   `maxBytes` plus whatever the machine can write in one poll interval, and
 *   a repo that fits under the cap only until its final second is caught by
 *   the same check re-run after git exits. This is a disk-exhaustion brake,
 *   not a quota; a real quota belongs in the filesystem (a size-limited
 *   volume or tmpfs for the clone directory), which is the one mechanism the
 *   importer cannot outrun.
 */
export async function cloneCourseRepo(url: string, opts: CloneOptions = {}): Promise<ClonedRepo> {
  assertAllowedRepoUrl(url, { allowFileUrl: opts.allowFileUrl });

  const limits: CloneLimits = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_CLONE_BYTES,
    sizePollMs: opts.sizePollMs ?? DEFAULT_SIZE_POLL_MS,
    env: gitEnv(opts.allowFileUrl === true),
  };

  const explicitRef = opts.ref;
  let dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));

  try {
    try {
      await gitCloneBranch(url, explicitRef ?? DEFAULT_REF, dir, limits);
    } catch (err) {
      if (explicitRef !== undefined) throw err;
      // A limit was hit, not a missing branch. Retrying would just spend the
      // budget twice against a remote that has already misbehaved.
      if (err instanceof CloneLimitError) throw err;

      // Sensible fallback: the repo's actual default branch isn't literally
      // named "main" (e.g. "master", or a renamed default). Re-clone into a
      // clean directory with no --branch at all, so git resolves whatever
      // HEAD actually points at instead of us guessing a second name.
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
      await gitCloneDefault(url, dir, limits);
    }

    const commit = await resolveHeadSha(dir, limits);
    return { dir, commit };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Recursively removes a directory returned by `cloneCourseRepo`. Safe to
 * call even if the directory is already gone (e.g. a caller that also
 * cleans up on its own error path).
 */
export async function removeClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

interface CloneLimits {
  timeoutMs: number;
  maxBytes: number;
  sizePollMs: number;
  env: NodeJS.ProcessEnv;
}

/** Thrown when a clone was aborted by a limit rather than by git failing. */
class CloneLimitError extends Error {}

function gitEnv(allowFileUrl: boolean): NodeJS.ProcessEnv {
  const protocols = allowFileUrl ? [...ALLOWED_GIT_PROTOCOLS, 'file'] : ALLOWED_GIT_PROTOCOLS;
  return {
    ...process.env,
    // Belt to assertAllowedRepoUrl's braces, and it reaches further: this also
    // governs transports pulled in by an HTTP redirect or a submodule URL,
    // which never pass through our own check.
    GIT_ALLOW_PROTOCOL: protocols.join(':'),
    // A remote that demands credentials must fail, not sit on a prompt
    // waiting for a terminal that does not exist.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  };
}

// `spawn` with an argument array — never a shell — so nothing in `url` or
// `ref` is ever interpreted as shell syntax. `--` separates options from the
// repository argument so a URL cannot be parsed as a flag.

async function gitCloneBranch(url: string, ref: string, dest: string, limits: CloneLimits): Promise<void> {
  await runGit(
    ['clone', '--quiet', '--depth', '1', '--branch', ref, '--single-branch', '--', url, dest],
    limits,
    dest,
  );
}

async function gitCloneDefault(url: string, dest: string, limits: CloneLimits): Promise<void> {
  await runGit(['clone', '--quiet', '--depth', '1', '--', url, dest], limits, dest);
}

async function resolveHeadSha(dir: string, limits: CloneLimits): Promise<string> {
  const stdout = await runGit(['-C', dir, 'rev-parse', 'HEAD'], limits);
  return stdout.trim();
}

/**
 * Runs git under the timeout, and — when `watchDir` is given — under the size
 * cap as well.
 *
 * @param watchDir Directory whose growth is measured against `limits.maxBytes`.
 */
function runGit(args: string[], limits: CloneLimits, watchDir?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // detached: the child gets its own process group, so a kill can take the
    // transport helpers down with it instead of orphaning them.
    const child = spawn('git', args, { env: limits.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let aborted: Error | undefined;
    let sizePoll: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };

    const timeout = setTimeout(() => {
      aborted ??= new CloneLimitError(
        `git ${args[0]} timed out after ${limits.timeoutMs}ms and was killed — the remote is unreachable or hung.`,
      );
      killTree();
    }, limits.timeoutMs);

    if (watchDir !== undefined) {
      let measuring = false;
      sizePoll = setInterval(() => {
        if (measuring || aborted) return;
        measuring = true;
        void directorySizeBytes(watchDir)
          .then((size) => {
            if (size > limits.maxBytes && aborted === undefined) {
              aborted = new CloneLimitError(
                `Clone aborted: the repository exceeds the ${limits.maxBytes}-byte size cap ` +
                  `(reached ${size} bytes) and was killed mid-clone.`,
              );
              killTree();
            }
          })
          .catch(() => {
            // The directory is being rewritten underneath us; the next poll
            // (or the final check) settles it.
          })
          .finally(() => {
            measuring = false;
          });
      }, limits.sizePollMs);
      sizePoll.unref();
    }

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (sizePoll !== undefined) clearInterval(sizePoll);
    };

    const capture = (target: 'out' | 'err') => (chunk: Buffer) => {
      if (target === 'out') stdout = (stdout + chunk.toString()).slice(0, MAX_CAPTURED_OUTPUT);
      else stderr = (stderr + chunk.toString()).slice(0, MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on('data', capture('out'));
    child.stderr.on('data', capture('err'));

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      if (aborted !== undefined) {
        reject(aborted);
        return;
      }
      if (code !== 0) {
        reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim() || 'no output'}`));
        return;
      }
      // A repo can finish cloning between two polls; re-check once at the end
      // so "small until the last moment" is not a way through the cap.
      if (watchDir === undefined) {
        resolve(stdout);
        return;
      }
      void directorySizeBytes(watchDir).then((size) => {
        if (size > limits.maxBytes) {
          reject(
            new CloneLimitError(
              `Clone aborted: the repository exceeds the ${limits.maxBytes}-byte size cap (${size} bytes).`,
            ),
          );
        } else {
          resolve(stdout);
        }
      }, reject);
    });
  });
}

/**
 * Total size of the regular files under `dir`.
 *
 * Uses `Dirent`/`lstat`, which do not follow symlinks: a repo containing a
 * link to `/` must not turn the measurement into an unbounded walk of the
 * host filesystem. Entries that vanish mid-walk (git is still writing) are
 * skipped rather than throwing — an approximate measurement now beats an
 * exact one after the disk is full.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await lstat(full)).size;
        } catch {
          continue;
        }
      }
    }
  }

  return total;
}
