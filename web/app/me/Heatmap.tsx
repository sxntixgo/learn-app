'use client';

/*
 * The contribution heatmap (design §10).
 *
 * Three decisions worth knowing before editing:
 *
 * 1. The visible window is chosen by CSS, not by measuring the viewport in
 *    JavaScript — see src/lib/heatmap.ts. The server renders all 53 weeks and
 *    the scroll viewport is 13 / 26 / 53 weeks wide by breakpoint, so 375px is
 *    correct on first paint and nothing moves at hydration.
 *
 * 2. The scroller starts at the most recent week because it is `direction:
 *    rtl` (the inner rail restores `ltr`), so the browser's own initial scroll
 *    position is the right-hand edge. No scroll-on-mount effect, which means
 *    the current week is already in view in the server-rendered HTML rather
 *    than after a post-hydration jump.
 *
 * 3. Nothing here is hover-only (design §14.2 — hover does not exist on an
 *    iPad). Tapping or focusing a cell writes its exact count and date into a
 *    live readout under the grid; `title` is a convenience for pointer users,
 *    never the only route to the information.
 */

import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HeatmapDay } from '../../src/lib/api';
import { LABELLED_WEEKDAY_ROWS, WEEKDAY_ROWS, buildHeatmapWeeks } from '../../src/lib/heatmap';
import styles from './heatmap.module.css';

const LEVELS = [0, 1, 2, 3, 4, 5] as const;

export interface HeatmapProps {
  days: HeatmapDay[];
  maxCount: number;
}

export default function Heatmap({ days, maxCount }: HeatmapProps) {
  const weeks = useMemo(() => buildHeatmapWeeks(days, maxCount), [days, maxCount]);
  const dayIndex = useMemo(() => new Map(days.map((d, i) => [d.date, i])), [days]);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());

  // The window ends on today, so the last day is today. It is the sensible
  // resting selection: the readout says something true before any interaction.
  const todayKey = days.at(-1)?.date ?? '';
  const [selected, setSelected] = useState(todayKey);

  const selectedCell = useMemo(
    () => weeks.flatMap((w) => w.cells).find((c) => c?.date === selected) ?? null,
    [weeks, selected]
  );

  if (weeks.length === 0) {
    return <p className={styles.empty}>No activity recorded yet.</p>;
  }

  /** Roving tabindex + arrow keys: one tab stop for a 371-cell grid. */
  function onKeyDown(event: KeyboardEvent<HTMLTableSectionElement>) {
    const from = dayIndex.get(selected);
    if (from === undefined) return;

    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    let to: number | undefined;
    if (step !== undefined) to = from + step;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = days.length - 1;
    if (to === undefined) return;

    event.preventDefault();
    const target = days[Math.min(days.length - 1, Math.max(0, to))];
    if (!target) return;
    setSelected(target.date);
    cellRefs.current.get(target.date)?.focus();
  }

  const scaleLabel =
    maxCount > 0
      ? `Colour scale: no activity, then five steps of increasing activity up to ${maxCount} on the busiest day.`
      : 'Colour scale: no activity, then five steps of increasing activity.';

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        Activity, last {weeks.length} weeks
        <span className={styles.captionHint}> — scroll back, or use the arrow keys</span>
      </figcaption>

      <div className={styles.scroller}>
        <div className={styles.rail}>
          <div className={styles.monthStrip} aria-hidden="true">
            <span className={styles.monthSpacer} />
            {weeks.map((week) => (
              <span key={week.startDate} className={styles.monthCell}>
                {week.monthLabel}
              </span>
            ))}
          </div>

          <table className={styles.grid} role="grid" aria-label={`Activity heatmap, ${weeks.length} weeks ending today`}>
            <tbody onKeyDown={onKeyDown}>
              {WEEKDAY_ROWS.map((weekday, row) => (
                <tr key={weekday}>
                  <th scope="row" className={styles.weekdayHead}>
                    <span className={LABELLED_WEEKDAY_ROWS.has(weekday) ? styles.weekdayText : styles.srOnly}>
                      {LABELLED_WEEKDAY_ROWS.has(weekday) ? weekday.slice(0, 3) : weekday}
                    </span>
                  </th>
                  {weeks.map((week) => {
                    const cell = week.cells[row];
                    if (!cell) {
                      return <td key={week.startDate} className={styles.pad} aria-hidden="true" />;
                    }
                    return (
                      <td
                        key={week.startDate}
                        ref={(node) => {
                          if (node) cellRefs.current.set(cell.date, node);
                          else cellRefs.current.delete(cell.date);
                        }}
                        className={styles.cell}
                        data-level={cell.level}
                        data-today={cell.date === todayKey ? 'true' : undefined}
                        tabIndex={cell.date === selected ? 0 : -1}
                        aria-selected={cell.date === selected}
                        aria-label={cell.label}
                        title={cell.label}
                        onClick={(event) => {
                          setSelected(cell.date);
                          event.currentTarget.focus();
                        }}
                        onFocus={() => setSelected(cell.date)}
                      >
                        <span className={styles.swatch} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className={styles.readout} role="status">
        {selectedCell?.label ?? ''}
      </p>

      <div className={styles.legend} role="img" aria-label={scaleLabel}>
        <span className={styles.legendText} aria-hidden="true">
          None
        </span>
        {LEVELS.map((level) => (
          <span key={level} className={styles.legendSwatch} data-level={level} aria-hidden="true" />
        ))}
        <span className={styles.legendText} aria-hidden="true">
          More
        </span>
      </div>
    </figure>
  );
}
