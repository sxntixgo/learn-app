/**
 * Colour arithmetic for the palette checks (Gate 4).
 *
 * WHY THIS EXISTS. `docs/design/track-hues.md` makes numeric claims — every
 * value is in the sRGB gamut, every track clears 3:1 against its page — and
 * `CHOSEN-PALETTE.md` leaves three questions open that are all of the form
 * "is this colour distinguishable enough". Those are arithmetic, and they
 * were being answered by eye. Answering them by eye is how the accent yellow
 * spent five phases at 2.46:1 against a threshold of 3.
 *
 * Nothing here is used at runtime. It exists so `palette.test.ts` can assert
 * on the tokens the app actually ships, and it is itself tested against the
 * sRGB primaries, because a palette check is worth exactly as much as its
 * conversion.
 *
 * The transforms are Björn Ottosson's OKLab matrices and the WCAG 2.x
 * relative-luminance formula. The dichromat simulation is Viénot, Brettel &
 * Mollon (1999), applied to LINEAR rgb — applying it to gamma-encoded values
 * is a common mistake that makes everything look more distinguishable than
 * it is.
 */

export type LinearRgb = readonly [number, number, number];
export type Oklab = readonly [number, number, number];
export type Dichromacy = 'protanopia' | 'deuteranopia' | 'tritanopia';

const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * OKLCH to LINEAR sRGB. The result may fall outside [0, 1]: that is what
 * "out of gamut" means, and callers need to see it rather than have it
 * quietly clamped — a browser clips such a colour, so what ships is not what
 * was specified.
 */
export function oklchToLinearRgb(lightness: number, chroma: number, hueDegrees: number): LinearRgb {
  const h = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A hair of tolerance, so a value that is out by a rounding error is not called out of gamut. */
const GAMUT_EPSILON = 0.0005;

export function inSrgbGamut(rgb: LinearRgb): boolean {
  return rgb.every((c) => c >= -GAMUT_EPSILON && c <= 1 + GAMUT_EPSILON);
}

/** What a screen actually shows: an out-of-gamut colour, clipped per channel. */
export function clipToGamut(rgb: LinearRgb): LinearRgb {
  return [
    Math.min(1, Math.max(0, rgb[0])),
    Math.min(1, Math.max(0, rgb[1])),
    Math.min(1, Math.max(0, rgb[2])),
  ];
}

export function toHex(rgb: LinearRgb): string {
  const clipped = clipToGamut(rgb);
  return `#${clipped.map((c) => Math.round(toGamma(c) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance. Clipped first: the ratio is about what is displayed. */
export function relativeLuminance(rgb: LinearRgb): number {
  const [r, g, b] = clipToGamut(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: LinearRgb, b: LinearRgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const DICHROMAT_MATRICES: Record<Dichromacy, readonly (readonly [number, number, number])[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How a colour appears to a dichromat, in linear rgb. */
export function simulateDichromacy(rgb: LinearRgb, kind: Dichromacy): LinearRgb {
  const m = DICHROMAT_MATRICES[kind];
  return [
    m[0]![0] * rgb[0] + m[0]![1] * rgb[1] + m[0]![2] * rgb[2],
    m[1]![0] * rgb[0] + m[1]![1] * rgb[1] + m[1]![2] * rgb[2],
    m[2]![0] * rgb[0] + m[2]![1] * rgb[1] + m[2]![2] * rgb[2],
  ];
}

export function linearRgbToOklab(rgb: LinearRgb): Oklab {
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Perceptual distance in OKLab (ΔEok). Both inputs are CLIPPED first, so the
 * distance is between the colours a screen shows rather than between two
 * ideals one of which cannot be displayed.
 */
export function perceptualDistance(a: LinearRgb, b: LinearRgb): number {
  const [l1, a1, b1] = linearRgbToOklab(clipToGamut(a));
  const [l2, a2, b2] = linearRgbToOklab(clipToGamut(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The smallest distance between two colours across normal vision and all three dichromacies. */
export function worstCaseDistance(a: LinearRgb, b: LinearRgb): { distance: number; vision: string } {
  let worst = { distance: perceptualDistance(a, b), vision: 'normal' };
  for (const kind of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
    const distance = perceptualDistance(simulateDichromacy(a, kind), simulateDichromacy(b, kind));
    if (distance < worst.distance) worst = { distance, vision: kind };
  }
  return worst;
}
