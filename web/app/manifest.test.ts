import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import manifest from './manifest';

/**
 * No actor/session is passed to `manifest()` at all (see app/manifest.ts's
 * module comment) — there is structurally nothing here that could require
 * authentication, which is what "200s anonymously" reduces to for this
 * file. The live-request proof (curl with no cookie) is the Phase 14
 * verification step; this test is the shape/content contract.
 */
describe('PWA web app manifest (design decision #6, plan Phase 14)', () => {
  const result = manifest();

  it('is valid JSON', () => {
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it('has the fields required for Add to Home Screen', () => {
    expect(result.name).toBe('Learn App');
    expect(result.short_name).toBe('Learn');
    expect(result.start_url).toBe('/');
    expect(result.display).toBe('standalone');
    expect(result.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('declares icons at the sizes iOS and Android actually use, including a maskable one', () => {
    const icons = result.icons ?? [];
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    const maskable = icons.find((icon) => icon.purpose === 'maskable');
    expect(maskable).toBeDefined();
    expect(maskable?.sizes).toBe('512x512');
  });

  it('every declared icon file actually exists in web/public', () => {
    const icons = result.icons ?? [];
    for (const icon of icons) {
      const filePath = path.join(import.meta.dirname, '..', 'public', icon.src ?? '');
      expect(existsSync(filePath), `${icon.src} should exist under web/public`).toBe(true);
    }
  });

  it('does not regress to a non-standalone display mode', () => {
    expect(result.display).not.toBe('browser');
  });
});
