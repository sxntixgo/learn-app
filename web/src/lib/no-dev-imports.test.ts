import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

/**
 * NO SHIPPED FILE MAY IMPORT A DEV-ONLY MODULE.
 *
 * `next build` type-checks everything under `web/` that is not a test file,
 * and the web image installs with `npm ci --workspace=web` — so a root
 * devDependency like vitest simply does not exist there. Importing one from a
 * file without `.test.` in its name builds fine locally, passes CI, and then
 * fails `docker compose up --build` with `Cannot find module 'vitest'`.
 *
 * THAT IS NOT HYPOTHETICAL. `mix-contrast.ts` did exactly this: extracted from
 * a test file, it kept `import { expect } from 'vitest'` and reached `main`
 * through a green suite and two green CI jobs before the deployment build
 * caught it. CLAUDE.md says it plainly — "a green test there is not a green
 * `docker compose up`" — and nothing enforced it until now.
 *
 * The fix in that case was to take `expect` as a parameter, the way
 * `assertFloors` already took `describe` and `it`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/** Modules that exist only in the dev tree, so may appear only in test files. */
const DEV_ONLY = ['vitest', '@playwright/test', '@axe-core/playwright'];

function shippedWebSources(): string[] {
  // git, not a filesystem walk: it skips node_modules and build output for
  // free, and only tracked files can reach the Docker build context anyway.
  const out = execFileSync('git', ['ls-files', 'web/src', 'web/app'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !f.includes('.test.'));
}

describe('shipped web sources never import a dev-only module', () => {
  const files = shippedWebSources();

  it('finds a realistic number of files to check', () => {
    // Vacuity guard: if `git ls-files` stops matching, the assertion below
    // passes by checking nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} imports nothing dev-only`, () => {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const module of DEV_ONLY) {
        // Real import statements only. A line starting with `*` or `//` is a
        // comment — this file's own header names vitest several times, and so
        // does mix-contrast.ts explaining why it must not import it.
        const pattern = new RegExp(`^\\s*(?:import|export)\\s[^\\n]*from\\s+['"]${module.replace('/', '\\/')}['"]`, 'm');
        expect(
          pattern.test(source),
          `${file} imports "${module}", which is absent from the web image (npm ci --workspace=web)`,
        ).toBe(false);
      }
    });
  }
});
