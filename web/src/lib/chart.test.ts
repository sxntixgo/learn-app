import { describe, expect, it } from 'vitest';
import {
  formatChartNumber,
  layoutBarChart,
  layoutLineChart,
  roundedBarPath,
  truncateLabel,
} from './chart.ts';

describe('formatChartNumber', () => {
  it('adds thousands commas', () => {
    expect(formatChartNumber(1284)).toBe('1,284');
  });

  it('trims to at most 2 decimals', () => {
    expect(formatChartNumber(3.14159)).toBe('3.14');
  });

  it('renders a whole number with no trailing decimal', () => {
    expect(formatChartNumber(5)).toBe('5');
  });

  it('renders negative numbers', () => {
    expect(formatChartNumber(-2.5)).toBe('-2.5');
  });
});

describe('truncateLabel', () => {
  it('leaves a short label untouched', () => {
    expect(truncateLabel('Agents', 20)).toBe('Agents');
  });

  it('truncates a long label with an ellipsis, never exceeding maxChars', () => {
    const result = truncateLabel('A very long category label indeed', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles maxChars of 1', () => {
    expect(truncateLabel('Agents', 1)).toBe('A');
  });
});

describe('roundedBarPath', () => {
  it('produces an SVG path string for a normal bar', () => {
    const path = roundedBarPath(10, 10, 100, 20, 4);
    expect(path).toMatch(/^M 10 10/);
    expect(path).toContain('A 4 4 0 0 1');
    expect(path.trim().endsWith('Z')).toBe(true);
  });

  it('returns an empty string for a zero-width bar rather than a malformed path', () => {
    expect(roundedBarPath(10, 10, 0, 20)).toBe('');
  });

  it('returns an empty string for a negative width', () => {
    expect(roundedBarPath(10, 10, -5, 20)).toBe('');
  });

  it('caps the radius so it never exceeds half the width or height', () => {
    const path = roundedBarPath(0, 0, 6, 6, 4);
    // radius should be capped to 3 (half of 6), not the requested 4
    expect(path).toContain('A 3 3 0 0 1');
  });

  it('draws a plain rectangle (no arcs) when radius resolves to 0', () => {
    const path = roundedBarPath(0, 0, 10, 10, 0);
    expect(path).not.toContain('A');
    expect(path).toContain('H 10');
  });
});

describe('layoutBarChart', () => {
  const data = [
    { label: 'MCP servers', value: 5 },
    { label: 'Agents', value: 6 },
  ];

  it('produces one row per datum, in order', () => {
    const layout = layoutBarChart(data);
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows.map((r) => r.label)).toEqual(['MCP servers', 'Agents']);
  });

  it('scales bar length proportionally to the max value', () => {
    const layout = layoutBarChart(data);
    const [first, second] = layout.rows;
    // second (value 6) is the max, so its bar should be longer than the first (value 5)
    const firstWidth = extractBarWidth(first!.path);
    const secondWidth = extractBarWidth(second!.path);
    expect(secondWidth).toBeGreaterThan(firstWidth);
    expect(secondWidth).toBeGreaterThan(0);
  });

  it('gives the longest-value datum a bar that reaches the full bar area', () => {
    const layout = layoutBarChart([{ label: 'a', value: 10 }]);
    const width = extractBarWidth(layout.rows[0]!.path);
    expect(width).toBeGreaterThan(0);
  });

  it('handles an all-zero series without dividing by zero', () => {
    const layout = layoutBarChart([
      { label: 'a', value: 0 },
      { label: 'b', value: 0 },
    ]);
    expect(layout.rows.every((r) => r.path === '')).toBe(true);
  });

  it('handles a single datum', () => {
    const layout = layoutBarChart([{ label: 'solo', value: 3 }]);
    expect(layout.rows).toHaveLength(1);
  });

  it('grows the label column for a long label but caps it', () => {
    const shortLayout = layoutBarChart([{ label: 'a', value: 1 }]);
    const longLayout = layoutBarChart([{ label: 'a'.repeat(200), value: 1 }]);
    expect(longLayout.baselineX).toBeGreaterThan(shortLayout.baselineX);
    // The long label's baselineX should be capped, not grow unbounded.
    expect(longLayout.baselineX).toBeLessThan(200);
  });

  it('truncates a very long label rather than letting it overflow', () => {
    const layout = layoutBarChart([{ label: 'a'.repeat(200), value: 1 }]);
    expect(layout.rows[0]!.truncatedLabel.length).toBeLessThan(200);
    expect(layout.rows[0]!.truncatedLabel.endsWith('…')).toBe(true);
    // The full label is preserved separately for the accessible table/title.
    expect(layout.rows[0]!.label).toBe('a'.repeat(200));
  });
});

function extractBarWidth(path: string): number {
  if (path === '') return 0;
  const mMatch = /^M ([\d.]+)/.exec(path);
  const startX = mMatch ? Number(mMatch[1]) : 0;
  const hMatches = [...path.matchAll(/H ([\d.]+)/g)].map((m) => Number(m[1]));
  if (hMatches.length === 0) return 0;
  return Math.max(...hMatches) - startX;
}

describe('layoutLineChart', () => {
  const data = [
    { label: 'Week 1', value: 5 },
    { label: 'Week 2', value: 9 },
    { label: 'Week 3', value: 14 },
  ];

  it('produces one point per datum, in order', () => {
    const layout = layoutLineChart(data);
    expect(layout.points).toHaveLength(3);
    expect(layout.points.map((p) => p.label)).toEqual(['Week 1', 'Week 2', 'Week 3']);
  });

  it('places points left to right in increasing x', () => {
    const layout = layoutLineChart(data);
    expect(layout.points[0]!.x).toBeLessThan(layout.points[1]!.x);
    expect(layout.points[1]!.x).toBeLessThan(layout.points[2]!.x);
  });

  it('places a higher value at a smaller y (SVG y grows downward)', () => {
    const layout = layoutLineChart(data);
    expect(layout.points[2]!.y).toBeLessThan(layout.points[0]!.y);
  });

  it('always shows the label on the first and last point', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Point ${i}`, value: i }));
    const layout = layoutLineChart(many);
    expect(layout.points[0]!.showLabel).toBe(true);
    expect(layout.points.at(-1)!.showLabel).toBe(true);
  });

  it('thins labels so not every point shows one when there are many points', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Point ${i}`, value: i }));
    const layout = layoutLineChart(many);
    const shown = layout.points.filter((p) => p.showLabel).length;
    expect(shown).toBeLessThan(30);
  });

  it('shows every label when there are few points', () => {
    const layout = layoutLineChart(data);
    expect(layout.points.every((p) => p.showLabel)).toBe(true);
  });

  it('marks the first and last point as endpoints', () => {
    const layout = layoutLineChart(data);
    expect(layout.points[0]!.isEndpoint).toBe(true);
    expect(layout.points.at(-1)!.isEndpoint).toBe(true);
    expect(layout.points[1]!.isEndpoint).toBe(false);
  });

  it('builds a line path with one segment per point', () => {
    const layout = layoutLineChart(data);
    expect(layout.linePath.startsWith('M')).toBe(true);
    expect(layout.linePath.match(/L /g)?.length).toBe(2);
  });

  it('handles a single point without dividing by zero', () => {
    const layout = layoutLineChart([{ label: 'solo', value: 3 }]);
    expect(layout.points).toHaveLength(1);
    expect(Number.isFinite(layout.points[0]!.x)).toBe(true);
    expect(Number.isFinite(layout.points[0]!.y)).toBe(true);
  });

  it('handles an all-equal series without a zero-width domain', () => {
    const layout = layoutLineChart([
      { label: 'a', value: 5 },
      { label: 'b', value: 5 },
    ]);
    expect(layout.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('produces 4 y-axis ticks for a non-degenerate domain', () => {
    const layout = layoutLineChart(data);
    expect(layout.yTicks).toHaveLength(4);
  });

  it('handles negative values (domain extends below zero)', () => {
    const layout = layoutLineChart([
      { label: 'a', value: -3 },
      { label: 'b', value: 4 },
    ]);
    expect(layout.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });
});
