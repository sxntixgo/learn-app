import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * `.env.example` DESCRIBES EVERY VARIABLE THIS PROJECT READS.
 *
 * CLAUDE.md makes it the contract for configuration: "`.env` is gitignored;
 * `.env.example` holds placeholders only." Nothing enforced that, and it
 * drifted — by 2026-08 the file was missing four variables, and the most
 * expensive one was AUTH_JWT_PRIVATE_KEY.
 *
 * That omission is worth being precise about, because it is the shape of
 * failure this test exists to prevent. Without that key the API mints a
 * throwaway Ed25519 keypair at boot: every session dies on restart, and a
 * second instance rejects the first one's tokens. The API says so loudly in
 * its log — but an operator who configured their deployment by copying
 * `.env.example`, which is the documented way to do it, was never told the
 * variable existed at all. The failure surfaces days later as "everyone gets
 * logged out whenever I redeploy".
 *
 * So this walks the source for `process.env` references and asserts each one
 * appears in `.env.example`. A variable added next year is in the file or
 * this test is red.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Variables that are deliberately NOT in `.env.example`, each with the reason
 * it would be noise there. An allowlist rather than a pattern: every entry is
 * a decision somebody made, and a new one should have to be argued for.
 */
const NOT_CONFIGURATION: ReadonlyMap<string, string> = new Map([
  ['PATH', 'the OS provides it'],
  ['NODE_ENV', 'set by the toolchain, never by an operator'],
  ['CI', 'set by the CI runner'],
  ['PORT', "Next's own convention; compose maps WEB_PORT onto it"],
  ['GIT_SSH_COMMAND', 'git plumbing with a safe default in clone.ts; only an operator using ssh remotes overrides it'],
  ['E2E_API_PORT', 'Playwright harness only, defaulted in playwright.config.ts'],
  ['E2E_WEB_PORT', 'Playwright harness only, defaulted in playwright.config.ts'],
  ['E2E_COURSE_SLUG', 'Playwright harness only'],
  ['E2E_SEED_ALLOW_NON_TEST_DB', 'a deliberate escape hatch for the seed safety guard, not a setting'],
  [
    'AUTH_JWT_PUBLIC_KEY',
    'optional and derived from the private half — documented in the AUTH_JWT_PRIVATE_KEY comment rather than as its own line',
  ],
]);

/** Source trees an operator's configuration can reach. */
const SOURCE_DIRS = ['api/src', 'tools/src', 'web/src', 'web/app'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const pending = [path.join(repoRoot, dir)];

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
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        pending.push(full);
        continue;
      }
      // Test files configure themselves; they are not an operator's concern.
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Every environment variable the source reads.
 *
 * Two spellings, because both are used: a direct `process.env.NAME`, and the
 * indirection `keys.ts` and `trust-proxy.ts` use, where the name lives in an
 * exported `X_ENV` constant so it can be named in an error message.
 */
async function referencedVariables(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const note = (name: string, file: string): void => {
    const rel = path.relative(repoRoot, file);
    const seen = found.get(name);
    if (seen) {
      if (!seen.includes(rel)) seen.push(rel);
    } else {
      found.set(name, [rel]);
    }
  };

  for (const dir of SOURCE_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const source = readFileSync(file, 'utf8');

      for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) note(m[1]!, file);
      for (const m of source.matchAll(/process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g)) note(m[1]!, file);
      // `export const PRIVATE_KEY_ENV = 'AUTH_JWT_PRIVATE_KEY';`
      for (const m of source.matchAll(/[A-Z_]+_ENV\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) note(m[1]!, file);
    }
  }
  return found;
}

function declaredInExample(): Set<string> {
  const text = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

describe('.env.example is the complete list of what this project reads', () => {
  it('found variables to check — otherwise everything below is vacuous', async () => {
    // Two empty sets agree perfectly. This is the guard against a scanner
    // that silently stopped matching.
    const referenced = await referencedVariables();
    expect(referenced.size, 'the scanner found no process.env references at all').toBeGreaterThan(5);
    expect(declaredInExample().size, 'parsed no variables out of .env.example').toBeGreaterThan(5);
  });

  it('documents every variable the source reads', async () => {
    const declared = declaredInExample();
    const missing = [...(await referencedVariables())]
      .filter(([name]) => !declared.has(name) && !NOT_CONFIGURATION.has(name))
      .map(([name, files]) => `${name} (read in ${files.join(', ')})`)
      .sort();

    expect(
      missing,
      'these are read from the environment but .env.example never mentions them, so an operator ' +
        'configuring a deployment by copying it will not know they exist',
    ).toEqual([]);
  });

  it('does not document variables nothing reads', async () => {
    // The opposite drift, and the one that wastes an operator's afternoon: a
    // line in the example that looks like a setting and does nothing.
    const referenced = await referencedVariables();

    // Read somewhere the scan above deliberately does not look. Each entry
    // says where, so "nothing reads this" stays a real finding rather than a
    // list that grows whenever the assertion is inconvenient.
    const readElsewhere: ReadonlyMap<string, string> = new Map([
      ['POSTGRES_USER', 'docker-compose.yml — configures the postgres image and builds DATABASE_URL'],
      ['POSTGRES_DB', 'docker-compose.yml'],
      ['POSTGRES_PASSWORD', 'docker-compose.yml'],
      ['WEB_PORT', 'docker-compose.yml — host port mapping only'],
      ['TEST_DATABASE_URL', 'test files and playwright.config.ts / vitest.setup.ts, all excluded from the scan'],
    ]);

    const orphans = [...declaredInExample()]
      .filter((name) => !referenced.has(name) && !readElsewhere.has(name))
      .sort();

    expect(orphans, 'declared in .env.example but nothing reads them').toEqual([]);
  });
});
