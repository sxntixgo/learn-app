import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Guards the one thing about docker/web.Dockerfile that cannot be checked by
 * running it: Docker is not available in this dev container (CLAUDE.md), so
 * these files are authored here and verified on the WSL host. That gap is
 * exactly how the entry point came to be wrong.
 *
 * `web/next.config.ts` sets `output: 'standalone'`. In a WORKSPACE build,
 * Next preserves the workspace layout inside the standalone bundle, so the
 * server lands at `.next/standalone/web/server.js` — not at the bundle root.
 * The Dockerfile's COPY lines already knew this (they target `./web/public`
 * and `./web/.next/static`); only the CMD disagreed, and it would have failed
 * at container start with MODULE_NOT_FOUND.
 *
 * It went unnoticed because `web/public/` was not a tracked directory until
 * Phase 14 added the PWA icons, so nothing had ever forced this path to be
 * exercised.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const dockerfile = readFileSync(path.join(repoRoot, 'docker', 'web.Dockerfile'), 'utf8');
const nextConfig = readFileSync(path.join(repoRoot, 'web', 'next.config.ts'), 'utf8');

describe('docker/web.Dockerfile agrees with the shape next build actually produces', () => {
  it('still builds in standalone mode — the premise of everything below', () => {
    expect(nextConfig).toMatch(/output:\s*'standalone'/);
  });

  it('starts the server at its workspace-nested path, not the bundle root', () => {
    const cmd = dockerfile.match(/^CMD \[(.+)\]$/m)?.[1];
    expect(cmd, 'web.Dockerfile should end with a CMD').toBeDefined();
    expect(cmd).toContain('"web/server.js"');
    expect(cmd).not.toMatch(/"server\.js"/);
  });

  it('copies public/ and .next/static alongside that server, not beside the bundle root', () => {
    expect(dockerfile).toMatch(/COPY --from=builder \S+\/web\/public \.\/web\/public/);
    expect(dockerfile).toMatch(/COPY --from=builder \S+\/web\/\.next\/static \.\/web\/\.next\/static/);
  });

  it('matches the real build output when there is one to check against', () => {
    // Only meaningful after `next build` has run in this working tree, which
    // is not guaranteed during `npm test`. When it has, this stops being a
    // static string check and becomes a fact about the actual bundle.
    const standalone = path.join(repoRoot, 'web', '.next', 'standalone');
    if (!existsSync(standalone)) return;

    expect(
      existsSync(path.join(standalone, 'web', 'server.js')),
      'next build put server.js somewhere other than standalone/web/server.js — the Dockerfile CMD needs to follow it',
    ).toBe(true);
  });
});
