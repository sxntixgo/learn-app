import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * GATE 6's LAST ITEM, as far as it can be reached from here.
 *
 * The gate asks for `docker compose up` to be confirmed working. Docker is
 * not available in this dev container (CLAUDE.md), so that confirmation has
 * to happen on the WSL host and this file cannot make it. What it can do is
 * check the things that are decidable from the files themselves — and the
 * reason it exists is that when those were finally checked, the stack turned
 * out never to have been built by anybody:
 *
 *  - `web.Dockerfile` did not copy `web/app`. That is the entire application.
 *    `next build` exits with "Couldn't find any `pages` or `app` directory",
 *    so the image could not be produced at all.
 *  - It also ran `npm ci --omit=dev`, without the typescript and @types the
 *    build type-checks with, and never passed NEXT_PUBLIC_API_BASE_URL at
 *    BUILD time — which is the only time it can matter, a fact this repo had
 *    already discovered and written down in playwright.config.ts.
 *  - `api.Dockerfile` did not copy `schemas/`, which api/src/content/
 *    validate.ts reads from disk at runtime. ENOENT on the first import.
 *  - The compose healthcheck for the API shelled out to `curl`, which is not
 *    in node:22-slim.
 *
 * None of that is exotic. All of it is invisible without either running
 * Docker or reading these files against the tree they describe, which is
 * what the assertions below do.
 *
 * A GREEN RUN HERE IS NOT A GREEN `docker compose up`. It means the stack no
 * longer contains the mistakes that can be found without one.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const webDockerfile = readFileSync(path.join(repoRoot, 'docker', 'web.Dockerfile'), 'utf8');
const apiDockerfile = readFileSync(path.join(repoRoot, 'docker', 'api.Dockerfile'), 'utf8');
const composeRaw = readFileSync(path.join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');

interface ComposeService {
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] | string };
  depends_on?: unknown;
}
const compose = parseYaml(composeRaw) as { version?: string; services: Record<string, ComposeService> };

/** Every path a Dockerfile COPYs from the build context. */
function copiedPaths(dockerfile: string): string[] {
  const paths: string[] = [];
  for (const match of dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(.+)$/gm)) {
    const parts = match[1]!.trim().split(/\s+/);
    // The last token is the destination; everything before it is a source.
    paths.push(...parts.slice(0, -1));
  }
  return paths;
}

/**
 * Directories directly under `web/` that hold source the build needs.
 *
 * From `git ls-files`, not from `readdir`. Reading the directory picks up
 * whatever happens to be lying in the working tree — a stray `web/test-results`
 * from a Playwright run started in the wrong directory made this fail once,
 * demanding that the Dockerfile copy a folder of screenshots. Tracked files
 * are what a build context is built from and what a clean checkout contains.
 */
function webSourceDirectories(): string[] {
  const tracked = execFileSync('git', ['ls-files', 'web'], { cwd: repoRoot, encoding: 'utf8' });
  const dirs = new Set<string>();
  for (const file of tracked.split('\n')) {
    const segments = file.split('/');
    // web/<dir>/<something> — a top-level directory with content in it.
    if (segments.length > 2 && segments[0] === 'web') dirs.add(segments[1]!);
  }
  // `scripts/` is a build-time helper run by hand (PWA icon generation), not
  // something `next build` reads.
  dirs.delete('scripts');
  return [...dirs];
}

describe('web.Dockerfile copies the application it claims to build', () => {
  /**
   * DERIVED FROM THE TREE, not from a list written here. A new top-level
   * directory under web/ — the way `app/` itself once was — fails this
   * without anyone remembering to update it. That is the whole point: the
   * missing `web/app` was not an oversight anyone could have caught by
   * reading the Dockerfile, only by comparing it to the repository.
   */
  it('copies every source directory under web/', () => {
    const copied = copiedPaths(webDockerfile);
    for (const dir of webSourceDirectories()) {
      expect(
        copied.some((p) => p === `web/${dir}` || p.startsWith(`web/${dir}/`)),
        `web.Dockerfile never copies web/${dir}`,
      ).toBe(true);
    }
  });

  it('copies the root-level files the App Router build needs', () => {
    const copied = copiedPaths(webDockerfile);
    // proxy.ts is the CSP middleware; without it the built app serves no
    // security headers at all and the failure is silent.
    for (const file of ['web/proxy.ts', 'web/next.config.ts', 'web/tsconfig.json', 'tsconfig.base.json']) {
      expect(copied, `web.Dockerfile never copies ${file}`).toContain(file);
    }
  });

  it('installs dev dependencies, because next build type-checks', () => {
    const install = webDockerfile.match(/^RUN npm ci.*$/m)?.[0];
    expect(install, 'no npm ci in web.Dockerfile').toBeDefined();
    expect(install, 'typescript and @types/* are devDependencies').not.toContain('--omit=dev');
  });

  it('takes NEXT_PUBLIC_API_BASE_URL as a build ARG, before the build runs', () => {
    // The one that cannot be fixed at runtime. Next inlines NEXT_PUBLIC_* at
    // build time, so a value supplied only to the running container is
    // ignored and every page fails.
    const argIndex = webDockerfile.indexOf('ARG NEXT_PUBLIC_API_BASE_URL');
    const buildIndex = webDockerfile.indexOf('RUN npm run build');
    expect(argIndex, 'NEXT_PUBLIC_API_BASE_URL is not a build ARG').toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(argIndex, 'the ARG is declared after the build that needs it').toBeLessThan(buildIndex);
    expect(webDockerfile).toMatch(/ENV NEXT_PUBLIC_API_BASE_URL=\$\{NEXT_PUBLIC_API_BASE_URL\}/);
  });
});

describe('api.Dockerfile ships what the API reads at runtime', () => {
  it('copies the schemas directory into BOTH stages', () => {
    // api/src/content/validate.ts resolves `../../../schemas` from its own
    // location and reads the JSON off disk at module load.
    const validate = readFileSync(path.join(repoRoot, 'api', 'src', 'content', 'validate.ts'), 'utf8');
    expect(validate, 'validate.ts no longer reads schemas from disk; this test needs revisiting').toContain(
      "'../../../schemas'",
    );

    expect(copiedPaths(apiDockerfile)).toContain('schemas/');
    expect(apiDockerfile, 'the runtime stage never receives schemas/').toMatch(
      /COPY --from=builder[^\n]*\/app\/schemas \.\/schemas/,
    );
  });

  it('copies the migrations, which the migrate service runs', () => {
    expect(copiedPaths(apiDockerfile)).toContain('db/');
    expect(apiDockerfile).toMatch(/COPY --from=builder[^\n]*\/app\/db \.\/db/);
  });
});

describe('docker-compose.yml', () => {
  it('never hands DATABASE_URL to web — CLAUDE.md rule 1', () => {
    // Checked against the parsed service AND against the raw text, because
    // the rule is absolute and a `env_file:` or an anchor could reintroduce
    // it in a form the parsed `environment` map would not show.
    const web = compose.services.web!;
    expect(Object.keys(web.environment ?? {})).not.toContain('DATABASE_URL');
    expect(Object.keys(web.build?.args ?? {})).not.toContain('DATABASE_URL');

    const webBlock = composeRaw.slice(composeRaw.indexOf('\n  web:'));
    expect(webBlock, 'DATABASE_URL appears somewhere in the web service block').not.toContain('DATABASE_URL');
  });

  it('passes NEXT_PUBLIC_API_BASE_URL to the web BUILD, not only to the container', () => {
    expect(Object.keys(compose.services.web!.build?.args ?? {})).toContain('NEXT_PUBLIC_API_BASE_URL');
  });

  it('has no healthcheck that shells out to a binary the image does not have', () => {
    // node:22-slim carries neither curl nor wget. A healthcheck using one can
    // only ever report unhealthy, which is worse than having none: it looks
    // like the service is broken.
    for (const [name, service] of Object.entries(compose.services)) {
      const test = service.healthcheck?.test;
      if (!test) continue;
      const command = Array.isArray(test) ? test.join(' ') : test;
      const usesNodeImage = service.build?.dockerfile?.includes('api.Dockerfile') || name === 'web';
      if (!usesNodeImage) continue;
      expect(command, `${name}'s healthcheck uses a binary node:22-slim does not ship`).not.toMatch(/\b(curl|wget)\b/);
    }
  });

  it('declares no obsolete top-level version key', () => {
    expect(compose.version, 'Compose v2 ignores `version:` and warns about it').toBeUndefined();
  });

  it('builds every service from a Dockerfile that exists', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (!service.build) continue;
      const dockerfile = path.resolve(repoRoot, 'docker', service.build.dockerfile!.replace(/^docker\//, ''));
      expect(() => statSync(dockerfile), `${name} points at a missing ${service.build!.dockerfile}`).not.toThrow();
    }
  });
});
