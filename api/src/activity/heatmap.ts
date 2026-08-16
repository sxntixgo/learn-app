// Heatmap day-window construction (design §10). Pure and DB-free: the route
// hands it a sparse Map of local-date -> count (produced by a Postgres query
// that buckets `occurred_at AT TIME ZONE $tz` — see routes/me.ts) and this
// fills in the contiguous run of days the UI renders, so it never has to
// infer a gap from a missing key.

import { addDaysToKey } from './streaks.ts';

export interface HeatmapDay {
  date: string;
  count: number;
}

export const MIN_HEATMAP_WEEKS = 1;
export const MAX_HEATMAP_WEEKS = 53;
export const DEFAULT_HEATMAP_WEEKS = 53;

/**
 * Parses and clamps the `?weeks=` query param to a sane range. Design §10:
 * "renders a trailing window sized to the viewport — roughly 13 weeks on
 * phone, 26 on tablet, 53 on desktop" — 53 is the largest any client asks
 * for, so it doubles as the ceiling; unparseable input falls back to the
 * desktop default rather than erroring, since a malformed query param on a
 * read endpoint shouldn't 400 a page that would otherwise render fine.
 */
export function clampWeeks(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_HEATMAP_WEEKS;
  const floored = Math.floor(n);
  return Math.min(MAX_HEATMAP_WEEKS, Math.max(MIN_HEATMAP_WEEKS, floored));
}

/**
 * Builds `weeks * 7` contiguous local-date entries ending on `todayKey`
 * (inclusive), reading counts from `counts` and defaulting missing days to
 * 0. Counts for dates outside the window are ignored.
 */
export function buildHeatmapDays(counts: ReadonlyMap<string, number>, weeks: number, todayKey: string): HeatmapDay[] {
  const totalDays = weeks * 7;
  const days: HeatmapDay[] = [];

  for (let i = totalDays - 1; i >= 0; i -= 1) {
    const date = addDaysToKey(todayKey, -i);
    days.push({ date, count: counts.get(date) ?? 0 });
  }

  return days;
}
