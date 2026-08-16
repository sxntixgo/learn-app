import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCourseDir } from '@learn/api/content/validate-dir';
import type { ValidateResult, ValidateSummary } from '@learn/api/content/validate-dir';

// The validate-only pipeline itself lives in api/src/content/validate-dir.ts
// (design §8: "the same code path runs from the admin UI, from a CLI
// against a local directory, and eventually as the Go validator") — this
// file is now just the CLI wrapper around it, kept here (rather than moved
// wholesale) so `npm run validate -- <dir>` keeps working unchanged and so
// callers importing `./validate.ts` from within tools/ (scaffold.test.ts,
// hostile-fixture.test.ts) don't need to change either.
export { validateCourseDir };
export type { ValidateResult, ValidateSummary };

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
