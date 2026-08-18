/*
 * The `chart` block (design §6.3/§14.1, Phase 10 Task A).
 *
 * SERVER-RENDERED SVG, not a client charting library: this is a plain
 * function component with no "use client" directive, so the markup below is
 * exactly what the server sends — no script runs to draw it, which matters
 * twice over here. The CSP (design §16) is `script-src` nonce-only, so a
 * client charting library that injects inline `<script>` would simply be
 * blocked; and a lesson must still be readable with JavaScript disabled.
 *
 * COLOUR: marks are filled with `var(--color-track-blue)` — slot 1 of the
 * five-hue OKLCH-sibling track ramp (docs/design/track-hues.md), resolved by
 * the browser from tokens.css exactly like every other track hue, so light
 * and dark mode both work with zero chart-specific CSS. This reads as a
 * deliberate tension with design §14.1's "track hues appear only as a
 * structural accent ... never as a fill": that rule governs the CHROME a
 * track hue already had a job in (a TOC left-edge rule, a chip border). A
 * bar or line mark has no non-fill/non-stroke form — "a chart is fill" is
 * the explicit carve-out for this new block type, and palette rule 1 (never
 * the yellow) is what the carve-out is bounded by: the track ramp, not the
 * one-yellow accent, supplies chart colour.
 *
 * Every chart in this phase is a single series (design §6.3's example: one
 * flat list of {label, value} rows, no per-row series key). Per the dataviz
 * skill's colour formula, a single series is NOMINAL categorical — "each bar
 * takes the same slot-1 hue" — so there is one flat colour throughout and no
 * legend (a legend box with one swatch would just restate the caption). A
 * sequential (multi-step) ramp is deliberately NOT built here: nothing in
 * bar/line encodes magnitude BY colour (magnitude is bar length / line
 * height), so there is no ramp for it to drive — see choosing-a-form.md's
 * "sequential is for when colour itself carries a gradient of magnitude"
 * versus this block's marks, which never do that.
 *
 * ACCESSIBILITY: no hover-only affordance exists anywhere (design §14.2 —
 * hover does not exist on an iPad), so this does NOT ship a hover tooltip
 * layer. Every value is reachable three ways that all work without a
 * pointer: the visible axis/end labels, each mark's native SVG <title>
 * (screen-reader and mouse-hover accessible, but never the ONLY route), and
 * a `<details>` disclosure holding the exact values as a real HTML table —
 * native, keyboard- and tap-operable, zero JavaScript. That table is the
 * chart's WCAG-clean equivalent the dataviz skill's anti-patterns.md calls
 * for ("no table view / colour-only encoding on a continuous scale").
 */

import { formatChartNumber, layoutBarChart, layoutLineChart } from '../../../../../src/lib/chart';
import type { ChartDatum } from '../../../../../src/lib/chart';
import styles from './lesson.module.css';

export interface ChartProps {
  kind: string;
  caption: string;
  data: ChartDatum[];
}

export default function Chart({ kind, caption, data }: ChartProps) {
  const titleId = `chart-title-${slug(caption)}`;

  return (
    <figure className={styles.chart}>
      {kind === 'line' ? (
        <LineChartSvg data={data} caption={caption} titleId={titleId} />
      ) : (
        <BarChartSvg data={data} caption={caption} titleId={titleId} />
      )}
      <figcaption className={styles.chartCaption}>{caption}</figcaption>
      <DataTable data={data} />
    </figure>
  );
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function DataTable({ data }: { data: ChartDatum[] }) {
  return (
    <details className={styles.chartTable}>
      <summary>Show as a table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{formatChartNumber(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function BarChartSvg({ data, caption, titleId }: { data: ChartDatum[]; caption: string; titleId: string }) {
  const layout = layoutBarChart(data);
  return (
    <svg
      className={styles.chartSvg}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>{caption}</title>
      {/* Baseline hairline — every bar grows from here (marks-and-anatomy.md). */}
      <line
        x1={layout.baselineX}
        y1={0}
        x2={layout.baselineX}
        y2={layout.height}
        className={styles.chartAxisLine}
      />
      {layout.rows.map((row) => (
        <g key={row.label}>
          <text x={layout.baselineX - 8} y={row.labelTextY} className={styles.chartRowLabel}>
            {row.truncatedLabel}
            {row.truncatedLabel !== row.label ? <title>{row.label}</title> : null}
          </text>
          {row.path ? (
            <path d={row.path} className={styles.chartBar}>
              {/* A single string child, not `{a}: {b}` — React's <title>
                  only accepts one text child; an array of children (even
                  all-text) renders as an EMPTY title, silently dropping the
                  accessible name. See roundedBarPath's sibling <title>s
                  below for the same fix. */}
              <title>{`${row.label}: ${formatChartNumber(row.value)}`}</title>
            </path>
          ) : null}
          <text x={row.valueX} y={row.textY} className={styles.chartValueLabel}>
            {formatChartNumber(row.value)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function LineChartSvg({ data, caption, titleId }: { data: ChartDatum[]; caption: string; titleId: string }) {
  const layout = layoutLineChart(data);
  return (
    <svg
      className={styles.chartSvg}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>{caption}</title>

      {layout.yTicks.map((tick) => (
        <g key={tick.y}>
          <line
            x1={layout.plotLeft}
            y1={tick.y}
            x2={layout.plotRight}
            y2={tick.y}
            className={styles.chartGridline}
          />
          <text x={layout.plotLeft - 8} y={tick.y} className={styles.chartYTickLabel}>
            {tick.label}
          </text>
        </g>
      ))}

      <path d={layout.linePath} className={styles.chartLine} />

      {layout.points.map((point) => (
        <g key={point.label}>
          {/* Surface ring (marks-and-anatomy.md): an outer circle in the page
              colour separates the marker from the line/gridlines it sits on. */}
          <circle cx={point.x} cy={point.y} r={6} className={styles.chartPointRing} />
          <circle cx={point.x} cy={point.y} r={4} className={styles.chartPoint}>
            <title>{`${point.label}: ${formatChartNumber(point.value)}`}</title>
          </circle>
          {point.isEndpoint ? (
            <text
              x={point.x}
              y={point.labelAbove ? point.y - 10 : point.y + 16}
              textAnchor={point.x <= layout.plotLeft + 4 ? 'start' : point.x >= layout.plotRight - 4 ? 'end' : 'middle'}
              className={styles.chartValueLabel}
            >
              {formatChartNumber(point.value)}
            </text>
          ) : null}
          {point.showLabel ? (
            <text x={point.x} y={layout.plotBottom + 18} textAnchor="middle" className={styles.chartXTickLabel}>
              {point.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
