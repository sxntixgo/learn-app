/*
 * Contribution-heatmap logic, kept out of the component so it can be tested
 * without a browser (design §10, §14.3).
 *
 * The window policy lives here as data — HEATMAP_WINDOW_STEPS — and is
 * implemented in `app/me/heatmap.module.css` as media queries. `heatmap.test.ts`
 * parses that CSS and asserts the two agree, so the numbers cannot drift apart.
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

export interface HeatmapWindowStep {
  /** Applies from this viewport width up, until the next step. */
  minViewportWidth: number;
  /** Weeks visible without scrolling. */
  weeks: number;
  /** Cell edge in px — square. */
  cellPx: number;
  /** Gap between cells in px. */
  gapPx: number;
  /** Width reserved for the sticky weekday-label column (0 = collapsed). */
  labelPx: number;
  /** Horizontal page padding at this step, one side. */
  gutterPx: number;
}

/**
 * Design §10: "roughly 13 weeks on phone, 26 on tablet, 53 on desktop".
 * Cells get *smaller* as the viewport grows, because that is what lets a full
 * year fit on a desktop while keeping a tappable target on a phone, where
 * there is no hover to fall back on (design §14.2).
 */
export const HEATMAP_WINDOW_STEPS: readonly HeatmapWindowStep[] = [
  { minViewportWidth: 0, weeks: 13, cellPx: 22, gapPx: 4, labelPx: 0, gutterPx: 16 },
  { minViewportWidth: 768, weeks: 26, cellPx: 22, gapPx: 4, labelPx: 36, gutterPx: 24 },
  { minViewportWidth: 1200, weeks: 53, cellPx: 16, gapPx: 4, labelPx: 36, gutterPx: 32 },
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
 * Maps a day's count onto the five-step ramp, relative to the busiest day in
 * the window. 0 is its own state — the empty cell is deliberately not step one
 * (design §10), or a quiet week reads as a dead grid. Any activity at all is
 * at least step one, and the busiest day is always step five, so the ramp is
 * used in full whenever there is any variation to show.
 */
export function intensityLevel(count: number, maxCount: number): number {
  if (count <= 0) return 0;
  const span = Math.max(1, maxCount - 1);
  const level = 1 + Math.floor(((count - 1) / span) * 4);
  return Math.min(5, Math.max(1, level));
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
