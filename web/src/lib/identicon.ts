/*
 * THE GENERATED AVATAR (design §11.1: "Generated identicon by default,
 * derived from the user ID and colored from the platform palette").
 *
 * Pure and deterministic: the same seed always draws the same face, on the
 * server and in the browser, this year and next. The seed itself is a one-way
 * hash of the user id, computed by the API (api/src/profile/serialize.ts), so
 * nothing here needs — or is given — the id.
 *
 * UPLOADS ARE NOT IMPLEMENTED. §11.1 permits them, on the condition that the
 * bytes are always re-encoded rather than served back; the re-encoder for
 * that is `sharp`, which currently ships unpatched libvips CVEs and whose
 * fixed line needs a Next 16 upgrade this project has deferred. Until then
 * every account has one of these.
 *
 * A 5×5 grid mirrored down the middle — the classic identicon construction.
 * The mirroring is what makes 25 near-random cells read as a face instead of
 * as noise.
 */

/** Grid edge, in cells. Odd, so there is a centre column to mirror around. */
export const IDENTICON_SIZE = 5;

/**
 * The palette. Design tokens only, never literal colours: §14's whole point
 * is that a palette swap touches app/tokens.css and nothing else.
 *
 * The heat ramp's darker steps and the link teal are used because they are
 * the palette's saturated colours that carry enough contrast against the page
 * at small sizes. The yellow accent is deliberately absent — §14.1 rule 1:
 * it is structural and "never a fill", and an identicon is nothing but fill.
 */
export const IDENTICON_COLORS: readonly string[] = Object.freeze([
  'var(--color-link)',
  'var(--color-heat-3)',
  'var(--color-heat-4)',
  'var(--color-heat-5)',
  'var(--color-tag-text)',
]);

/**
 * FNV-1a, 32-bit. A hash rather than the seed's raw digits because the seed
 * is not guaranteed to be hex — this module must draw *something* stable for
 * any string it is handed, including one from an older or newer API.
 */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** xorshift32: one seed, a stream of bits, no dependencies. */
function* bits(seed: number): Generator<boolean> {
  let state = seed === 0 ? 0x9e3779b9 : seed;
  for (;;) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    yield (state & 1) === 1;
  }
}

/**
 * The grid, row-major, `true` where a cell is filled.
 *
 * The centre column and the left half are drawn from the bit stream; the
 * right half mirrors them. A face that came out entirely blank or entirely
 * filled is nudged: it would be an avatar that identifies nobody.
 */
export function identiconCells(seed: string): boolean[] {
  const half = Math.ceil(IDENTICON_SIZE / 2);
  const stream = bits(hash(seed));
  const cells: boolean[] = new Array<boolean>(IDENTICON_SIZE * IDENTICON_SIZE).fill(false);

  for (let row = 0; row < IDENTICON_SIZE; row += 1) {
    for (let col = 0; col < half; col += 1) {
      const on = stream.next().value === true;
      cells[row * IDENTICON_SIZE + col] = on;
      cells[row * IDENTICON_SIZE + (IDENTICON_SIZE - 1 - col)] = on;
    }
  }

  // Both degenerate faces are fixed the same way: flip the centre cell, which
  // is its own mirror and so cannot break the symmetry.
  const centre = Math.floor((IDENTICON_SIZE * IDENTICON_SIZE) / 2);
  if (cells.every((cell) => cell) || cells.every((cell) => !cell)) {
    cells[centre] = !cells[centre];
  }
  return cells;
}

/** The fill colour for this seed — always one of IDENTICON_COLORS. */
export function identiconColor(seed: string): string {
  const index = hash(`color:${seed}`) % IDENTICON_COLORS.length;
  return IDENTICON_COLORS[index] ?? IDENTICON_COLORS[0]!;
}
