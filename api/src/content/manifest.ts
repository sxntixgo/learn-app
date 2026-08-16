import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseLesson } from './parse.ts';
import type { ParsedLesson } from './parse.ts';
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
    if (existsSync(candidate)) return candidate;
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

/**
 * Resolves a manifest `src` path (e.g. a `modules[].lessons[]` entry) to an
 * absolute filesystem path, relative to the course directory.
 *
 * ALL path resolution for manifest-referenced files must go through this
 * function — do not join `courseDir` and a manifest path anywhere else.
 *
 * Phase 5 hardens this exact function: manifest `src` paths are
 * attacker-controlled strings once content repos are cloned from arbitrary
 * URLs (design §8.1), so Phase 5 adds the traversal/symlink checks that
 * assert the resolved path stays inside `courseDir` and refuse symlinks.
 * None of that hardening is implemented here — Phase 2 only reads from
 * local, trusted directories — but centralising resolution now is what
 * makes that later hardening a one-function change instead of an audit of
 * every call site.
 */
export function resolveLessonPath(courseDir: string, srcPath: string): string {
  return path.resolve(courseDir, srcPath);
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
