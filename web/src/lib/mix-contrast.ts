import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { contrastRatio, oklchToLinearRgb, toHex, worstCaseDistance, type LinearRgb } from './oklch.ts';

/**
 * THE MACHINERY BEHIND EVERY color-mix CONTRAST FLOOR.
 *
 * Extracted from `home-contrast.test.ts`, which proved the technique and
 * caught two live defects with it. Nothing else in the repo can see these
 * values: `palette.test.ts` reads only `tokens.css`, and
 * `check-css-tokens.mjs` is satisfied the moment every part of a value is a
 * `var()`. A `color-mix` written inside a CSS module is therefore measured by
 * NOTHING unless a table here says what it is for.
 *
 * Shared so the floor can be extended to a new stylesheet by writing a table,
 * not by copying 100 lines of compositing arithmetic that has to stay
 * identical to be comparable.
 */

export const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.resolve(here, '../../app/tokens.css'), 'utf8');

export type Scheme = 'light' | 'dark';

/**
 * The two blocks that carry a complete palette: `:root` and the
 * unconditional `[data-theme='dark']` duplicate. The `prefers-color-scheme`
 * block is the same values as the latter — `tokens-dark-blocks.test.ts`
 * already asserts the two cannot drift — so reading one of them is enough.
 */
export function paletteIn(source: string, blockPattern: RegExp): Map<string, LinearRgb> {
  const block = source.match(blockPattern);
  if (!block) throw new Error(`tokens.css: no block matching ${blockPattern}`);
  const out = new Map<string, LinearRgb>();
  for (const declaration of block[1]!.matchAll(/(--color-[\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    out.set(declaration[1]!, oklchToLinearRgb(Number(declaration[2]), Number(declaration[3]), Number(declaration[4])));
  }
  return out;
}

export const PALETTE: Record<Scheme, Map<string, LinearRgb>> = {
  light: paletteIn(tokensCss, /:root\s*\{([\s\S]*?)\n\}/),
  dark: paletteIn(tokensCss, /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/),
};

export function token(scheme: Scheme, name: string): LinearRgb {
  const value = PALETTE[scheme].get(name);
  if (!value) throw new Error(`${name} is not declared in the ${scheme} palette`);
  return value;
}

/*
 * COMPOSITING HAPPENS IN GAMMA-ENCODED sRGB, not in the linear light the
 * contrast maths uses and not in OKLCH. `color-mix(in oklch, C 80%,
 * transparent)` produces C carrying alpha 0.8; the browser then paints it
 * over whatever is behind, and that blend is a plain per-channel average of
 * the ENCODED values. Mixing in linear light instead would report a
 * different, brighter colour than the screen shows — which would make this
 * file wrong in the same silent direction as the defects it exists to catch.
 */
const encode = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
const decode = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

/** `over` = the mix of `fg` at `alpha` painted on `bg`, back in linear light. */
export function over(fg: LinearRgb, alpha: number, bg: LinearRgb): LinearRgb {
  const f = fg.map(encode);
  const b = bg.map(encode);
  return [0, 1, 2].map((i) => decode(alpha * f[i]! + (1 - alpha) * b[i]!)) as unknown as LinearRgb;
}

/** A mix as it is written in CSS: a token at a percentage of itself, the rest transparent. */
export interface Mix {
  token: string;
  percent: number;
}

/**
 * A ground, bottom layer first. Each layer is a token, optionally painted at
 * a percentage — the statistic tile is `--color-rail-bg` with a 10% wash of
 * `--color-rail-text` over it, and the label on it has to be measured
 * against that, not against the bare banner.
 */
export type Ground = readonly (readonly [string, number])[];

export function resolve(scheme: Scheme, ground: Ground): LinearRgb {
  return ground.reduce<LinearRgb | null>(
    (below, [name, alpha]) => (below === null ? token(scheme, name) : over(token(scheme, name), alpha, below)),
    null,
  )!;
}

/**
 *   text     Glyphs. WCAG AA, 4.5:1. None of Home's mixed tones land on
 *            large text — the percent, the lesson title and the statistic
 *            values are all SOLID `--color-rail-text`, measured by
 *            palette.test.ts against the rail already.
 *   ui       A non-text element that carries information — WCAG 1.4.11, 3:1.
 *            The filled degree pip is the only one, and even it is
 *            redundant: the sentence under the pips says the same thing.
 *   quiet    Decoration and tracks: the unfilled pip, the empty progress
 *            track, the statistic tile's own border and wash, the feed's
 *            bookkeeping dot. WCAG puts no ratio on these, but one nobody
 *            can see is still a bug, so they take the same 0.02 ΔEok
 *            visibility floor palette.test.ts gives hairlines.
 */
export type Kind = 'text' | 'ui' | 'quiet';

export interface Case {
  name: string;
  mix: Mix;
  ground: Ground;
  kind: Kind;
  /** Omitted means both. The quiz card and the degree card re-point their roles per theme. */
  scheme?: Scheme;
  why: string;
}


const SCHEMES: readonly Scheme[] = ['light', 'dark'];

/**
 * Runs one table. `text` takes WCAG AA 4.5:1, `ui` takes WCAG 1.4.11's 3:1,
 * and `quiet` takes the same 0.02 deltaEok visibility floor palette.test.ts
 * gives hairlines — WCAG puts no ratio on decoration, but one nobody can see
 * is still a bug.
 */
export function assertFloors(describeFn: (name: string, fn: () => void) => void, itFn: (name: string, fn: () => void) => void, title: string, cases: readonly Case[]): void {
  describeFn(title, () => {
    for (const scheme of SCHEMES) {
      for (const testCase of cases) {
        if (testCase.scheme && testCase.scheme !== scheme) continue;
        itFn(`${scheme}: ${testCase.name}`, () => {
          const ground = resolve(scheme, testCase.ground);
          const mixed = over(token(scheme, testCase.mix.token), testCase.mix.percent / 100, ground);
          const where = `${toHex(mixed)} on ${toHex(ground)} — ${testCase.why}`;

          if (testCase.kind === 'quiet') {
            const worst = worstCaseDistance(mixed, ground);
            expect(worst.distance, `${where}, under ${worst.vision}`).toBeGreaterThan(0.02);
            return;
          }

          const floor = testCase.kind === 'text' ? 4.5 : 3;
          expect(contrastRatio(mixed, ground), where).toBeGreaterThanOrEqual(floor);
        });
      }
    }
  });
}

/**
 * Every `color-mix` actually written in `stylesheets`, as `"<token> <n>%"`.
 *
 * BOTH FORMS. `color-mix(in oklch, var(--x) 80%, transparent)` is a tone of
 * one token; `color-mix(in oklch, var(--x) 6%, var(--y))` is a wash of one
 * token ON another. The second form is what the lesson reader's callouts use,
 * and a regex that only knows the first silently reports full coverage of a
 * file it cannot see into — which is exactly the failure mode this whole
 * approach exists to prevent.
 */
export function mixesIn(stylesheets: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const stylesheet of stylesheets) {
    const source = readFileSync(path.resolve(here, stylesheet), 'utf8');
    for (const mix of source.matchAll(
      /color-mix\(in oklch,\s*var\((--[\w-]+)\)\s*(\d+)%,\s*(?:transparent|var\((--[\w-]+)\))\s*\)/g,
    )) {
      found.add(`${mix[1]!} ${mix[2]!}%`);
    }
  }
  return found;
}
