/*
 * The `figure` block (design §6.3, Phase 10 Task B): the one sanctioned
 * escape hatch for bespoke static SVG. No scripts, ever.
 *
 * `svg` here has ALREADY been through sanitize.ts's `sanitizeSvg` — at
 * import time, in api/src/content/parse.ts's buildFigureBlock — so by the
 * time this component runs, scripts, event handlers, and `foreignObject`
 * are already gone from the stored block. Rendering it with
 * `dangerouslySetInnerHTML` here is the same trust boundary the lesson
 * page's `prose` block already uses (see page.tsx: "sanitizing untrusted/
 * rendered HTML before it reaches the DOM is Phase 5's job — not built
 * here") — the sanitizer at import time is the security boundary, not
 * anything at render time.
 */

import styles from './lesson.module.css';

export interface FigureProps {
  svg: string;
  caption: string;
}

export default function Figure({ svg, caption }: FigureProps) {
  return (
    <figure className={styles.figure}>
      <div className={styles.figureSvg} dangerouslySetInnerHTML={{ __html: svg }} />
      <figcaption className={styles.figureCaption}>{caption}</figcaption>
    </figure>
  );
}
