import { describe, it, expect } from 'vitest';
import { assertFloors, mixesIn, type Case, type Ground } from './mix-contrast.ts';

/**
 * THE FLOOR UNDER EVERY color-mix OUTSIDE HOME.
 *
 * `home-contrast.test.ts` proved the technique and caught two live defects
 * with it — `.statLabel` at 3.93:1 and `.resumeCourse` at 4.40:1 in dark only,
 * both against a 4.5 floor, neither visible by eye. It covered two
 * stylesheets. The rest of the app writes 19 more mixes that nothing measured:
 * `palette.test.ts` reads only `tokens.css`, and `check-css-tokens.mjs` passes
 * any value whose parts are all `var()`.
 *
 * MOST OF THESE ARE GROUNDS, NOT FOREGROUNDS. A 12% wash of the rail's ink is
 * a hover state — it carries no information on its own, and WCAG puts no ratio
 * on it. What matters is that it stays visible against what it sits on, and
 * that the text placed on TOP of it still clears its own floor. So a wash is
 * measured as `quiet` here, and separately appears as a ground layer under the
 * text cases. That is the same shape Home's statistic tile has: a 10% wash
 * that lifts the ground under its own label.
 */

const RAIL: Ground = [['--color-rail-bg', 1]];
const PAGE: Ground = [['--color-page', 1]];
const RAISED: Ground = [['--color-surface-raised', 1]];

const CASES: readonly Case[] = [
  // ---- The rail's own ink, as text ----
  {
    name: '.identityHandle at 85% on the rail',
    mix: { token: '--color-rail-text', percent: 85 },
    ground: RAIL,
    kind: 'text',
    why: 'the signed-in handle is read, so it takes the 4.5 text floor',
  },

  // ---- Borders and edges: WCAG 1.4.11, 3:1 ----
  {
    name: 'collapse-toggle border at 35%',
    mix: { token: '--color-rail-text', percent: 35 },
    ground: RAIL,
    kind: 'quiet',
    why: 'quiet, not ui: the control carries a visible «/» glyph, so the border is not what marks it',
  },
  {
    name: 'rail footer divider at 25%',
    mix: { token: '--color-rail-text', percent: 25 },
    ground: RAIL,
    kind: 'quiet',
    why: 'a divider separates, it does not inform — visibility floor only',
  },
  {
    name: 'selected quiz choice border at 40% of the page ink',
    mix: { token: '--color-text', percent: 40 },
    ground: RAISED,
    kind: 'quiet',
    why: 'quiet, not ui: the native radio is checked and carries the state; the tint reinforces it',
  },

  // ---- Hover and active washes: decoration, but must be visible ----
  {
    name: 'rail hover wash at 12%',
    mix: { token: '--color-rail-text', percent: 12 },
    ground: RAIL,
    kind: 'quiet',
    why: 'hover feedback — invisible feedback is not feedback',
  },
  {
    name: 'rail wash at 10%',
    mix: { token: '--color-rail-text', percent: 10 },
    ground: RAIL,
    kind: 'quiet',
    why: 'the lightest wash in the shell, and the one most likely to vanish',
  },
  {
    name: 'rail wash at 14%',
    mix: { token: '--color-rail-text', percent: 14 },
    ground: RAIL,
    kind: 'quiet',
    why: 'the current-destination wash',
  },
  {
    name: 'rail wash at 25%',
    mix: { token: '--color-rail-text', percent: 25 },
    ground: RAIL,
    kind: 'quiet',
    why: 'the heaviest rail wash, an active/pressed state',
  },
  {
    name: 'scrim at 55% of the rail ground',
    mix: { token: '--color-rail-bg', percent: 55 },
    ground: PAGE,
    kind: 'quiet',
    why: 'the drawer scrim over the page — it must read as a dimmed page, not as nothing',
  },
  {
    name: 'theme toggle hover wash at 12% of the page ink',
    mix: { token: '--color-text', percent: 12 },
    ground: PAGE,
    kind: 'quiet',
    why: 'the one shell wash keyed to page ink rather than rail ink',
  },

  // ---- The lesson reader's callout fills ----
  {
    name: 'lesson callout fill at 6% of the page ink',
    mix: { token: '--color-text', percent: 6 },
    ground: RAISED,
    kind: 'quiet',
    why: 'a neutral callout tint; the border above is what carries the meaning',
  },
  {
    name: 'lesson note fill at 10% of the link colour',
    mix: { token: '--color-link', percent: 10 },
    ground: RAISED,
    kind: 'quiet',
    why: 'the informational callout tint',
  },
  {
    name: 'lesson warning fill at 8% of the error colour',
    mix: { token: '--color-error', percent: 8 },
    ground: RAISED,
    kind: 'quiet',
    why: 'the warning callout tint — colour is never its only signal',
  },
];

assertFloors(describe, it, 'the shell and lesson color-mix tones clear the floor for the job they do', CASES);

describe('the table cannot fall behind the stylesheets', () => {
  /**
   * The point of the file, same as Home's. A mix absent from the table is
   * measured by nothing at all, so adding one must fail here until someone
   * says what it is for and what it sits on.
   */
  const STYLESHEETS = [
    '../../app/_shell/nav.module.css',
    '../../app/_shell/nav-drawer.module.css',
    '../../app/_shell/theme-toggle.module.css',
    '../../app/_shell/auth-control.module.css',
    '../../app/courses/[courseSlug]/lessons/[lessonSlug]/lesson.module.css',
  ] as const;

  it('every color-mix in the shell and lesson reader has a measured case', () => {
    const declared = new Set(CASES.map((c) => `${c.mix.token} ${c.mix.percent}%`));
    const found = mixesIn(STYLESHEETS);
    expect(
      [...found].sort(),
      'a color-mix in the shell or lesson reader with no measured case — give it a ground and a floor above',
    ).toEqual([...declared].sort());
  });
});
