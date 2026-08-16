import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCourseManifest, resolveLessonPath } from '@learn/api/content/manifest';
import { parseLesson } from '@learn/api/content/parse';
import { validateBlocks } from '@learn/api/content/validate';

export interface ValidateSummary {
  slug: string;
  moduleCount: number;
  lessonCount: number;
}

export interface ValidateResult {
  ok: boolean;
  /** Every problem found, each already formatted as `<file>:<line-or-pointer>: <message>` (or just `<file>: <message>`). */
  problems: string[];
  summary?: ValidateSummary;
}

/**
 * Runs the full validate-only pipeline against a local content directory
 * (design §8: "Validate-only mode is a first-class entry point... The same
 * code path runs from the admin UI, from a CLI against a local directory,
 * and eventually as the Go validator in a content repo's CI").
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
      const absPath = resolveLessonPath(dir, srcPath);

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
    return { ok: false, problems };
  }

  return {
    ok: true,
    problems: [],
    summary: { slug: manifest.slug, moduleCount: manifest.modules.length, lessonCount },
  };
}

async function main(): Promise<void> {
  const dirArg = process.argv[2];
  if (!dirArg) {
    console.error('Usage: npm run validate -- <dir>');
    process.exitCode = 1;
    return;
  }

  const dir = path.resolve(dirArg);
  const result = await validateCourseDir(dir);

  if (!result.ok) {
    for (const problem of result.problems) {
      console.error(problem);
    }
    process.exitCode = 1;
    return;
  }

  const { slug, moduleCount, lessonCount } = result.summary!;
  console.log(`${slug}: OK — ${moduleCount} module(s), ${lessonCount} lesson(s)`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
