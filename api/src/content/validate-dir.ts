import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadCourseManifest, resolveLessonPath } from './manifest.ts';
import { parseLesson } from './parse.ts';
import { validateBlocks } from './validate.ts';

// ---------------------------------------------------------------------------
// The validate-only pipeline (design §8: "Validate-only mode is a first-class
// entry point, not a debug flag. The same code path runs from the admin UI,
// from a CLI against a local directory, and eventually as the Go validator
// in a content repo's CI").
//
// Lives in api/ (not tools/) so the admin import route (Phase 5) can call it
// directly: tools/ depends on @learn/api, never the other way around, and
// this function has to be reachable from both. tools/src/validate.ts
// re-exports this module unchanged, so the CLI's behaviour and its tests
// are untouched by the move.
// ---------------------------------------------------------------------------

export interface ValidateSummary {
  slug: string;
  moduleCount: number;
  lessonCount: number;
}

export interface ValidateResult {
  ok: boolean;
  /** Every problem found, each already formatted as `<file>:<line-or-pointer>: <message>` (or just `<file>: <message>`). */
  problems: string[];
  /**
   * The manifest's slug, when the manifest itself parsed — even if
   * individual lessons failed validation. Lets a caller (the admin import
   * route) record a `course_slug` on a failed `import_runs` row instead of
   * leaving that column null purely because the manifest happened to be
   * fine and a lesson wasn't. Absent only when `course.yaml` itself
   * couldn't be read or failed schema validation.
   */
  slug?: string;
  summary?: ValidateSummary;
}

/**
 * Runs the full validate-only pipeline against a local content directory.
 *
 * Unlike manifest.ts's `loadCourse` (which throws on the first problem, for
 * an importer running inside one transaction), this collects EVERY problem
 * before returning, because a human fixing a content repo wants the whole
 * list in one pass rather than one error per invocation.
 */
export async function validateCourseDir(dir: string): Promise<ValidateResult> {
  const problems: string[] = [];

  let manifest;
  try {
    manifest = await loadCourseManifest(dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: message.split('\n') };
  }

  let lessonCount = 0;
  for (const mod of manifest.modules) {
    for (const srcPath of mod.lessons) {
      lessonCount++;

      // A refused path (traversal, absolute, symlink — see resolveLessonPath)
      // is collected like any other problem rather than aborting the run: a
      // hostile manifest usually has more than one, and an author fixing a
      // merely-careless one wants to see all of them at once.
      let absPath: string;
      try {
        absPath = resolveLessonPath(dir, srcPath);
      } catch (err) {
        problems.push(`${err instanceof Error ? err.message : String(err)} (referenced by module "${mod.id}")`);
        continue;
      }

      if (!existsSync(absPath)) {
        problems.push(`${srcPath}: lesson file not found (referenced by module "${mod.id}")`);
        continue;
      }

      let markdown: string;
      try {
        markdown = await readFile(absPath, 'utf8');
      } catch (err) {
        problems.push(`${srcPath}: could not read file — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      let parsed;
      try {
        parsed = parseLesson(markdown);
      } catch (err) {
        problems.push(`${srcPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const blocksResult = validateBlocks(parsed.blocks);
      if (!blocksResult.valid) {
        for (const e of blocksResult.errors) {
          problems.push(`${srcPath}:${e.path}: ${e.message}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems, slug: manifest.slug };
  }

  return {
    ok: true,
    problems: [],
    slug: manifest.slug,
    summary: { slug: manifest.slug, moduleCount: manifest.modules.length, lessonCount },
  };
}
