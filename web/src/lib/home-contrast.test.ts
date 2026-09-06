import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { contrastRatio, oklchToLinearRgb, toHex, worstCaseDistance, type LinearRgb } from './oklch.ts';

/**
 * THE FLOOR UNDER HOME'S DERIVED COLOURS.
 *
 * `palette.test.ts` measures every token in `app/tokens.css` against the
 * grounds it sits on. It cannot see this file's subject: Home (M1/P2) paints
 * a teal banner and, on it, softened tones of the rail's own ink written as
 * `color-mix(in oklch, var(--color-rail-text) 80%, transparent)`. That is a
 * NEW COLOUR — it exists only in `me.module.css`, no token declares it, and
 * `check-css-tokens.mjs` passes it because every part of it is a `var()`.
 * So the one guard this repo has against an unreadable value stops exactly
 * where the artboards' alpha continuum begins (artboard-spec §5.2: "23
 * distinct alpha stops across the set").
 *
 * THIS IS NOT HYPOTHETICAL. Written against the artboards' stops, two of
 * these were under their floors when Home was first assembled:
 *
 *  - `.statLabel` at 80% measured **3.93:1 light / 3.94:1 dark** against 4.5.
 *    Its ground is the statistic tile, which is itself a 10% wash of the same
 *    ink — so the tile lifts the ground and the label loses more contrast
 *    than the same alpha loses on the bare banner. Corrected to 92%.
 *  - `.resumeCourse` at 78% measured **4.40:1 in dark** against 4.5 (light
 *    passed at 4.59, which is how a value like this ships: it is only wrong
 *    in one theme). Corrected to 85%.
 *
 * Neither is visible by eye, both are one line of arithmetic, and this repo
 * has shipped that exact class of defect twice — see `--color-accent-yellow`
 * in `tokens.css`, wrong twice, measurable both times.
 *
 * WHY A TABLE AND NOT A LOOP. A mix has no declared role, so nothing can
 * derive what it sits on or what floor applies. The table below says both,
 * per scheme where the roles differ; and the last test asserts the table
 * covers EVERY mix in these two files, so a new one added later fails until
 * someone says what it is for. That is the same shape `palette.test.ts`'s
 * role table uses, for the same reason: a sheet that can be extended without
 * being measured stops being a floor.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.resolve(here, '../../app/tokens.css'), 'utf8');

const HOME_STYLESHEETS = ['../../app/me/me.module.css', '../../app/me/activity-feed.module.css'] as const;

type Scheme = 'light' | 'dark';

/**
 * The two blocks that carry a complete palette: `:root` and the
 * unconditional `[data-theme='dark']` duplicate. The `prefers-color-scheme`
 * block is the same values as the latter — `tokens-dark-blocks.test.ts`
 * already asserts the two cannot drift — so reading one of them is enough.
 */
function paletteIn(source: string, blockPattern: RegExp): Map<string, LinearRgb> {
  const block = source.match(blockPattern);
  if (!block) throw new Error(`tokens.css: no block matching ${blockPattern}`);
  const out = new Map<string, LinearRgb>();
  for (const declaration of block[1]!.matchAll(/(--color-[\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    out.set(declaration[1]!, oklchToLinearRgb(Number(declaration[2]), Number(declaration[3]), Number(declaration[4])));
  }
  return out;
}

const PALETTE: Record<Scheme, Map<string, LinearRgb>> = {
  light: paletteIn(tokensCss, /:root\s*\{([\s\S]*?)\n\}/),
  dark: paletteIn(tokensCss, /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/),
};

function token(scheme: Scheme, name: string): LinearRgb {
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
function over(fg: LinearRgb, alpha: number, bg: LinearRgb): LinearRgb {
  const f = fg.map(encode);
  const b = bg.map(encode);
  return [0, 1, 2].map((i) => decode(alpha * f[i]! + (1 - alpha) * b[i]!)) as unknown as LinearRgb;
}

/** A mix as it is written in CSS: a token at a percentage of itself, the rest transparent. */
interface Mix {
  token: string;
  percent: number;
}

/**
 * A ground, bottom layer first. Each layer is a token, optionally painted at
 * a percentage — the statistic tile is `--color-rail-bg` with a 10% wash of
 * `--color-rail-text` over it, and the label on it has to be measured
 * against that, not against the bare banner.
 */
type Ground = readonly (readonly [string, number])[];

function resolve(scheme: Scheme, ground: Ground): LinearRgb {
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
type Kind = 'text' | 'ui' | 'quiet';

interface Case {
  name: string;
  mix: Mix;
  ground: Ground;
  kind: Kind;
  /** Omitted means both. The quiz card and the degree card re-point their roles per theme. */
  scheme?: Scheme;
  why: string;
}

const RAIL: Ground = [['--color-rail-bg', 1]];
/** The narrow tier's statistic tile: a 10% wash of the rail's ink on the banner. */
const STAT_TILE: Ground = [
  ['--color-rail-bg', 1],
  ['--color-rail-text', 0.1],
];

const CASES: readonly Case[] = [
  {
    name: '.resumeEyebrow — "MODULE 2 · LESSON 6 · 7 MIN"',
    mix: { token: '--color-rail-text', percent: 88 },
    ground: RAIL,
    kind: 'text',
    why: '10.4px mono on the banner',
  },
  {
    name: '.resumeCourse — the course under the lesson title',
    mix: { token: '--color-rail-text', percent: 85 },
    ground: RAIL,
    kind: 'text',
    why: '15.2px on the banner; 78% measured 4.40:1 in dark',
  },
  {
    name: '.stat border — the tile edge at narrow tier',
    mix: { token: '--color-rail-text', percent: 22 },
    ground: RAIL,
    kind: 'quiet',
    why: 'a hairline round the statistic tile',
  },
  {
    name: '.stat background — the tile wash at narrow tier',
    mix: { token: '--color-rail-text', percent: 10 },
    ground: RAIL,
    kind: 'quiet',
    why: 'the tile has to be distinguishable from the banner it sits on',
  },
  {
    name: '.statLabel — "STREAK" / "THIS WEEK"',
    mix: { token: '--color-rail-text', percent: 92 },
    ground: STAT_TILE,
    kind: 'text',
    why: '9.6px mono on the tile; 80% measured 3.93:1 light / 3.94:1 dark',
  },
  {
    name: '.upNextItem[data-kind=quiz] --up-next-meta — the checkpoint card is inverted in light',
    mix: { token: '--color-page', percent: 72 },
    ground: [['--color-text', 1]],
    kind: 'text',
    scheme: 'light',
    why: '12.8px on the near-black checkpoint card. Dark re-points this to --color-text-secondary on --color-surface-raised, which palette.test.ts already measures',
  },
  {
    name: '.degreePip unfilled (light) — the degree card is a pale cyan block',
    mix: { token: '--color-rail-bg', percent: 25 },
    ground: [['--color-rail-text', 1]],
    kind: 'quiet',
    scheme: 'light',
    why: 'the empty half of the pip bar; the count below it carries the same fact in words',
  },
  {
    name: '.degreePip unfilled (dark) — the card inverts to teal-on-dark',
    mix: { token: '--color-link', percent: 25 },
    ground: [['--color-rail-bg', 1]],
    kind: 'quiet',
    scheme: 'dark',
    why: 'artboard-spec §5.2.2: the degree card inverts in dark rather than glaring',
  },
  {
    name: '.bar — the empty progress track on a course row',
    mix: { token: '--color-text', percent: 12 },
    ground: [['--color-page', 1]],
    kind: 'quiet',
    why: 'the unfilled part of the bar; the "3/12" beside it is the readable form',
  },
  {
    name: '.dot[data-tone=enrolment] — the feed\'s bookkeeping tone',
    mix: { token: '--color-text', percent: 30 },
    ground: [['--color-page', 1]],
    kind: 'quiet',
    why: 'aria-hidden: the row\'s own sentence already says what happened',
  },
];

const SCHEMES: readonly Scheme[] = ['light', 'dark'];

describe('Home\'s color-mix tones clear the floor for the job they do', () => {
  for (const scheme of SCHEMES) {
    for (const testCase of CASES) {
      if (testCase.scheme && testCase.scheme !== scheme) continue;
      it(`${scheme}: ${testCase.name}`, () => {
        const ground = resolve(scheme, testCase.ground);
        const mixed = over(token(scheme, testCase.mix.token), testCase.mix.percent / 100, ground);
        const where = `${toHex(mixed)} on ${toHex(ground)} — ${testCase.why}`;

        if (testCase.kind === 'quiet') {
          // Same treatment palette.test.ts gives hairlines: WCAG 1.4.11
          // exempts these, but "present at all" is still a requirement.
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

describe('the table cannot fall behind the stylesheets', () => {
  /**
   * The point of the whole file. A mix that is not in the table above is not
   * measured by anything at all — not by `palette.test.ts`, which only reads
   * `tokens.css`, and not by `check-css-tokens.mjs`, which is satisfied the
   * moment every part of the value is a `var()`. So adding one has to fail
   * here until it is given a ground and a floor.
   */
  it('every color-mix on Home has a case above, and every case is still in the CSS', () => {
    const declared = new Set(CASES.map((c) => `${c.mix.token} ${c.mix.percent}%`));
    const found = new Set<string>();
    for (const stylesheet of HOME_STYLESHEETS) {
      const source = readFileSync(path.resolve(here, stylesheet), 'utf8');
      for (const mix of source.matchAll(/color-mix\(in oklch,\s*var\((--[\w-]+)\)\s*(\d+)%,\s*transparent\)/g)) {
        found.add(`${mix[1]!} ${mix[2]!}%`);
      }
    }

    // `--degree-pip` and `--up-next-meta` are LOCAL properties re-pointed per
    // theme in the stylesheet, so what the regex sees is the local name and
    // what the table names is the token behind it, per scheme.
    const localAliases: Record<string, readonly string[]> = {
      '--degree-pip': ['--color-rail-bg', '--color-link'],
    };
    const expanded = new Set<string>();
    for (const entry of found) {
      const [name, percent] = entry.split(' ') as [string, string];
      const aliases = localAliases[name];
      if (aliases) for (const alias of aliases) expanded.add(`${alias} ${percent}`);
      else expanded.add(entry);
    }

    expect([...expanded].sort(), 'a color-mix in me.module.css / activity-feed.module.css with no measured case').toEqual(
      [...declared].sort(),
    );
  });
});
