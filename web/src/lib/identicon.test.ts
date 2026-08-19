import { describe, it, expect } from 'vitest';
import { IDENTICON_COLORS, IDENTICON_SIZE, identiconCells, identiconColor } from './identicon';

const SEED = 'a3f19b2c4d5e6f70';
const OTHER = '00112233445566ff';

describe('identiconCells', () => {
  it('is deterministic — the same seed always draws the same face', () => {
    expect(identiconCells(SEED)).toEqual(identiconCells(SEED));
  });

  it('draws a different face for a different seed', () => {
    expect(identiconCells(SEED)).not.toEqual(identiconCells(OTHER));
  });

  it('is a full grid of booleans', () => {
    const cells = identiconCells(SEED);
    expect(cells).toHaveLength(IDENTICON_SIZE * IDENTICON_SIZE);
    expect(cells.every((cell) => typeof cell === 'boolean')).toBe(true);
  });

  it('is mirrored down the middle, which is what makes it read as a face', () => {
    const cells = identiconCells(SEED);
    for (let row = 0; row < IDENTICON_SIZE; row += 1) {
      for (let col = 0; col < IDENTICON_SIZE; col += 1) {
        const mirrored = IDENTICON_SIZE - 1 - col;
        expect(cells[row * IDENTICON_SIZE + col]).toBe(cells[row * IDENTICON_SIZE + mirrored]);
      }
    }
  });

  it('is never blank and never solid — an all-on or all-off face is not an avatar', () => {
    for (const seed of [SEED, OTHER, '', 'zzzz', '0', 'f'.repeat(64)]) {
      const cells = identiconCells(seed);
      expect(cells.some((c) => c), seed).toBe(true);
      expect(cells.some((c) => !c), seed).toBe(true);
    }
  });

  it('never throws on a seed the API did not produce', () => {
    expect(() => identiconCells('')).not.toThrow();
    expect(() => identiconCells('not hex at all ☃')).not.toThrow();
  });
});

describe('identiconColor', () => {
  it('is deterministic and always from the platform palette', () => {
    for (const seed of [SEED, OTHER, '', 'x', 'ffffffffffffffff']) {
      const color = identiconColor(seed);
      expect(IDENTICON_COLORS, seed).toContain(color);
      expect(identiconColor(seed)).toBe(color);
    }
  });

  it('uses more than one colour across seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) seen.add(identiconColor(i.toString(16).padStart(16, '0')));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('names design tokens, never literal colours — a palette swap must not miss this file', () => {
    for (const color of IDENTICON_COLORS) {
      expect(color).toMatch(/^var\(--color-[a-z0-9-]+\)$/);
    }
  });
});
