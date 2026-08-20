import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The icon PNGs are committed binary assets (produced once by
 * `web/scripts/generate-pwa-icons.mjs`, design §14.1's "graphite tile,
 * yellow ring" badge language) rather than generated per-request, so what
 * needs testing is the checked-in files themselves: that they exist, are
 * genuinely PNGs, and are exactly the sizes iOS/Android require.
 */
const ICONS_DIR = path.join(import.meta.dirname, '..', '..', 'public', 'icons');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dimensions(file: string): { width: number; height: number } {
  const buf = readFileSync(path.join(ICONS_DIR, file));
  expect(buf.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA icons (plan Phase 14)', () => {
  it('apple-touch-icon is 180x180 — the size iOS actually requests', () => {
    expect(dimensions('icon-180.png')).toEqual({ width: 180, height: 180 });
  });

  it('has the two Android manifest sizes', () => {
    expect(dimensions('icon-192.png')).toEqual({ width: 192, height: 192 });
    expect(dimensions('icon-512.png')).toEqual({ width: 512, height: 512 });
  });

  it('has a maskable variant at 512x512', () => {
    expect(dimensions('icon-512-maskable.png')).toEqual({ width: 512, height: 512 });
  });
});
