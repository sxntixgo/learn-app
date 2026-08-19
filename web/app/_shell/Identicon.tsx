/*
 * The generated avatar (design §11.1). A server component: nothing here is
 * interactive, and the SVG is deterministic from the seed, so it renders
 * once on the server and never moves at hydration.
 *
 * Inline SVG rather than an <img>: no request, no cache entry, no third
 * party, and the fill is a design token, so the face follows a palette swap
 * and both themes for free.
 */

import { IDENTICON_SIZE, identiconCells, identiconColor } from '../../src/lib/identicon';
import styles from './identicon.module.css';

export interface IdenticonProps {
  /** The API's one-way hash of the user id (never the id itself). */
  seed: string;
  /** Rendered size in px. The grid scales; the SVG viewBox does not change. */
  size?: number;
  /**
   * Who this is a picture of, for the accessible name. The avatar is
   * decorative next to a visible name — pass `null` there and it is hidden
   * from assistive technology rather than announced as a meaningless hash.
   */
  label: string | null;
}

export default function Identicon({ seed, size = 96, label }: IdenticonProps) {
  const cells = identiconCells(seed);
  const color = identiconColor(seed);

  return (
    <svg
      className={styles.identicon}
      width={size}
      height={size}
      viewBox={`0 0 ${IDENTICON_SIZE} ${IDENTICON_SIZE}`}
      role={label === null ? 'presentation' : 'img'}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
      focusable="false"
    >
      {cells.map((on, index) =>
        on ? (
          <rect
            key={index}
            x={index % IDENTICON_SIZE}
            y={Math.floor(index / IDENTICON_SIZE)}
            width="1"
            height="1"
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}
