import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  HEATMAP_MAX_WEEKS,
  HEATMAP_WINDOW_STEPS,
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
  // The three widths a browser actually measured for the scroll viewport at
  // 375/834/1440 (Phase 16 follow-up, measured with the Playwright harness).
  // Pinned here so a change to the shell's sidebar or the activity card's
  // padding fails HERE, in a fast test, rather than silently shrinking the
  // window until the e2e viewport spec notices.
  it('agrees with what the browser measures for the available width', () => {
    expect(availableHeatmapWidthPx(375)).toBe(301);
    expect(availableHeatmapWidthPx(834)).toBe(564);
    expect(availableHeatmapWidthPx(1440)).toBe(1054);
  });

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
    expect(HEATMAP_WINDOW_STEPS[0]!.cellPx).toBeGreaterThanOrEqual(20);
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

  it('me.module.css declares the same page gutters and max width', () => {
    const cssPath = path.join(WEB_DIR, 'app', 'me', 'me.module.css');
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
