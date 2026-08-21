'use client';

/*
 * The `diagram` block — a ```mermaid fence, drawn.
 *
 * WHY THIS RUNS IN THE BROWSER, when every other block in this lesson is
 * server-rendered and design §14.1 is explicit that charts are drawn on the
 * server rather than by a client library.
 *
 * A chart is five numbers and a bar per number; the server has everything it
 * needs. A mermaid diagram is a LAYOUT problem: where a box goes depends on
 * how wide its label renders, which depends on the font the reader actually
 * has. Rendering it on the server without a browser was tried — mermaid runs
 * under jsdom once half a dozen DOM APIs are shimmed — and the result is
 * worse than a failure, because it SUCCEEDS with a wrong picture: with
 * `getBBox` stubbed to a constant, a four-node flowchart came back as a
 * 116x36 viewBox with every node drawn on top of every other. Getting it
 * right on the server means running Chromium in the import path. The browser
 * is already a browser.
 *
 * THE SOURCE IS THE FALLBACK, and it is rendered first. Server-side output is
 * a <pre> containing the diagram source, which is a complete and readable
 * answer on its own: it is what the page showed before this feature existed,
 * it is what a reader with JavaScript off gets, and it is what stays on
 * screen if mermaid fails to load or the diagram does not parse. Nothing here
 * removes information from the page; it only adds a picture above it.
 *
 * The import is dynamic so that mermaid's bundle is fetched only by a lesson
 * that actually contains a diagram — most do not.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './lesson.module.css';

/**
 * Mermaid's theme, taken from OUR tokens.
 *
 * Left alone, mermaid draws in its own palette — lavender node fills, purple
 * strokes — which is visibly not this app's. That is not a matter of taste:
 * `tools/check-css-tokens.mjs` bans hard-coded colours in this codebase
 * precisely so nothing renders in a colour nobody chose, and a diagram
 * arriving in a sixth accent undoes that in the most conspicuous place on the
 * page.
 *
 * Read from computed styles rather than duplicated here, so the diagram
 * follows a palette change, a light/dark swap, and the `data-theme` cookie
 * without a second copy of the values to keep in step.
 */
function paletteThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);

  /**
   * Reads a token and returns it as `#rrggbb`, by PAINTING it.
   *
   * THE CONVERSION IS NOT OPTIONAL, and it took three attempts. Mermaid runs
   * every colour it is given through a library that understands a narrow set
   * of formats. Handing it a token produced NO diagram, silently — the render
   * threw and this component's catch fell back to the source. The fallback
   * working is also exactly how a broken feature ships unnoticed, which is
   * why e2e/specs/diagram.spec.ts now asserts on the drawn colours.
   *
   * What did not work, in order:
   *
   *   1. Passing the declaration through. `getComputedStyle` does not return
   *      what tokens.css says — Chromium resolves it, and hands back
   *      `lab(96.7772% -.128835 1.51825)`.
   *   2. Parsing `oklch(L C H)` out of it with src/lib/oklch.ts. The regex
   *      never matched, for the reason above, and the lab string went
   *      straight through unchanged.
   *   3. Round-tripping through `ctx.fillStyle`, which normalises many
   *      formats to hex — but not this one. Chromium hands the lab string
   *      back verbatim.
   *
   * So the colour is painted onto a 1x1 canvas and the pixel is read. That is
   * not a parse at all: it is the browser's own rasteriser answering "what
   * does this actually look like", clamped into sRGB, which is what a screen
   * shows anyway. There is no format list to keep up with, and it stays
   * correct for whatever colour syntax the tokens use next.
   */
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

  const token = (name: string, fallback: string): string => {
    const raw = style.getPropertyValue(name).trim();
    if (!raw || !ctx) return fallback;

    // A sentinel first: assigning an unparseable value to fillStyle is a
    // no-op, so without this an unreadable token would silently paint
    // whatever the previous one did.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = raw;
    if (ctx.fillStyle === '#000000' && raw !== '#000000') return fallback;

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`;
  };

  const line = token('--color-text-secondary', '#555');
  const surface = token('--color-surface-raised', '#f5f5f5');
  const text = token('--color-text', '#111');

  return {
    background: token('--color-page', '#fff'),
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: token('--color-track-blue', line),
    secondaryColor: surface,
    tertiaryColor: surface,
    lineColor: line,
    textColor: text,
    mainBkg: surface,
    nodeBorder: token('--color-track-blue', line),
    clusterBkg: token('--color-page', '#fff'),
    clusterBorder: token('--color-border-hairline', line),
    edgeLabelBackground: token('--color-page', '#fff'),
    // Not a colour, so it is read directly rather than through `token`.
    fontFamily: style.getPropertyValue('--font-sans').trim() || 'sans-serif',
    fontSize: '15px',
  };
}

export interface DiagramProps {
  source: string;
  caption?: string;
}

type RenderState = { status: 'source' } | { status: 'drawn'; svg: string };

export default function Diagram({ source, caption }: DiagramProps) {
  const [state, setState] = useState<RenderState>({ status: 'source' });
  const domId = useId().replace(/[^a-zA-Z0-9]/g, '');
  // Guards against a slow render resolving after the block has been replaced
  // by a navigation — React would warn, and the wrong diagram could land.
  const live = useRef(true);

  const draw = useCallback(async (): Promise<void> => {
    try {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        // Mermaid's own sanitizer, at its strictest: no click handlers, no
        // raw HTML in labels. The source is authored content from a git
        // repo, which is the same trust level as the prose around it — and
        // the same level Phase 5 decided to sanitize rather than trust.
        securityLevel: 'strict',
        // 'base' is the only built-in theme that honours themeVariables.
        theme: 'base',
        themeVariables: paletteThemeVariables(),
      });
      const { svg } = await mermaid.render(`d-${domId}`, source);
      if (live.current) setState({ status: 'drawn', svg });
    } catch {
      // Deliberately silent, and deliberately not a visible error: the
      // source below is already a correct rendering of this block. Telling
      // the reader that a drawing they never saw failed to appear is noise.
      if (live.current) setState({ status: 'source' });
    }
  }, [source, domId]);

  useEffect(() => {
    live.current = true;
    void draw();

    // REDRAW ON A THEME CHANGE. The colours are baked into the SVG at render
    // time, so a diagram drawn in light mode stays light after the reader
    // switches — a bright box in the middle of a dark page. Both routes into
    // a change are watched: the explicit toggle, which sets `data-theme` on
    // the root, and the system preference, which sets nothing at all.
    const observer = new MutationObserver(() => void draw());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => void draw();
    media.addEventListener('change', onSchemeChange);

    return () => {
      live.current = false;
      observer.disconnect();
      media.removeEventListener('change', onSchemeChange);
    };
  }, [draw]);

  const sourceId = `${domId}-source`;

  return (
    // `aria-describedby` points at the source, which stays in the document
    // even once the picture replaces it. See the note above `aria-hidden`
    // below for why.
    <figure className={styles.diagram} aria-describedby={sourceId}>
      {state.status === 'drawn' ? (
        // Mermaid's own output, produced from source this instance imported
        // and sanitized by mermaid at securityLevel 'strict'. Same trust
        // boundary as Figure.tsx: what reaches the DOM was sanitized before
        // it got here, not by anything at render time.
        //
        // HIDDEN FROM ASSISTIVE TECHNOLOGY, DELIBERATELY. Measured, not
        // assumed: the accessibility tree for a four-node flowchart is a
        // `document` containing four disconnected paragraphs — "Content
        // repo", "Import", "Typed blocks", "Reader" — with every arrow
        // silently dropped. That is worse than nothing, because it reads as
        // a complete answer while omitting the whole meaning of the diagram.
        // A screen reader user would hear four nouns and no relationships.
        <div className={styles.diagramSvg} aria-hidden="true" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : null}

      {/*
       * The source, and the text alternative.
       *
       * Visible when mermaid has not drawn (no JavaScript, a failed load, a
       * diagram that does not parse) — where it is a complete and readable
       * rendering of the block on its own. Visually hidden once the picture
       * is up, but still in the accessibility tree as the figure's
       * description.
       *
       * It is an imperfect alternative and worth saying so: `Repo[Content
       * repo] --> Import[Import]` read aloud is awkward. But it is PRECISE —
       * every node, every edge, every direction — where the SVG's own tree
       * is a list of nouns that has quietly lost the arrows. Awkward and
       * complete beats fluent and wrong.
       */}
      <pre id={sourceId} className={state.status === 'drawn' ? styles.srOnly : styles.diagramSource}>
        <code>{source}</code>
      </pre>

      {caption ? <figcaption className={styles.figureCaption}>{caption}</figcaption> : null}
    </figure>
  );
}
