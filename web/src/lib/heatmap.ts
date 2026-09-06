/*
 * Contribution-heatmap logic, kept out of the component so it can be tested
 * without a browser (design §10, §14.3).
 *
 * The window policy lives here as data — HEATMAP_WINDOW_STEPS — and is
 * implemented in `app/u/[handle]/heatmap.module.css` as media queries (moved
 * there from `app/me/` in Phase 4 of
 * docs/plans/2026-09-02-design-import-plan.md). `heatmap.test.ts` parses that
 * CSS and asserts the two agree, so the numbers cannot drift apart.
 *
 * Why the window is chosen by CSS rather than by JavaScript: the page is
 * server-rendered, and the server does not know the viewport. Measuring it on
 * the client would mean rendering one week count for SSR and swapping to
 * another after hydration — a visible jump on exactly the device (375px) where
 * the layout is tightest. So the server always fetches the full 53 weeks and
 * the CSS decides how many are *visible* without scrolling; the rest are
 * reachable by scrolling, with no second request and no reflow.
 */

import type { HeatmapDay } from './api';

/** The largest window the API serves, and therefore what we always request. */
export const HEATMAP_MAX_WEEKS = 53;

/** Page content max width; the heatmap is a breakout block (design §14.1). */
export const PAGE_MAX_WIDTH_PX = 1160;

/**
 * The chrome between the page gutters and the heatmap's scroll viewport, in px.
 *
 * The grid does not sit directly inside the page column: it sits inside the
 * `.activity` card (app/me/me.module.css), which adds 1.25rem of padding on
 * each side plus a 1px hairline border. 2 * 20 + 2 * 1 = 42.
 *
 * This constant exists because leaving it out is precisely the bug Phase 15
 * found. `heatmap.test.ts` computed the available width as
 * `viewport - 2 * gutter` and concluded every step fitted, while a real
 * browser showed 11/21/52 columns against a declared 13/26/53. The unit test
 * was not wrong about its own arithmetic — it was arithmetic about a page
 * that does not exist.
 */
export const ACTIVITY_CARD_CHROME_PX = 42;

/**
 * Width the in-flow nav sidebar takes out of the content column, in px —
 * the wide tier's teal rail, `--rail-width` in app/_shell/shell.module.css.
 *
 * Below `NAV_SIDEBAR_FROM_PX` the nav is a drawer over the page, out of flow
 * and taking no horizontal space at all, which is what makes this a
 * step-dependent term rather than a constant subtraction.
 *
 * THESE TWO NUMBERS ARE NOT FREE TO DRIFT, and both of them did. This said
 * 180 while the rail was 224, and `NAV_SIDEBAR_FROM_PX` said 768 while the
 * tier boundary was 1024 — so `availableHeatmapWidthPx` was describing a page
 * that did not exist in either direction, which is the exact failure the
 * constant above it was written to prevent. Nothing went red, because
 * `heatmap.test.ts` was self-consistent arithmetic rather than a measurement.
 * It is not any more: that file now reads `--rail-width` out of
 * shell.module.css and the `@media (min-width: …)` boundary out of
 * nav.module.css and fails if either stops matching these.
 */
export const NAV_SIDEBAR_PX = 224;

/**
 * The viewport width from which the nav becomes an in-flow sidebar — the
 * shell's tier boundary (nav.module.css's header is its documented home).
 */
export const NAV_SIDEBAR_FROM_PX = 1024;

/**
 * Horizontal page padding, one side, by the viewport width it applies from —
 * `--page-gutter` in app/me/me.module.css.
 *
 * These are the PAGE's breakpoints (768/1200, the shell's), deliberately kept
 * separate from HEATMAP_WINDOW_STEPS' own (0/834/1360). Conflating the two is
 * the modelling error underneath the overflow bug: `gutterPx` used to be a
 * field on the heatmap step, which silently asserted that the page changed its
 * padding at exactly the widths the heatmap changed its column count. It never
 * did, and once the heatmap's steps had to move to widths where they actually
 * fit, the two could not be the same list.
 */
export const PAGE_GUTTER_STEPS: readonly { minViewportWidth: number; gutterPx: number }[] = [
  { minViewportWidth: 0, gutterPx: 16 },
  { minViewportWidth: 768, gutterPx: 24 },
  { minViewportWidth: 1200, gutterPx: 32 },
];

/** The page gutter in effect at `viewportWidth`, one side, in px. */
export function pageGutterForWidth(viewportWidth: number): number {
  let chosen = PAGE_GUTTER_STEPS[0]!;
  for (const step of PAGE_GUTTER_STEPS) {
    if (viewportWidth >= step.minViewportWidth) chosen = step;
  }
  return chosen.gutterPx;
}

/**
 * The width actually available to the heatmap's scroll viewport at
 * `viewportWidth` — the number `windowWidthPx(step)` has to fit inside.
 *
 * 834 gained 180px when the tier boundary moved to 1024: iPad portrait is
 * the narrow tier now, so the rail it used to subtract is not rendered there.
 *
 * IT IS DELIBERATELY CONSERVATIVE, and measurement is what says by how much.
 * The heatmap's containing block on the profile measures 343 / 786 / 922 /
 * 1112 at 375 / 834 / 1194 / 1440 (Chromium, this build) against the 301 /
 * 744 / 880 / 1054 this function returns. Two terms account for the gap, and
 * both are the same shape as the sidebar constants above — a number that
 * outlived the page it described:
 *
 *   - ACTIVITY_CARD_CHROME_PX (42) is `/me`'s `.activity` card. The heatmap
 *     moved to the profile, where `.figure` sits directly in `.section` with
 *     no card padding and no border at all.
 *   - PAGE_GUTTER_STEPS' 1200px step (32px) does not take effect on the
 *     profile: `main.page` measures a 24px gutter at 1440, not 32.
 *
 * Both make this UNDER-state the room available, so no declared window can
 * overflow because of them, and `heatmap.test.ts` pins the model against
 * those measurements so it can never start over-stating instead. Correcting
 * them is a separate change with a real consequence — more room means the
 * window steps could widen — and is not part of the sidebar fix.
 */
export function availableHeatmapWidthPx(viewportWidth: number): number {
  const sidebar = viewportWidth >= NAV_SIDEBAR_FROM_PX ? NAV_SIDEBAR_PX : 0;
  const contentColumn = Math.min(viewportWidth - sidebar, PAGE_MAX_WIDTH_PX);
  return contentColumn - 2 * pageGutterForWidth(viewportWidth) - ACTIVITY_CARD_CHROME_PX;
}

export interface HeatmapWindowStep {
  /** Applies from this viewport width up, until the next step. */
  minViewportWidth: number;
  /** Weeks visible without scrolling. */
  weeks: number;
  /** Cell edge in px — square. */
  cellPx: number;
  /** Gap between cells in px. */
  gapPx: number;
  /** Width reserved for the sticky weekday-label column. */
  labelPx: number;
}

/**
 * Design §10: "roughly 13 weeks on phone, 26 on tablet, 53 on desktop".
 * Cells get *smaller* as the viewport grows, because that is what lets a full
 * year fit on a desktop while keeping a tappable target on a phone, where
 * there is no hover to fall back on (design §14.2).
 */
export const HEATMAP_WINDOW_STEPS: readonly HeatmapWindowStep[] = [
  // Phone: 12 weeks, not 13. §10 says "roughly 13 weeks" and 12 is still a
  // quarter, which is what that number is for — and the alternative, at the
  // 301px a 375px phone actually leaves, is a 1px gap between cells. A grid
  // whose cells nearly touch reads as one block, and the day cell is the
  // whole point on the screen with no hover to fall back on (§14.2).
  //
  // labelPx is 25, not 0. The previous 0 described an intent the CSS never
  // achieved: the weekday `th` still lays out to its text's min-content
  // width (24.39px measured), so declaring 0 silently overstated the room
  // for cells by a full column. 25 rather than 24 because the th cannot go
  // BELOW its min-content width — declaring 24 leaves the label 0.39px wider
  // than the reserved space, and that fraction costs a whole column.
  { minViewportWidth: 0, weeks: 12, cellPx: 18, gapPx: 2, labelPx: 25 },
  // Tablet: from 834, NOT from the nav's own 768 breakpoint. 26 weeks needs
  // ~530px and 768px only leaves 498 once the sidebar and card are taken out,
  // so a step starting at 768 could never honour its own number — it was
  // overflowing from its first pixel. 834 is also the iPad portrait width
  // this design is aimed at (§14.2). 26 * (16 + 3) + 36 = 530 against 564.
  { minViewportWidth: 834, weeks: 26, cellPx: 14, gapPx: 3, labelPx: 36 },
  // iPad landscape: PL9/P9's own drawn figure — "LAST 48 WEEKS"
  // (docs/design/2026-09-02-artboard-spec.md §4) — which is the WIDE
  // TIER's figure, not a fixed one: it is simply what 48 weeks at this cell
  // size needs, the same derivation as every other step here. From 1194,
  // NOT the shell's 1024: at 1024 the rail has just taken 224px and 48
  // weeks needs ~852px against the 710px available there, so — same
  // reasoning as the tablet step above — the step can only start where it
  // actually fits. 48 * (14 + 3) + 36 = 852 against 880 available.
  { minViewportWidth: 1194, weeks: 48, cellPx: 14, gapPx: 3, labelPx: 36 },
  // Desktop: from 1360, for the same reason — 53 weeks needs ~1043px, and
  // below 1340 the content column has not yet reached the 1160px cap that
  // makes that possible. The full year is the promise that actually matters,
  // so the step waits until it can keep it. 53 * (16 + 3) + 36 = 1043
  // against 1054 available.
  { minViewportWidth: 1360, weeks: 53, cellPx: 14, gapPx: 3, labelPx: 36 },
];

/** The step that applies at `viewportWidth`. */
export function heatmapWindowForWidth(viewportWidth: number): HeatmapWindowStep {
  let chosen = HEATMAP_WINDOW_STEPS[0]!;
  for (const step of HEATMAP_WINDOW_STEPS) {
    if (viewportWidth >= step.minViewportWidth) chosen = step;
  }
  return chosen;
}

/** Weeks visible without scrolling at `viewportWidth`. */
export function visibleWeeksForWidth(viewportWidth: number): number {
  return heatmapWindowForWidth(viewportWidth).weeks;
}

/** Rendered width of the scroll viewport for a step, in px. */
export function windowWidthPx(step: HeatmapWindowStep): number {
  return step.labelPx + step.weeks * (step.cellPx + step.gapPx);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Weekday rows, ISO order: weeks start on Monday. */
export const WEEKDAY_ROWS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Which weekday rows carry a visible label; the rest are label-less but still
 * announced, exactly as GitHub's grid does — a label on all seven is noise. */
export const LABELLED_WEEKDAY_ROWS: ReadonlySet<string> = new Set(['Monday', 'Wednesday', 'Friday']);

/**
 * Parses a `YYYY-MM-DD` calendar date as UTC. Never `new Date(key)` against
 * the local zone: the API's day keys are already bucketed in the user's
 * timezone (design §15), so re-interpreting them locally would shift every
 * label by a day for anyone west of Greenwich.
 */
function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** 0 = Monday … 6 = Sunday. */
function isoWeekdayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/**
 * Maps a day's count onto the five-step ramp (0..4 — see tokens.css's
 * `--color-heat-0`..`--color-heat-4`; `--color-heat-5` was a deprecated
 * duplicate of step 4, retired once this component moved to the profile in
 * Phase 4 of docs/plans/2026-09-02-design-import-plan.md), relative to the
 * busiest day in the window. 0 is its own state — the empty cell is
 * deliberately not step one (design §10), or a quiet week reads as a dead
 * grid. Any activity at all is at least step one, and the busiest day is
 * always step four, so the ramp is used in full whenever there is any
 * variation to show.
 */
export function intensityLevel(count: number, maxCount: number): number {
  if (count <= 0) return 0;
  const span = Math.max(1, maxCount - 1);
  const level = 1 + Math.floor(((count - 1) / span) * 3);
  return Math.min(4, Math.max(1, level));
}

/**
 * The one string that carries a cell's meaning to assistive tech, to a
 * `title`, and to the tap-to-read detail line. A colour-only scale is
 * unreadable for a significant number of people (design §10), so the exact
 * count and the full date are always available as text.
 */
export function formatDayLabel(date: string, count: number): string {
  const d = parseDayKey(date);
  const when = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (count === 0) return `No activity on ${when}`;
  if (count === 1) return `1 activity on ${when}`;
  return `${count} activities on ${when}`;
}

export interface HeatmapCell {
  date: string;
  count: number;
  /** 0 (empty) … 5 (busiest), for the --color-heat-N tokens. */
  level: number;
  label: string;
}

export interface HeatmapWeek {
  /** The column's Monday, `YYYY-MM-DD`, even when that day is padding. */
  startDate: string;
  /** Short month name where the month turns over in this column, else null. */
  monthLabel: string | null;
  /** Seven rows, Monday first; null is padding outside the requested window. */
  cells: Array<HeatmapCell | null>;
}

/**
 * Folds the API's flat, contiguous, zero-filled day list into week columns.
 * The first and last columns are partial (the window ends on today, not on a
 * Sunday), so they are padded with nulls to keep the grid rectangular.
 */
export function buildHeatmapWeeks(days: readonly HeatmapDay[], maxCount: number): HeatmapWeek[] {
  const first = days[0];
  if (!first) return [];

  const firstDate = parseDayKey(first.date);
  const leadingPad = isoWeekdayIndex(firstDate);
  const gridStart = addDays(firstDate, -leadingPad);

  const weeks: HeatmapWeek[] = [];
  let previousMonth = -1;

  for (let offset = 0; offset < leadingPad + days.length; offset += 7) {
    const cells: Array<HeatmapCell | null> = [];
    for (let row = 0; row < 7; row += 1) {
      const dayIndex = offset + row - leadingPad;
      const day = dayIndex >= 0 ? days[dayIndex] : undefined;
      cells.push(
        day
          ? {
              date: day.date,
              count: day.count,
              level: intensityLevel(day.count, maxCount),
              label: formatDayLabel(day.date, day.count),
            }
          : null
      );
    }

    const monday = addDays(gridStart, offset);
    // A column belongs to the month of its Thursday (the ISO rule), so a
    // column that straddles a month boundary is labelled with the month it
    // mostly covers rather than the one it merely starts in.
    const month = addDays(monday, 3).getUTCMonth();
    const turnsOver = weeks.length > 0 && month !== previousMonth;
    previousMonth = month;

    weeks.push({
      startDate: dayKey(monday),
      monthLabel: turnsOver ? MONTHS[month]!.slice(0, 3) : null,
      cells,
    });
  }

  return weeks;
}
