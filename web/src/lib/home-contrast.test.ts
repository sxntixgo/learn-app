import { describe, it, expect } from 'vitest';
import { assertFloors, mixesIn, type Case, type Ground } from './mix-contrast.ts';

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

assertFloors(describe, it, expect, "Home's color-mix tones clear the floor for the job they do", CASES);

const HOME_STYLESHEETS = ['../../app/me/me.module.css', '../../app/me/activity-feed.module.css'] as const;

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
    const found = mixesIn(HOME_STYLESHEETS);

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
