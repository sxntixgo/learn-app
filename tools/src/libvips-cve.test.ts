import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * The Phase 12 blocker, turned into a test.
 *
 * `sharp` ships as an optional dependency of Next and re-encodes images
 * through libvips. Four memory-safety bugs in libvips' GIF, TIFF and VIPS
 * loaders (CVE-2026-33327 / 33328 / 35590 / 35591, GHSA-f88m-g3jw-g9cj) are
 * reachable by anyone who can hand the loader bytes. That was tolerable while
 * nothing untrusted reached it; an avatar upload pipeline is precisely
 * untrusted image bytes, and the design's "always re-encode" rule routes
 * every one of them through libvips on purpose.
 *
 * Two packages are checked, not one:
 *
 *  - `sharp` itself, patched in 0.35.0.
 *  - `@img/sharp-libvips-*`, the prebuilt binaries that ARE libvips. This is
 *    where the vulnerable code actually lives (1.2.4 carries libvips 8.18.0;
 *    1.3.x carries 8.18.3), and it is installed per-platform. Checking only
 *    `sharp` would pass while a pinned or overridden binary package kept the
 *    vulnerable library on disk — the version that matters is not the one in
 *    the name of the package you install.
 *
 * The lockfile is the subject rather than `node_modules`, because the
 * lockfile is what CI and the Docker build resolve from, and it records every
 * platform's binary rather than just this machine's.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

interface Lockfile {
  packages: Record<string, { version?: string }>;
}

const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as Lockfile;

/** Parses "1.2.4" into a comparable tuple. Pre-release suffixes sort low. */
function order(version: string): [number, number, number, number] {
  const [core, pre] = version.split('-', 2);
  const [major = 0, minor = 0, patch = 0] = (core ?? '').split('.').map(Number);
  return [major, minor, patch, pre === undefined ? 1 : 0];
}

function atLeast(version: string, floor: string): boolean {
  const a = order(version);
  const b = order(floor);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

function installed(match: (name: string) => boolean): { path: string; version: string }[] {
  return Object.entries(lock.packages)
    .filter(([key, meta]) => {
      const name = key.split('node_modules/').pop();
      return key !== '' && name !== undefined && meta.version !== undefined && match(name);
    })
    .map(([key, meta]) => ({ path: key, version: meta.version! }));
}

describe('libvips is not the vulnerable line (GHSA-f88m-g3jw-g9cj)', () => {
  it('finds sharp in the tree at all — otherwise every assertion below is vacuous', () => {
    expect(installed((n) => n === 'sharp').length).toBeGreaterThan(0);
  });

  it('resolves every sharp to 0.35.0 or newer', () => {
    for (const { path: where, version } of installed((n) => n === 'sharp')) {
      expect(atLeast(version, '0.35.0'), `${where} is sharp ${version}`).toBe(true);
    }
  });

  it('finds the prebuilt libvips binaries — the packages that carry the CVEs', () => {
    expect(installed((n) => n.startsWith('@img/sharp-libvips-')).length).toBeGreaterThan(0);
  });

  it('resolves every @img/sharp-libvips-* to 1.3.0 or newer', () => {
    for (const { path: where, version } of installed((n) => n.startsWith('@img/sharp-libvips-'))) {
      expect(atLeast(version, '1.3.0'), `${where} is ${version}, which bundles libvips 8.18.0`).toBe(true);
    }
  });
});

describe('the version comparison itself', () => {
  // Without these, `atLeast` returning a constant `true` would leave every
  // assertion above green while the vulnerable library sat in the tree.
  it('orders by each component, not lexically', () => {
    expect(atLeast('0.35.0', '0.35.0')).toBe(true);
    expect(atLeast('0.34.5', '0.35.0')).toBe(false);
    expect(atLeast('0.9.0', '0.35.0')).toBe(false); // lexically "0.9" > "0.35"
    expect(atLeast('1.2.4', '1.3.0')).toBe(false);
    expect(atLeast('1.3.2', '1.3.0')).toBe(true);
    expect(atLeast('2.0.0', '1.3.0')).toBe(true);
  });

  it('treats a pre-release as older than its release', () => {
    expect(atLeast('0.35.0-rc.1', '0.35.0')).toBe(false);
  });
});
