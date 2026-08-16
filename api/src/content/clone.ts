import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Cloning a content repo (design §8): the first stage of the import pipeline,
// upstream of loadCourse/importCourse. This module is deliberately git-only
// and DB-free — it knows nothing about content_repos or import_runs, so the
// same clone can be reused from a CLI, an admin API route, or a future CI
// validator with no change here (mirrors the loadCourse/importCourse split
// in manifest.ts and import.ts).
// ---------------------------------------------------------------------------

const DEFAULT_REF = 'main';

/** Prefix for every temp directory this module creates — lets tests and
 * operators recognise a leaked clone directory at a glance. */
const TEMP_PREFIX = 'learn-clone-';

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
 * // Phase 5 hardening: opus covers, right here, the URL scheme allowlist
 * // (design §8.1 — "a URL scheme allowlist so a repo URL cannot become
 * // file:///etc"), a clone size cap, and a clone timeout. None of that is
 * // implemented yet: `url` and `opts.ref` are trusted completely. That is
 * // acceptable only because the app is LAN-only until Gate 6 — this is not
 * // safe to expose to untrusted callers as-is.
 */
export async function cloneCourseRepo(url: string, opts: CloneOptions = {}): Promise<ClonedRepo> {
  const explicitRef = opts.ref;
  let dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));

  try {
    try {
      await gitCloneBranch(url, explicitRef ?? DEFAULT_REF, dir);
    } catch (err) {
      if (explicitRef !== undefined) throw err;

      // Sensible fallback: the repo's actual default branch isn't literally
      // named "main" (e.g. "master", or a renamed default). Re-clone into a
      // clean directory with no --branch at all, so git resolves whatever
      // HEAD actually points at instead of us guessing a second name.
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
      await gitCloneDefault(url, dir);
    }

    const commit = await resolveHeadSha(dir);
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

// execFile with an argument array — never a shell — so nothing in `url` or
// `ref` is ever interpreted as shell syntax. `--` separates options from the
// repository argument so a URL cannot be parsed as a flag.
//
// Phase 5 hardening: opus adds a timeout (and, alongside it, a size cap) to
// both of the execFile calls below — a clone against a slow or malicious
// remote currently blocks until git itself gives up.

async function gitCloneBranch(url: string, ref: string, dest: string): Promise<void> {
  await execFileAsync('git', ['clone', '--quiet', '--depth', '1', '--branch', ref, '--single-branch', '--', url, dest]);
}

async function gitCloneDefault(url: string, dest: string): Promise<void> {
  await execFileAsync('git', ['clone', '--quiet', '--depth', '1', '--', url, dest]);
}

async function resolveHeadSha(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}
