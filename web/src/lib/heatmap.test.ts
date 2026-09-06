import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  HEATMAP_MAX_WEEKS,
  HEATMAP_WINDOW_STEPS,
  NAV_SIDEBAR_FROM_PX,
  NAV_SIDEBAR_PX,
  PAGE_MAX_WIDTH_PX,
  PAGE_GUTTER_STEPS,
  availableHeatmapWidthPx,
  buildHeatmapWeeks,
  formatDayLabel,
  heatmapWindowForWidth,
  intensityLevel,
  visibleWeeksForWidth,
  windowWidthPx,
} from './heatmap';
import type { HeatmapDay } from './api';

const WEB_DIR = path.resolve(import.meta.dirname, '..', '..');

/**
 * Reads `--var: <n>px|<n>` declarations out of a CSS module, bucketed by the
 * `min-width` media query they sit in (0 = outside any). Deliberately dumb:
 * it exists so the tests below can prove the *shipped CSS* implements the
 * window policy declared in TypeScript, rather than trusting a comment.
 */
function readCssVarsByBreakpoint(cssPath: string, names: readonly string[]): Map<number, Record<string, number>> {
  const css = readFileSync(cssPath, 'utf-8');
  const byBreakpoint = new Map<number, Record<string, number>>();

  // Split at every `@media (min-width: Npx)`; text before the first one is
  // the base (0px) bucket. Other at-rules (reduced motion) declare none of
  // these names, so they cannot pollute a bucket.
  const boundaries = [...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)];
  const segments: Array<{ minWidth: number; text: string }> = [];
  segments.push({ minWidth: 0, text: css.slice(0, boundaries[0]?.index ?? css.length) });
  boundaries.forEach((match, i) => {
    const start = match.index ?? 0;
    const end = boundaries[i + 1]?.index ?? css.length;
    segments.push({ minWidth: Number(match[1]), text: css.slice(start, end) });
  });

  for (const segment of segments) {
    const found: Record<string, number> = {};
    for (const name of names) {
      const matches = [...segment.text.matchAll(new RegExp(`${name}:\\s*(-?[\\d.]+)(px)?\\s*;`, 'g'))];
      const last = matches.at(-1);
      if (last?.[1] !== undefined) {
        found[name] = Number(last[1]);
      }
    }
    if (Object.keys(found).length > 0) {
      byBreakpoint.set(segment.minWidth, found);
    }
  }

  return byBreakpoint;
}

describe('heatmapWindowForWidth', () => {
  it('gives ~12 weeks on a phone, ~26 on a tablet, 53 on a desktop (design §10)', () => {
    expect(visibleWeeksForWidth(375)).toBe(12);
    expect(visibleWeeksForWidth(834)).toBe(26);
    expect(visibleWeeksForWidth(1440)).toBe(53);
  });

  it('switches exactly at the declared breakpoints, never between them', () => {
    // 834 and 1360, not the shell's 768/1200: a step may only begin where its
    // own week count actually fits. See HEATMAP_WINDOW_STEPS.
    expect(visibleWeeksForWidth(833)).toBe(12);
    expect(visibleWeeksForWidth(834)).toBe(26);
    expect(visibleWeeksForWidth(1359)).toBe(26);
    expect(visibleWeeksForWidth(1360)).toBe(53);
  });

  it('falls back to the narrowest step for absurd widths', () => {
    expect(visibleWeeksForWidth(0)).toBe(12);
    expect(visibleWeeksForWidth(-100)).toBe(12);
    expect(heatmapWindowForWidth(320).weeks).toBe(12);
  });

  it('never asks for more weeks than the API window', () => {
    for (const step of HEATMAP_WINDOW_STEPS) {
      expect(step.weeks).toBeLessThanOrEqual(HEATMAP_MAX_WEEKS);
    }
  });
});

describe('the window actually fits the viewport it is for', () => {
  // The four artboard widths a browser actually measured for the scroll
  // viewport (measured with the Playwright harness). Pinned here so a change
  // to the shell's sidebar or the activity card's padding fails HERE, in a
  // fast test, rather than silently shrinking the window until the e2e
  // viewport spec notices.
  //
  // 834 was 564 until the tier boundary moved to 1024. iPad portrait is the
  // narrow tier now — a drawer, out of flow — so the rail it used to
  // subtract is not rendered there and the column is 180px wider.
  it('is the arithmetic every window step is checked against', () => {
    expect(availableHeatmapWidthPx(375)).toBe(301);
    expect(availableHeatmapWidthPx(834)).toBe(744);
    expect(availableHeatmapWidthPx(1194)).toBe(880);
    expect(availableHeatmapWidthPx(1440)).toBe(1054);
  });

  /*
   * AND IT NEVER PROMISES MORE ROOM THAN THE PAGE HAS.
   *
   * These four are the heatmap's containing block on the profile, measured in
   * Chromium at the four artboard widths (`.figure` inside `.section` inside
   * `main.page`) — not derived, since deriving it is what was wrong every
   * previous time. The model currently comes in UNDER each of them, by 42px
   * at three widths and 58px at 1440, for the two reasons written out in
   * heatmap.ts: `.activity`'s card chrome is not on this page, and the
   * profile's 1200px gutter step does not take effect there.
   *
   * Under is safe — a window that fits the model fits the page. Over is the
   * bug this file exists for: the declared window overflows and the grid
   * quietly loses a column. So the direction is asserted, not the equality.
   */
  const MEASURED_CONTAINER_PX: ReadonlyArray<readonly [number, number]> = [
    [375, 343],
    [834, 786],
    [1194, 922],
    [1440, 1112],
  ];

  for (const [viewport, measured] of MEASURED_CONTAINER_PX) {
    it(`never claims more room at ${viewport} than the browser gives it (${measured}px)`, () => {
      expect(availableHeatmapWidthPx(viewport)).toBeLessThanOrEqual(measured);
    });
  }

  // The whole point of the trailing window (design §10) is that 53x7 is
  // unusable at 375px. If the arithmetic below stops holding, the phone
  // layout has silently started overflowing or the cells have gone sub-5px.
  const cases = [
    { viewport: 375, step: 0 },
    { viewport: 834, step: 1 },
    { viewport: 1440, step: 2 },
  ];

  for (const { viewport, step: stepIndex } of cases) {
    it(`fits ${HEATMAP_WINDOW_STEPS[stepIndex]!.weeks} weeks inside ${viewport}px`, () => {
      const step = heatmapWindowForWidth(viewport);
      expect(step).toBe(HEATMAP_WINDOW_STEPS[stepIndex]);
      expect(windowWidthPx(step)).toBeLessThanOrEqual(availableHeatmapWidthPx(viewport));
    });
  }

  it('still fits at the narrowest width each step claims', () => {
    for (const step of HEATMAP_WINDOW_STEPS) {
      const viewport = Math.max(step.minViewportWidth, 375);
      expect(windowWidthPx(step)).toBeLessThanOrEqual(availableHeatmapWidthPx(viewport));
    }
  });

  it('keeps cells finger-sized on touch widths and never sub-5px anywhere', () => {
    for (const step of HEATMAP_WINDOW_STEPS) {
      expect(step.cellPx).toBeGreaterThanOrEqual(12);
    }
    // 18, lowered from 20 on request ("a little too big, make them 10%
    // smaller"). Recorded rather than quietly edited, because this is the
    // PHONE step and it is the one number here with a cost: the cell is
    // already far below a comfortable touch target, and every reduction makes
    // a mis-tap likelier on the device where the grid is tightest. Design §10
    // originally specified 22, and Gate 4 still has an open question asking
    // whether the cell size works in the hand at all.
    expect(HEATMAP_WINDOW_STEPS[0]!.cellPx).toBeGreaterThanOrEqual(18);
  });
});

/*
 * THE TWO CONSTANTS THAT DESCRIBED A PAGE THAT NO LONGER EXISTED.
 *
 * `NAV_SIDEBAR_PX` and `NAV_SIDEBAR_FROM_PX` are the heatmap's model of the
 * shell: how wide the in-flow nav is, and from which viewport width it is
 * in flow at all. Both went stale in the artboard import — 180 while the
 * rail became 224, and 768 while the tier boundary became 1024 — and
 * nothing anywhere went red, because every other test in this file is
 * arithmetic that is consistent with itself whatever these say.
 *
 * So they are tied to the shipped CSS here, the same way the window steps
 * are tied to heatmap.module.css above: the numbers are READ OUT of the
 * stylesheets that implement them. Neither pair can drift again without
 * this failing.
 */
describe('the nav sidebar the heatmap subtracts is the one the shell renders', () => {
  const SHELL_CSS = path.join(WEB_DIR, 'app', '_shell', 'shell.module.css');
  const NAV_CSS = path.join(WEB_DIR, 'app', '_shell', 'nav.module.css');

  it('NAV_SIDEBAR_PX is --rail-width, read out of shell.module.css', () => {
    const vars = readCssVarsByBreakpoint(SHELL_CSS, ['--rail-width']);
    expect(vars.get(0)).toEqual({ '--rail-width': NAV_SIDEBAR_PX });
  });

  it('NAV_SIDEBAR_FROM_PX is the width nav.module.css actually flips at', () => {
    const css = readFileSync(NAV_CSS, 'utf-8');
    const breakpoints = [
      ...new Set([...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]))),
    ];
    // Exactly one, so this cannot pass by finding some other query: the nav
    // has one tier boundary and that boundary is this constant.
    expect(breakpoints).toEqual([NAV_SIDEBAR_FROM_PX]);
  });

  it('the rail is what that query renders, and below it the nav is out of flow', () => {
    const css = readFileSync(NAV_CSS, 'utf-8');
    const boundary = css.indexOf(`@media (min-width: ${NAV_SIDEBAR_FROM_PX}px)`);
    expect(boundary).toBeGreaterThan(0);

    // At/above: an in-flow column exactly --rail-width wide — the thing
    // availableHeatmapWidthPx subtracts.
    expect(css.slice(boundary)).toContain('width: var(--rail-width)');

    // Below: the drawer, `position: fixed`, taking no horizontal space —
    // which is why the subtraction is conditional rather than constant.
    expect(css.slice(0, boundary)).toContain('position: fixed');
  });
});

describe('the shipped CSS implements the declared window policy', () => {
  it('heatmap.module.css declares the same steps as HEATMAP_WINDOW_STEPS', () => {
    const vars = readCssVarsByBreakpoint(path.join(WEB_DIR, 'app', 'me', 'heatmap.module.css'), [
      '--hm-window-weeks',
      '--hm-cell',
      '--hm-gap',
      '--hm-label',
    ]);

    expect([...vars.keys()]).toEqual(HEATMAP_WINDOW_STEPS.map((s) => s.minViewportWidth));

    for (const step of HEATMAP_WINDOW_STEPS) {
      expect(vars.get(step.minViewportWidth)).toEqual({
        '--hm-window-weeks': step.weeks,
        '--hm-cell': step.cellPx,
        '--hm-gap': step.gapPx,
        '--hm-label': step.labelPx,
      });
    }
  });

  it('the page hosting the heatmap declares the same gutters and max width', () => {
    // profile.module.css, not me.module.css: /me became the activity feed and
    // the heatmap lives only on the profile now. The geometry contract has to
    // follow the grid, or it describes a container the heatmap is not in —
    // which is exactly how the profile came to show 42 of its 53 columns
    // without anything failing.
    const cssPath = path.join(WEB_DIR, 'app', 'u', '[handle]', 'profile.module.css');
    const vars = readCssVarsByBreakpoint(cssPath, ['--page-gutter']);

    // Against PAGE_GUTTER_STEPS, not HEATMAP_WINDOW_STEPS: the page changes
    // its padding at the shell's breakpoints, which are not the heatmap's.
    for (const step of PAGE_GUTTER_STEPS) {
      expect(vars.get(step.minViewportWidth)).toEqual({ '--page-gutter': step.gutterPx });
    }

    expect(readFileSync(cssPath, 'utf-8')).toContain(`max-width: ${PAGE_MAX_WIDTH_PX}px`);
  });
});

describe('intensityLevel', () => {
  it('is 0 for an empty day, whatever the max', () => {
    expect(intensityLevel(0, 0)).toBe(0);
    expect(intensityLevel(0, 40)).toBe(0);
  });

  it('puts the busiest day at the top of the five-step ramp', () => {
    expect(intensityLevel(10, 10)).toBe(5);
    expect(intensityLevel(1, 1)).toBe(1);
  });

  it('spreads the range between 1 and 5 without ever hitting 0', () => {
    const levels = [1, 3, 5, 6, 10].map((c) => intensityLevel(c, 10));
    expect(levels).toEqual([1, 1, 2, 3, 5]);
    for (const level of levels) {
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(5);
    }
  });

  it('never returns more than 5 even if a count exceeds the reported max', () => {
    expect(intensityLevel(99, 3)).toBe(5);
  });
});

describe('formatDayLabel', () => {
  it('reads as a sentence, with the count first and the date spelled out', () => {
    expect(formatDayLabel('2026-08-16', 3)).toBe('3 activities on Sunday, 16 August 2026');
  });

  it('says "1 activity", not "1 activities"', () => {
    expect(formatDayLabel('2026-08-16', 1)).toBe('1 activity on Sunday, 16 August 2026');
  });

  it('names an empty day rather than leaving it unlabelled', () => {
    expect(formatDayLabel('2026-08-16', 0)).toBe('No activity on Sunday, 16 August 2026');
  });

  it('reads the date as a calendar date, not an instant — no local-timezone drift', () => {
    // `new Date('2026-01-01')` is UTC midnight, which is 31 December in every
    // western timezone. Getting this wrong shifts every label by a day for
    // half the world.
    expect(formatDayLabel('2026-01-01', 0)).toBe('No activity on Thursday, 1 January 2026');
    expect(formatDayLabel('2026-12-31', 2)).toBe('2 activities on Thursday, 31 December 2026');
  });
});

function daysFrom(start: string, count: number, counts: Record<string, number> = {}): HeatmapDay[] {
  const days: HeatmapDay[] = [];
  const base = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const date = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, count: counts[date] ?? 0 });
  }
  return days;
}

describe('buildHeatmapWeeks', () => {
  it('lays days into ISO weeks, padding the partial first and last columns', () => {
    // 2026-08-12 is a Wednesday; 2026-08-16 is a Sunday.
    const weeks = buildHeatmapWeeks(daysFrom('2026-08-12', 5), 0);

    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.cells.map((c) => c?.date ?? null)).toEqual([
      null,
      null,
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('always yields 7 rows per column so the grid stays rectangular', () => {
    const weeks = buildHeatmapWeeks(daysFrom('2026-06-03', 40), 0);
    for (const week of weeks) {
      expect(week.cells).toHaveLength(7);
    }
  });

  it('keeps every day the API sent, in order, exactly once', () => {
    const days = daysFrom('2026-06-03', 40);
    const flattened = buildHeatmapWeeks(days, 0)
      .flatMap((w) => w.cells)
      .filter((c) => c !== null)
      .map((c) => c!.date);
    expect(flattened).toEqual(days.map((d) => d.date));
  });

  it('carries the count, level and accessible label on each cell', () => {
    const days = daysFrom('2026-08-10', 7, { '2026-08-11': 4 });
    const cells = buildHeatmapWeeks(days, 4)[0]!.cells;

    expect(cells[1]).toMatchObject({ date: '2026-08-11', count: 4, level: 5 });
    expect(cells[1]!.label).toBe('4 activities on Tuesday, 11 August 2026');
    expect(cells[0]).toMatchObject({ date: '2026-08-10', count: 0, level: 0 });
  });

  it('labels a column with a month name only where the month turns over', () => {
    // Four full ISO weeks straddling the end of June 2026.
    const weeks = buildHeatmapWeeks(daysFrom('2026-06-15', 28), 0);
    expect(weeks.map((w) => w.monthLabel)).toEqual([null, null, 'Jul', null]);
  });

  it('returns nothing for an empty window rather than throwing', () => {
    expect(buildHeatmapWeeks([], 0)).toEqual([]);
  });
});
