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

import { useEffect, useId, useRef, useState } from 'react';
import styles from './lesson.module.css';

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

  useEffect(() => {
    live.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          // Mermaid's own sanitizer, at its strictest: no click handlers, no
          // raw HTML in labels. The source is authored content from a git
          // repo, which is the same trust level as the prose around it — and
          // the same level Phase 5 decided to sanitize rather than trust.
          securityLevel: 'strict',
          // Inherit the page's type rather than mermaid's default stack, so a
          // diagram reads as part of the lesson (design §14).
          fontFamily: 'var(--font-sans)',
        });
        const { svg } = await mermaid.render(`d-${domId}`, source);
        if (!cancelled && live.current) setState({ status: 'drawn', svg });
      } catch {
        // Deliberately silent, and deliberately not a visible error: the
        // source below is already a correct rendering of this block. Telling
        // the reader that a drawing they never saw failed to appear is noise.
        if (!cancelled && live.current) setState({ status: 'source' });
      }
    })();

    return () => {
      cancelled = true;
      live.current = false;
    };
  }, [source, domId]);

  return (
    <figure className={styles.diagram}>
      {state.status === 'drawn' ? (
        // Mermaid's own output, produced from source this instance imported
        // and sanitized by mermaid at securityLevel 'strict'. Same trust
        // boundary as Figure.tsx: what reaches the DOM was sanitized before
        // it got here, not by anything at render time.
        <div className={styles.diagramSvg} dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <pre className={styles.diagramSource}>
          <code>{source}</code>
        </pre>
      )}
      {caption ? <figcaption className={styles.figureCaption}>{caption}</figcaption> : null}
    </figure>
  );
}
