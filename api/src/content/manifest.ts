import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseChartCsv } from './csv.ts';
import { parseLesson } from './parse.ts';
import type { Block, ParsedLesson } from './parse.ts';
import { validateCourseManifest } from './validate.ts';

// Types below mirror schemas/course.schema.json (design §6.1). That JSON
// Schema is the real contract — these types describe the shape once it has
// already passed validateCourseManifest, not a second source of truth.

export type Hue = 'blue' | 'teal' | 'ochre' | 'maroon' | 'slate';

export interface TrackDef {
  id: string;
  name: string;
  hue: Hue;
  blurb?: string;
}

export interface ModuleDef {
  id: string;
  title: string;
  /** Repo-relative paths, in presentation order (design §6.1). Resolve each through resolveLessonPath. */
  lessons: string[];
}

export interface CourseManifest {
  schema: 1;
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  tracks?: TrackDef[];
  tags?: string[];
  modules: ModuleDef[];
}

const MANIFEST_FILENAMES = ['course.yaml', 'course.yml'];

async function findManifestFile(dir: string): Promise<string> {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) continue;

    // The manifest is the one file read before resolveLessonPath exists to
    // protect anything, so it gets the same rule directly: a `course.yaml`
    // that is a symlink to `/etc/shadow` would be read, fail to parse, and
    // then quote the file it could not parse back at the operator.
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`${name} is a symbolic link — refusing to read it (content repos may not contain symlinks).`);
    }
    return candidate;
  }
  throw new Error(
    `No course manifest found in ${dir} (expected one of: ${MANIFEST_FILENAMES.join(', ')}).`,
  );
}

/**
 * Reads and validates a directory's `course.yaml` (or `course.yml`).
 *
 * Error quality is a deliverable, not a nicety (design §8: "Error quality is
 * the authoring experience"). On an invalid manifest this throws a single
 * Error whose message has one line per problem, each line naming both the
 * manifest's file name and the JSON-Pointer path to the offending field —
 * e.g. `course.yaml:/tracks/0/hue: must be equal to one of the allowed values`.
 */
export async function loadCourseManifest(dir: string): Promise<CourseManifest> {
  const file = await findManifestFile(dir);
  const fileName = path.basename(file);
  const raw = await readFile(file, 'utf8');

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`${fileName}: could not parse YAML — ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateCourseManifest(parsed);
  if (!result.valid) {
    const lines = result.errors.map((e) => `${fileName}:${e.path}: ${e.message}`);
    throw new Error(lines.join('\n'));
  }

  return parsed as CourseManifest;
}

// ---------------------------------------------------------------------------
// Path resolution — the single chokepoint (design §8.1: "Path traversal is
// the real vulnerability here").
//
// Every string below arrives from a `course.yaml` inside a repository cloned
// from a URL someone else controls. The importer runs with the application's
// filesystem access, so a manifest entry of `../../../../etc/passwd` is a
// request to read that file and store its contents in a lesson row that
// students can then read back over HTTP. Four independent checks, in order:
//
//   1. Lexical: no absolute paths, no `..` segments, no NUL bytes.
//   2. Containment: the resolved path is strictly inside the real course
//      directory — compared with `path.relative`, never with `startsWith`,
//      which cannot tell `/tmp/clone-evil` from inside `/tmp/clone`.
//   3. No symlinks on ANY segment below the course directory, checked with
//      `lstat` on each component — a symlinked intermediate directory
//      escapes just as effectively as a symlinked file, and only the final
//      component is visible to a naive check.
//   4. Containment again, this time on the fully resolved real path. (2) and
//      (3) should make this unreachable; it is here because "should" is not
//      a security property and this check costs one syscall.
// ---------------------------------------------------------------------------

/** `C:\…`, `C:/…` or a UNC `\\server\share` — absolute on Windows, and NOT
 * caught by `path.isAbsolute` when the importer itself runs on POSIX. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/][\\/])/;

/** Splits on both separators: `modules\..\..\etc` must be seen as traversal
 * even though `\` is a legal filename character on POSIX. */
const PATH_SEPARATORS = /[\\/]+/;

function rejectPath(srcPath: string, reason: string): Error {
  // Names the offending manifest entry exactly as written (that is what the
  // author has to go and fix) and never echoes the resolved absolute path,
  // which would turn a rejection message into a filesystem-layout oracle.
  return new Error(`${srcPath}: ${reason}`);
}

/** True when `candidate` is strictly below `root` (never equal to it). */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `realpathSync`, or undefined if the path does not exist yet. Any other
 * error (permissions, symlink loop) is a real failure and propagates. */
function realpathIfExists(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Walks every path component below `root` and refuses the first symlink.
 *
 * Stops at the first component that does not exist: a path that cannot be
 * read is the caller's error to report ("lesson file not found"), with a far
 * better message than anything this function could produce.
 */
function assertNoSymlinkedSegment(root: string, candidate: string, srcPath: string): void {
  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);

    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    if (stat.isSymbolicLink()) {
      throw rejectPath(
        srcPath,
        `"${segments.slice(0, index + 1).join('/')}" is a symbolic link — symlinks are refused inside a content repo, ` +
          `whether they point inside it or out of it.`,
      );
    }

    const isLast = index === segments.length - 1;
    if (isLast && !stat.isFile() && !stat.isDirectory()) {
      // A FIFO or device node would make `readFile` block forever or read
      // unbounded data. Git cannot store one, but a course directory
      // imported from local disk is not necessarily a git checkout.
      throw rejectPath(srcPath, 'is not a regular file — refused.');
    }
  }
}

/**
 * Resolves a manifest `src` path (e.g. a `modules[].lessons[]` entry) to an
 * absolute filesystem path inside the course directory, or throws.
 *
 * ALL path resolution for manifest-referenced files must go through this
 * function — do not join `courseDir` and a manifest path anywhere else.
 * Phase 2 created it as the single chokepoint precisely so this hardening
 * would be one function rather than an audit of every call site.
 *
 * Throwing rather than returning a result object is deliberate: every caller
 * must handle a refusal, and a `string` that might be a traversal is exactly
 * the value that gets used by accident.
 */
export function resolveLessonPath(courseDir: string, srcPath: string): string {
  if (typeof srcPath !== 'string' || srcPath.trim() === '') {
    throw rejectPath(JSON.stringify(srcPath), 'is not a usable path — manifest paths must be non-empty strings.');
  }
  if (srcPath.includes('\0')) {
    throw rejectPath(JSON.stringify(srcPath), 'contains a NUL byte — refused.');
  }
  if (path.isAbsolute(srcPath) || WINDOWS_ABSOLUTE.test(srcPath)) {
    throw rejectPath(srcPath, 'is an absolute path — manifest paths must be relative to the course directory.');
  }
  if (srcPath.split(PATH_SEPARATORS).includes('..')) {
    throw rejectPath(srcPath, 'contains a ".." segment — a lesson path may not climb out of the course directory.');
  }

  // Resolve the ROOT through symlinks first, so a course directory that is
  // itself reached via a symlink (a clone under a symlinked /tmp, say) does
  // not make every path inside it look like an escape. A root that does not
  // exist cannot be traversed out of, so lexical resolution is enough there.
  const root = realpathIfExists(path.resolve(courseDir)) ?? path.resolve(courseDir);
  const candidate = path.resolve(root, srcPath);

  if (!isInside(root, candidate)) {
    throw rejectPath(srcPath, 'resolves outside the course directory — refused.');
  }

  assertNoSymlinkedSegment(root, candidate, srcPath);

  const real = realpathIfExists(candidate);
  if (real !== undefined && !isInside(root, real)) {
    throw rejectPath(srcPath, 'resolves outside the course directory — refused.');
  }

  return candidate;
}

// ---------------------------------------------------------------------------
// Chart CSV sidecars (design §6.3, Task C).
//
// parse.ts has no filesystem access, so a chart block's `data: ./x.csv`
// leaves parseLesson as a raw, unresolved string (see ChartBlock's doc
// comment). This is the ONE place that string is ever turned into rows: it
// runs on every lesson right after parseLesson, before that lesson's blocks
// reach validateBlocks (schemas/blocks.schema.json expects the final array
// form — see its own top-level description) or the database.
//
// The sidecar path is resolved through `resolveLessonPath` — the SAME
// chokepoint every other manifest-referenced path goes through — so path
// traversal and symlink defenses (design §8.1) apply for free; this
// function does not open a second way to reach a file.
// ---------------------------------------------------------------------------

function isChartBlockWithUnresolvedData(block: Block): block is Block & { type: 'chart'; data: string } {
  return block.type === 'chart' && typeof block.data === 'string';
}

/**
 * Resolves every `chart` block's CSV sidecar reference in `blocks` into
 * inline {label, value} rows, relative to the LESSON's own directory (not
 * the course root) — `data: ./enrollment.csv` in a lesson at
 * `modules/01-intro/lesson.md` means `modules/01-intro/enrollment.csv`.
 * Blocks with inline `data` (already an array) pass through unchanged.
 *
 * Throws a message naming the sidecar path exactly as the author wrote it,
 * for a path that is refused (traversal/symlink/absolute — resolveLessonPath),
 * missing, or malformed CSV — design §8's "every failure names ... the
 * expectation". The caller (loadCourse, validateCourseDir) prefixes the
 * lesson's own srcPath, matching how a parseLesson failure is already
 * reported.
 */
export async function resolveChartSidecars(courseDir: string, lessonSrcPath: string, blocks: Block[]): Promise<Block[]> {
  const lessonDir = path.dirname(lessonSrcPath);

  const resolved: Block[] = [];
  for (const block of blocks) {
    if (!isChartBlockWithUnresolvedData(block)) {
      resolved.push(block);
      continue;
    }

    const sidecarPath = block.data;
    // path.join normalizes ".." segments against lessonDir, so a sidecar
    // that stays inside the course directory never trips resolveLessonPath's
    // literal ".." check even when it climbs out of the LESSON's own
    // directory (e.g. "../shared/x.csv" reaching a sibling module) — only a
    // sidecar that actually escapes the course root still has a literal
    // ".." left after normalization, and resolveLessonPath refuses that.
    const manifestRelativePath = path.join(lessonDir, sidecarPath);

    let absPath: string;
    try {
      absPath = resolveLessonPath(courseDir, manifestRelativePath);
    } catch (err) {
      throw new Error(`${sidecarPath}: chart data sidecar ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!existsSync(absPath)) {
      throw new Error(`${sidecarPath}: chart data sidecar not found (resolved to ${manifestRelativePath}).`);
    }

    let csvText: string;
    try {
      csvText = await readFile(absPath, 'utf8');
    } catch (err) {
      throw new Error(
        `${sidecarPath}: chart data sidecar could not be read — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let rows;
    try {
      rows = parseChartCsv(csvText);
    } catch (err) {
      throw new Error(`${sidecarPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    resolved.push({ ...block, data: rows });
  }

  return resolved;
}

export interface LoadedLesson extends ParsedLesson {
  /** The manifest-relative source path this lesson was loaded from. */
  srcPath: string;
}

export interface LoadedModule {
  id: string;
  title: string;
  lessons: LoadedLesson[];
}

export interface LoadedCourse {
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  tags?: string[];
  tracks: TrackDef[];
  modules: LoadedModule[];
}

/**
 * Loads a course directory end to end: validates the manifest, then reads
 * and parses every lesson it references, in manifest order.
 *
 * This does NOT touch the database and does NOT validate lesson blocks
 * against schemas/blocks.schema.json — see tools/src/validate.ts for the
 * full validate-only pipeline (design §8) that also does that and collects
 * every problem rather than throwing on the first one. This function is the
 * "happy path" loader a future importer builds on: it throws on the first
 * problem it finds, since an importer runs the whole thing in one
 * transaction and a single failure should abort the import (design §8:
 * "One transaction per course. A failed import leaves the previous version
 * fully intact").
 */
export async function loadCourse(dir: string): Promise<LoadedCourse> {
  const manifest = await loadCourseManifest(dir);

  const modules: LoadedModule[] = [];
  for (const mod of manifest.modules) {
    const lessons: LoadedLesson[] = [];
    for (const srcPath of mod.lessons) {
      const absPath = resolveLessonPath(dir, srcPath);

      let markdown: string;
      try {
        markdown = await readFile(absPath, 'utf8');
      } catch (err) {
        throw new Error(
          `${srcPath}: lesson file could not be read (module "${mod.id}", resolved to ${absPath}) — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      let parsed: ParsedLesson;
      try {
        parsed = parseLesson(markdown);
      } catch (err) {
        throw new Error(`${srcPath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        parsed = { ...parsed, blocks: await resolveChartSidecars(dir, srcPath, parsed.blocks) };
      } catch (err) {
        throw new Error(`${srcPath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      lessons.push({ ...parsed, srcPath });
    }
    modules.push({ id: mod.id, title: mod.title, lessons });
  }

  return {
    slug: manifest.slug,
    title: manifest.title,
    subtitle: manifest.subtitle,
    description: manifest.description,
    tags: manifest.tags,
    tracks: manifest.tracks ?? [],
    modules,
  };
}
