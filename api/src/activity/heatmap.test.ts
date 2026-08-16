import { describe, it, expect } from 'vitest';
import { buildHeatmapDays, clampWeeks, DEFAULT_HEATMAP_WEEKS, MAX_HEATMAP_WEEKS, MIN_HEATMAP_WEEKS } from './heatmap.ts';

describe('clampWeeks', () => {
  it('defaults when absent or not a number', () => {
    expect(clampWeeks(undefined)).toBe(DEFAULT_HEATMAP_WEEKS);
    expect(clampWeeks('not-a-number')).toBe(DEFAULT_HEATMAP_WEEKS);
    expect(clampWeeks(Number.NaN)).toBe(DEFAULT_HEATMAP_WEEKS);
  });

  it('clamps below the minimum up to it', () => {
    expect(clampWeeks(0)).toBe(MIN_HEATMAP_WEEKS);
    expect(clampWeeks(-5)).toBe(MIN_HEATMAP_WEEKS);
  });

  it('clamps above the maximum down to it', () => {
    expect(clampWeeks(999)).toBe(MAX_HEATMAP_WEEKS);
  });

  it('passes through a sane in-range value', () => {
    expect(clampWeeks(13)).toBe(13);
    expect(clampWeeks('26')).toBe(26);
  });

  it('floors a fractional value', () => {
    expect(clampWeeks(4.9)).toBe(4);
  });
});

describe('buildHeatmapDays', () => {
  it('returns a contiguous run ending on todayKey, zero-filling days with no counts', () => {
    const counts = new Map([
      ['2026-02-01', 3],
      ['2026-02-03', 1],
    ]);
    // weeks=1 -> 7 days ending 2026-02-04, i.e. 2026-01-29..2026-02-04.
    const days = buildHeatmapDays(counts, 1, '2026-02-04');

    expect(days.map((d) => d.date)).toEqual([
      '2026-01-29',
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
      '2026-02-03',
      '2026-02-04',
    ]);
    expect(days).toEqual([
      { date: '2026-01-29', count: 0 },
      { date: '2026-01-30', count: 0 },
      { date: '2026-01-31', count: 0 },
      { date: '2026-02-01', count: 3 },
      { date: '2026-02-02', count: 0 },
      { date: '2026-02-03', count: 1 },
      { date: '2026-02-04', count: 0 },
    ]);
  });

  it('produces exactly weeks * 7 days', () => {
    const days = buildHeatmapDays(new Map(), 2, '2026-02-04');
    expect(days).toHaveLength(14);
    expect(days[0]!.date).toBe('2026-01-22');
    expect(days[13]!.date).toBe('2026-02-04');
  });

  it('ignores counts outside the requested window', () => {
    const counts = new Map([['2026-01-01', 99]]);
    const days = buildHeatmapDays(counts, 1, '2026-02-04');
    expect(days.every((d) => d.count === 0)).toBe(true);
  });
});
