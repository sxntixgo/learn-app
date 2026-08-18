/*
 * Chart layout math, kept out of the component so it can be tested without a
 * browser (same split as heatmap.ts — design §10/§14.3's own precedent).
 *
 * Design §6.3/§14.1 (Phase 10, Task A): a small, honest set of
 * SERVER-rendered chart kinds — bar and line — never a client charting
 * library. Everything below computes plain numbers and SVG path strings; the
 * component (Chart.tsx) only turns them into markup, so there is nothing here
 * that needs a DOM, a canvas, or JavaScript in the browser to produce a
 * correct chart.
 *
 * FORM DECISION (dataviz skill's form heuristic, design §14.1's "legible at
 * 375px"): bar charts render HORIZONTAL — category labels run down the left
 * edge and bars grow rightward — rather than vertical columns with rotated
 * x-axis labels. Rotated labels are the thing that breaks first on a 320–375px
 * screen (this repo's narrowest supported width): a rotated label either
 * collides with its neighbour or gets clipped, and a diagonal label is
 * measurably slower to read even when it fits. A horizontal bar's label runs
 * with the text's natural baseline and the list simply grows taller, which
 * costs nothing on a page that already scrolls vertically.
 *
 * The viewBox width (480) is chosen as a MOBILE-FIRST reference size, not a
 * "design at desktop and shrink" one: the chart's CSS container caps out
 * around that same width (see lesson.module.css's `.chart`), so text sized
 * for a 480-unit viewBox stays close to 1:1 scale from a 375px phone up
 * through its own max width, rather than being drawn oversized for a wide
 * desktop canvas and then shrunk illegibly small on a phone.
 */

export interface ChartDatum {
  label: string;
  value: number;
}

/** Thousands-comma'd, trimmed to at most 2 decimals — marks-and-anatomy.md's "round to clean numbers". */
export function formatChartNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

/** Truncates to at most `maxChars`, appending an ellipsis — never silently clips inside a mark (anti-patterns.md). */
export function truncateLabel(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  if (maxChars <= 1) return label.slice(0, 1);
  return `${label.slice(0, maxChars - 1)}…`;
}

/**
 * SVG path for a horizontal bar: square corners at the baseline (x), a 4px
 * rounded data-end at the tip (x + width) — the mark spec in
 * marks-and-anatomy.md ("4px rounded data-end, square at the baseline").
 * A zero-or-negative width bar (an all-zero series, or a stray negative
 * value in a magnitude chart) draws nothing rather than a malformed path.
 */
export function roundedBarPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  }
  return [
    `M ${x} ${y}`,
    `H ${x + width - r}`,
    `A ${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V ${y + height - r}`,
    `A ${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H ${x}`,
    'Z',
  ].join(' ');
}

export interface BarChartRow {
  label: string;
  truncatedLabel: string;
  value: number;
  path: string;
  valueX: number;
  textY: number;
  labelTextY: number;
}

export interface BarChartLayout {
  width: number;
  height: number;
  baselineX: number;
  rows: BarChartRow[];
}

const BAR_VIEWBOX_WIDTH = 480;
const BAR_ROW_HEIGHT = 36;
const BAR_THICKNESS = 20; // <= 24px cap, marks-and-anatomy.md
const BAR_LABEL_COL_MIN = 64;
const BAR_LABEL_COL_MAX = 160;
const BAR_VALUE_COL_WIDTH = 52;
const BAR_MARGIN = 4;
// A rough average glyph width for the label font-size used in Chart.tsx
// (11px mono-ish). Not real text measurement — a pure server render has no
// canvas to measure with — just enough to keep the label column from being
// wildly over- or under-sized. See the module doc comment.
const BAR_CHAR_WIDTH = 6.4;

/** Computes every number and path the bar-chart SVG needs. Pure — no DOM. */
export function layoutBarChart(data: ChartDatum[]): BarChartLayout {
  const width = BAR_VIEWBOX_WIDTH;
  const longestLabelChars = Math.max(1, ...data.map((d) => d.label.length));
  const labelColWidth = Math.min(
    BAR_LABEL_COL_MAX,
    Math.max(BAR_LABEL_COL_MIN, Math.ceil(longestLabelChars * BAR_CHAR_WIDTH) + 10),
  );
  const maxLabelChars = Math.max(1, Math.floor((labelColWidth - 10) / BAR_CHAR_WIDTH));

  const baselineX = BAR_MARGIN + labelColWidth;
  const barAreaWidth = Math.max(0, width - baselineX - BAR_VALUE_COL_WIDTH - BAR_MARGIN);
  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const height = data.length * BAR_ROW_HEIGHT;

  const rows = data.map((d, i) => {
    const rowTop = i * BAR_ROW_HEIGHT;
    const barY = rowTop + (BAR_ROW_HEIGHT - BAR_THICKNESS) / 2;
    const barWidth = maxValue > 0 ? (Math.max(0, d.value) / maxValue) * barAreaWidth : 0;
    return {
      label: d.label,
      truncatedLabel: truncateLabel(d.label, maxLabelChars),
      value: d.value,
      path: roundedBarPath(baselineX, barY, barWidth, BAR_THICKNESS),
      valueX: baselineX + barWidth + 8,
      textY: rowTop + BAR_ROW_HEIGHT / 2,
      labelTextY: rowTop + BAR_ROW_HEIGHT / 2,
    };
  });

  return { width, height, baselineX, rows };
}

export interface LineChartPoint {
  x: number;
  y: number;
  label: string;
  value: number;
  showLabel: boolean;
  isEndpoint: boolean;
  labelAbove: boolean;
}

export interface LineChartTick {
  y: number;
  label: string;
}

export interface LineChartLayout {
  width: number;
  height: number;
  plotTop: number;
  plotBottom: number;
  plotLeft: number;
  plotRight: number;
  linePath: string;
  points: LineChartPoint[];
  yTicks: LineChartTick[];
}

const LINE_VIEWBOX_WIDTH = 480;
const LINE_VIEWBOX_HEIGHT = 220;
const LINE_MARGIN_TOP = 16;
const LINE_MARGIN_BOTTOM = 34;
const LINE_MARGIN_LEFT = 48;
const LINE_MARGIN_RIGHT = 16;
// Minimum horizontal room (viewBox units) an x-axis category label needs
// before it risks colliding with its neighbour — see the module doc comment
// on why this is a heuristic, not real text measurement.
const MIN_LABEL_SLOT = 46;
const ENDPOINT_LABEL_MARGIN = 18;

/** 4 evenly-spaced ticks across the (possibly zero-padded) value domain. Simple by design — see the module doc comment; not a "nice round numbers" ticker. */
function valueTicks(domainMin: number, domainMax: number, count = 4): number[] {
  if (domainMin === domainMax) return [domainMin];
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(domainMin + ((domainMax - domainMin) * i) / (count - 1));
  }
  return ticks;
}

/** Computes every number, path, and tick the line-chart SVG needs. Pure — no DOM. */
export function layoutLineChart(data: ChartDatum[]): LineChartLayout {
  const width = LINE_VIEWBOX_WIDTH;
  const height = LINE_VIEWBOX_HEIGHT;
  const plotTop = LINE_MARGIN_TOP;
  const plotBottom = height - LINE_MARGIN_BOTTOM;
  const plotLeft = LINE_MARGIN_LEFT;
  const plotRight = width - LINE_MARGIN_RIGHT;
  const plotWidth = plotRight - plotLeft;

  const values = data.map((d) => d.value);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const domainMin = rawMin === rawMax ? rawMin - 1 : rawMin;
  const domainMax = rawMin === rawMax ? rawMax + 1 : rawMax;

  const yFor = (value: number): number =>
    plotBottom - ((value - domainMin) / (domainMax - domainMin)) * (plotBottom - plotTop);

  const n = data.length;
  const xFor = (i: number): number => (n <= 1 ? plotLeft + plotWidth / 2 : plotLeft + (i / (n - 1)) * plotWidth);

  // Thin x-axis labels so they never guarantee a collision at narrow widths
  // (the same "legible at 375px" concern the bar-chart form decision names) —
  // show every Nth category so consecutive shown labels keep at least
  // MIN_LABEL_SLOT of room, and always show the last one.
  const maxLabels = Math.max(1, Math.floor(plotWidth / MIN_LABEL_SLOT) + 1);
  const step = n > maxLabels ? Math.ceil(n / maxLabels) : 1;

  const points: LineChartPoint[] = data.map((d, i) => {
    const y = yFor(d.value);
    const isEndpoint = i === 0 || i === n - 1;
    return {
      x: xFor(i),
      y,
      label: d.label,
      value: d.value,
      showLabel: i % step === 0 || i === n - 1,
      isEndpoint,
      labelAbove: y - plotTop > ENDPOINT_LABEL_MARGIN,
    };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  const yTicks: LineChartTick[] = valueTicks(domainMin, domainMax).map((v) => ({
    y: yFor(v),
    label: formatChartNumber(v),
  }));

  return { width, height, plotTop, plotBottom, plotLeft, plotRight, linePath, points, yTicks };
}
