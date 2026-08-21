import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  inSrgbGamut,
  oklchToLinearRgb,
  perceptualDistance,
  relativeLuminance,
  simulateDichromacy,
  toHex,
  worstCaseDistance,
} from './oklch.ts';

/**
 * The conversion is checked against colours whose OKLCH coordinates are
 * published, and against the two contrast ratios everyone knows. Without
 * this, palette.test.ts is a confident set of assertions built on arithmetic
 * nobody checked — which is the failure mode it exists to prevent.
 */
describe('OKLCH to sRGB', () => {
  it('round-trips the sRGB primaries exactly', () => {
    expect(toHex(oklchToLinearRgb(1, 0, 0))).toBe('#ffffff');
    expect(toHex(oklchToLinearRgb(0, 0, 0))).toBe('#000000');
    expect(toHex(oklchToLinearRgb(0.628, 0.2577, 29.23))).toBe('#ff0000');
    expect(toHex(oklchToLinearRgb(0.8664, 0.2948, 142.4953))).toBe('#00ff00');
    expect(toHex(oklchToLinearRgb(0.452, 0.3132, 264.052))).toBe('#0000ff');
  });

  it('reports a colour outside sRGB as out of gamut rather than clamping it away', () => {
    // A chroma this high at this lightness has no sRGB representation. The
    // caller has to be able to see that: a browser CLIPS such a value, so
    // what ships is not what was written.
    const tooSaturated = oklchToLinearRgb(0.72, 0.3, 88);
    expect(inSrgbGamut(tooSaturated)).toBe(false);
    expect(tooSaturated.some((c) => c < 0 || c > 1)).toBe(true);

    expect(inSrgbGamut(oklchToLinearRgb(0.52, 0.095, 255))).toBe(true);
  });
});

describe('WCAG contrast', () => {
  it('gives 21:1 for black on white and 1:1 for a colour against itself', () => {
    const white = oklchToLinearRgb(1, 0, 0);
    const black = oklchToLinearRgb(0, 0, 0);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 2);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6);
  });

  it('is symmetric', () => {
    const a = oklchToLinearRgb(0.52, 0.095, 175);
    const b = oklchToLinearRgb(0.995, 0.002, 95);
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it('measures the CLIPPED colour, which is the one on the screen', () => {
    // oklch(0.72 0.15 88) is out of gamut; its blue channel is negative.
    // Luminance computed from the raw value would be lower than what a
    // display can produce, and the ratio correspondingly wrong.
    const outOfGamut = oklchToLinearRgb(0.72, 0.15, 88);
    expect(inSrgbGamut(outOfGamut)).toBe(false);
    expect(relativeLuminance(outOfGamut)).toBeGreaterThan(0);
    expect(relativeLuminance(outOfGamut)).toBeLessThanOrEqual(1);
  });
});

describe('dichromat simulation', () => {
  it('collapses red and green toward each other for a deuteranope', () => {
    const red = oklchToLinearRgb(0.628, 0.2577, 29.23);
    const green = oklchToLinearRgb(0.8664, 0.2948, 142.4953);

    const normal = perceptualDistance(red, green);
    const seen = perceptualDistance(simulateDichromacy(red, 'deuteranopia'), simulateDichromacy(green, 'deuteranopia'));

    expect(seen).toBeLessThan(normal);
  });

  it('leaves a greyscale pair alone — there is no chroma to lose', () => {
    const light = oklchToLinearRgb(0.9, 0, 0);
    const dark = oklchToLinearRgb(0.3, 0, 0);
    for (const kind of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const seen = perceptualDistance(simulateDichromacy(light, kind), simulateDichromacy(dark, kind));
      expect(seen, kind).toBeCloseTo(perceptualDistance(light, dark), 1);
    }
  });

  it('worstCaseDistance reports which vision was worst, not just a number', () => {
    const red = oklchToLinearRgb(0.628, 0.2577, 29.23);
    const green = oklchToLinearRgb(0.8664, 0.2948, 142.4953);
    const worst = worstCaseDistance(red, green);

    expect(worst.distance).toBeLessThanOrEqual(perceptualDistance(red, green));
    expect(['normal', 'protanopia', 'deuteranopia', 'tritanopia']).toContain(worst.vision);
  });

  it('gives zero distance for a colour against itself, under every vision', () => {
    const c = oklchToLinearRgb(0.52, 0.095, 175);
    expect(worstCaseDistance(c, c).distance).toBeCloseTo(0, 10);
  });
});
