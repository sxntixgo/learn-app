'use client';

/*
 * The annotatable `code` block (design §9.4, §14.1/§14.2).
 *
 * A student reads code and attaches comments to specific lines; for a
 * code-review course that IS the exercise. In a lesson the block carries the
 * author's annotations read-only; in an exercise it accepts the student's own.
 *
 * THE DESIGN PROBLEM IS 375px. A phone has no margin column beside the code
 * and no hover, and a code line is ~20px tall — far under the 44px target
 * §14.2 requires. Everything below is the consequence of solving authoring at
 * 375px first and letting 834/1440 be the same layout with more room.
 *
 * 1. **Annotations render inline, under the last line of their range — one
 *    layout at every width.** No margin column, no popover, no hover card.
 *    You read the passage, then the comment on it, which is the order a code
 *    review is read in anyway. Wider viewports get a wider card, not a
 *    different mechanism, so there is only one interaction to learn and one
 *    to maintain.
 *
 * 2. **Selecting a line is not a "control", so it is not the 44px target.**
 *    The 44px rule is met by every control that *does* something — the
 *    steppers, Add note, Save, Cancel, Edit, Delete. Line selection is
 *    instead made safe rather than precise, three ways:
 *      - the whole row is the tap target, not the number: ~330 x 32px at
 *        375px (annotate mode opens the line pitch up to `--space-5`), and
 *        adjacent targets do not overlap, so a tap is never ambiguous;
 *      - a mis-tap costs nothing. Selecting is non-destructive, the action
 *        bar states in words which lines are selected, and the ± steppers
 *        move the selection a line at a time, so you never have to hit a
 *        small target twice;
 *      - the bar's "Annotate line N" button needs no aiming at all: it works
 *        with the keyboard's focused line, so a student with poor motor
 *        control can annotate without ever tapping a line.
 *
 * 3. **A range is built with steppers, not with a drag.** Dragging across
 *    lines fights the block's own horizontal scroll on a touch screen, and
 *    there is no hover to preview it. First line ± and Last line ± are
 *    explicit, reversible, keyboard-equivalent (Shift+Arrow), and readable
 *    aloud.
 *
 * 4. **Nothing is hover-only** (§14.2). Every affordance is visible at rest:
 *    the header says the block is annotatable, the gutter shows a count
 *    badge on annotated lines, cards are always open. Colour and position
 *    are never the only signal — the count is in each line's accessible
 *    name, each card names its own range in text, and a `role="status"`
 *    readout speaks every selection and edit.
 *
 * State lives here and is surfaced through `onChange`. Persistence is the
 * next task: this component never talks to the API.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import {
  addAnnotation,
  adjustRangeEnd,
  adjustRangeStart,
  annotationsCoveringLine,
  clampLine,
  describeLine,
  describeRange,
  formatRangeLabel,
  fromAuthorAnnotations,
  groupAnnotationsByEndLine,
  partitionAnnotations,
  removeAnnotation,
  selectLine,
  sortAnnotations,
  splitHighlightedLines,
  updateAnnotation,
  type Annotation,
  type AuthorAnnotationInput,
  type LineRange,
} from '../../../../../src/lib/annotations';
import styles from './annotatable-code.module.css';

export type { Annotation };

export interface AnnotatableCodeProps {
  /** Shiki's rendered HTML for the whole block — highlighting stays at render time (CLAUDE.md rule 4). */
  html: string;
  /** `read`: author annotations, read-only (a lesson). `annotate`: the student writes (an exercise). */
  mode?: 'read' | 'annotate';
  /** Language label for the header chip, e.g. "ts". */
  lang?: string | null;
  /** Author annotations from the content repo (design §6.3 `[!note]` markers). */
  authorAnnotations?: readonly AuthorAnnotationInput[];
  /** Student annotations to start from — e.g. a draft restored by the caller. */
  initialAnnotations?: readonly Annotation[];
  /** Fired with the student's annotations whenever they change. Persistence is the caller's job. */
  onChange?: (annotations: Annotation[]) => void;
}

type Composer = { kind: 'create'; range: LineRange } | { kind: 'edit'; id: string };

export default function AnnotatableCode({
  html,
  mode = 'read',
  lang,
  authorAnnotations,
  initialAnnotations,
  onChange,
}: AnnotatableCodeProps) {
  const domId = useId();
  const { style, lines } = useMemo(() => splitHighlightedLines(html), [html]);
  const lineCount = lines.length;

  const [studentAnnotations, setStudentAnnotations] = useState<Annotation[]>(() =>
    sortAnnotations(initialAnnotations ?? [])
  );
  const [selection, setSelection] = useState<LineRange | null>(null);
  const [focusLine, setFocusLine] = useState(1);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');

  const lineRefs = useRef(new Map<number, HTMLButtonElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const nextId = useRef(0);

  const authored = useMemo(
    () => fromAuthorAnnotations(authorAnnotations ?? [], lineCount),
    [authorAnnotations, lineCount]
  );
  const { anchored, orphaned } = useMemo(
    () => partitionAnnotations([...authored, ...studentAnnotations], lineCount),
    [authored, studentAnnotations, lineCount]
  );
  const cardsByLine = useMemo(() => groupAnnotationsByEndLine(anchored), [anchored]);

  // A read-only block with no annotations is just a code block: no per-line
  // controls, no readout, nothing to tab through. Only blocks that actually
  // carry (or accept) annotations pay the interaction cost.
  const interactive = mode === 'annotate' || anchored.length > 0 || orphaned.length > 0;

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onChangeRef.current?.(studentAnnotations);
  }, [studentAnnotations]);

  useEffect(() => {
    if (composer) textareaRef.current?.focus();
  }, [composer]);

  const focusLineButton = useCallback((line: number) => {
    lineRefs.current.get(line)?.focus();
  }, []);

  const announceSelection = useCallback(
    (range: LineRange) => {
      const covering = annotationsCoveringLine(anchored, range.start).length;
      const notes =
        range.start === range.end && covering > 0
          ? `, ${covering} annotation${covering === 1 ? '' : 's'} here`
          : '';
      setStatus(`Selected ${describeRange(range)}${notes}.`);
    },
    [anchored]
  );

  const select = useCallback(
    (line: number) => {
      const range = selectLine(line, lineCount);
      if (!range) return;
      setSelection(range);
      setFocusLine(range.start);
      setComposer(null);
      announceSelection(range);
    },
    [lineCount, announceSelection]
  );

  const openComposer = useCallback((range: LineRange) => {
    setSelection(range);
    setDraft('');
    setComposer({ kind: 'create', range });
    setStatus(`Writing an annotation on ${describeRange(range)}.`);
  }, []);

  /*
   * One handler for pointer and keyboard alike: the gutter button's own
   * activation (Enter, Space, tap) bubbles to the row, and a tap anywhere on
   * the row lands here too — so the target is the whole row, not the 44px-wide
   * number. First activation selects; a second activation on an
   * already-selected single line acts on it (open the composer, or move to
   * the first annotation card when reading). That gives touch a
   * select-then-confirm rhythm without a mode, a long-press, or a hover.
   */
  const activate = useCallback(
    (line: number) => {
      const alreadyHere = selection?.start === line && selection.end === line;
      if (!alreadyHere) {
        select(line);
        return;
      }
      if (mode === 'annotate') {
        openComposer({ start: line, end: line });
        return;
      }
      const firstCard = cardsByLine.get(line)?.[0];
      if (firstCard) cardRefs.current.get(firstCard.id)?.focus();
    },
    [selection, mode, select, openComposer, cardsByLine]
  );

  function onListKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    // The composer, and the Edit/Delete buttons on a card, live inside this
    // list. Without this guard an arrow key pressed while writing an
    // annotation would bubble up here and move the line selection instead of
    // the caret. Only keys from a line control are line navigation.
    if (!(event.target as HTMLElement).closest('[data-line-control]')) return;

    const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];

    if (event.shiftKey && step !== undefined && selection) {
      // Shift+Arrow grows the selection — up from the first line, down from
      // the last — the keyboard twin of the two stepper pairs in the bar.
      event.preventDefault();
      const range =
        step === -1
          ? adjustRangeStart(selection, -1, lineCount)
          : adjustRangeEnd(selection, 1, lineCount);
      setSelection(range);
      const edge = step === -1 ? range.start : range.end;
      setFocusLine(edge);
      focusLineButton(edge);
      announceSelection(range);
      return;
    }

    if (step !== undefined) {
      event.preventDefault();
      const line = clampLine(focusLine + step, lineCount);
      select(line);
      focusLineButton(line);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const line = event.key === 'Home' ? 1 : lineCount;
      select(line);
      focusLineButton(line);
      return;
    }

    if (event.key === 'Escape' && selection) {
      // Escape clears the selection but never moves focus out of the block:
      // this is not a trap and not a cage either.
      event.preventDefault();
      setSelection(null);
      setComposer(null);
      setStatus('Selection cleared.');
    }
  }

  function saveComposer() {
    const body = draft.trim();
    if (!body || !composer) return;

    if (composer.kind === 'create') {
      const id = `student-${domId}-${nextId.current++}`;
      setStudentAnnotations((current) =>
        addAnnotation(current, {
          id,
          range: composer.range,
          body,
          createdAt: new Date().toISOString(),
        })
      );
      setStatus(`Annotation added on ${describeRange(composer.range)}.`);
      setComposer(null);
      setDraft('');
      focusLineButton(composer.range.end);
      return;
    }

    const edited = anchored.find((a) => a.id === composer.id);
    setStudentAnnotations((current) => updateAnnotation(current, composer.id, body));
    setStatus('Annotation updated.');
    setComposer(null);
    setDraft('');
    if (edited) focusLineButton(edited.range.end);
  }

  function cancelComposer() {
    // Focus must land somewhere deliberate when the field it was in
    // disappears, or it falls back to the document and the keyboard user
    // loses their place in the code.
    const line =
      composer?.kind === 'create'
        ? composer.range.end
        : (anchored.find((a) => a.id === composer?.id)?.range.end ?? null);
    setComposer(null);
    setDraft('');
    setStatus('Editing cancelled.');
    if (line) focusLineButton(line);
  }

  function deleteAnnotation(annotation: Annotation) {
    setStudentAnnotations((current) => removeAnnotation(current, annotation.id));
    setComposer(null);
    setStatus(`Annotation on ${describeRange(annotation.range)} deleted.`);
    focusLineButton(annotation.range.end);
  }

  function startEdit(annotation: Annotation) {
    setDraft(annotation.body);
    setSelection(annotation.range);
    setComposer({ kind: 'edit', id: annotation.id });
    setStatus(`Editing the annotation on ${describeRange(annotation.range)}.`);
  }

  function stepSelection(edge: 'start' | 'end', delta: number) {
    if (!selection) return;
    const range =
      edge === 'start'
        ? adjustRangeStart(selection, delta, lineCount)
        : adjustRangeEnd(selection, delta, lineCount);
    setSelection(range);
    const edgeLine = edge === 'start' ? range.start : range.end;
    setFocusLine(edgeLine);
    announceSelection(range);
  }

  const editingId = composer?.kind === 'edit' ? composer.id : null;
  const composerLine = composer?.kind === 'create' ? composer.range.end : null;
  const headerId = `${domId}-header`;

  function renderComposer(range: LineRange, existing: Annotation | null) {
    const fieldId = `${domId}-composer`;
    return (
      <div className={styles.composer}>
        <label className={styles.composerLabel} htmlFor={fieldId}>
          {existing ? 'Edit your annotation on ' : 'Your annotation on '}
          {describeRange(range)}
        </label>
        <textarea
          id={fieldId}
          ref={textareaRef}
          className={styles.textarea}
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Escape backs out; Ctrl/Cmd+Enter saves. Plain Tab still leaves
            // the field for Save — the textarea is never a trap.
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelComposer();
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              saveComposer();
            }
          }}
        />
        <div className={styles.composerActions}>
          <button type="button" className={styles.primaryButton} onClick={saveComposer} disabled={!draft.trim()}>
            Save annotation
          </button>
          <button type="button" className={styles.button} onClick={cancelComposer}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={styles.block}
      /*
       * shiki's dual-theme custom properties are defined here and inherited
       * by the line rows, which carry the `shiki` class itself (see the note
       * in annotatable-code.module.css): the global rules that pick the
       * light or dark half then apply to the code text and to nothing else.
       */
      style={style as CSSProperties}
      aria-labelledby={headerId}
      data-mode={mode}
    >
      <header className={styles.header}>
        <h3 className={styles.headerTitle} id={headerId}>
          {mode === 'annotate' ? 'Code to annotate' : 'Code'}
          {lang ? <span className={styles.langChip}>{lang}</span> : null}
        </h3>
        {interactive ? (
          <p className={styles.headerHint}>
            {mode === 'annotate'
              ? 'Select a line, then add a note. Arrow keys move; Shift+Arrow selects a range.'
              : `${anchored.length} annotation${anchored.length === 1 ? '' : 's'}. Select a line to hear what is on it.`}
          </p>
        ) : null}
      </header>

      <div
        className={styles.scroller}
        // A horizontally scrollable region needs to be reachable and
        // scrollable by keyboard in its own right, exactly as shiki's own
        // <pre tabindex="0"> is today.
        tabIndex={0}
        role="group"
        aria-label={`Code, ${lineCount} lines, scrolls sideways`}
      >
        <ol className={styles.lines} onKeyDown={interactive ? onListKeyDown : undefined}>
          {lines.map((lineHtml, index) => {
            const line = index + 1;
            const covering = annotationsCoveringLine(anchored, line);
            const selected = selection !== null && selection.start <= line && line <= selection.end;
            const cards = cardsByLine.get(line) ?? [];

            return (
              <li key={line} className={styles.lineItem}>
                <div
                  className={`shiki ${styles.lineRow}`}
                  data-selected={selected ? 'true' : undefined}
                  data-annotated={covering.length > 0 ? 'true' : undefined}
                  /*
                   * The row-wide click is a convenience over the real control
                   * (the gutter button inside it, which handles keyboard and
                   * screen readers). It is skipped while text is selected so
                   * that selecting and copying code still works — a code block
                   * you cannot copy from would be a poor trade for annotation.
                   */
                  onClick={
                    interactive
                      ? (event) => {
                          if (!event.currentTarget.ownerDocument.defaultView?.getSelection()?.isCollapsed) return;
                          activate(line);
                        }
                      : undefined
                  }
                >
                  {interactive ? (
                    <button
                      type="button"
                      className={styles.gutter}
                      data-line-control="true"
                      ref={(node) => {
                        if (node) lineRefs.current.set(line, node);
                        else lineRefs.current.delete(line);
                      }}
                      // Roving tabindex: the whole block is one tab stop, and
                      // arrow keys move within it (the Heatmap pattern).
                      tabIndex={line === focusLine ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={describeLine(line, covering.length, lineCount)}
                      onFocus={() => setFocusLine(line)}
                    >
                      <span className={styles.lineNumber} aria-hidden="true">
                        {line}
                      </span>
                      {covering.length > 0 ? (
                        <span className={styles.badge} aria-hidden="true">
                          {covering.length}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <span className={styles.gutterStatic} aria-hidden="true">
                      {line}
                    </span>
                  )}
                  <code className={styles.lineCode} dangerouslySetInnerHTML={{ __html: lineHtml }} />
                </div>

                {cards.map((annotation) =>
                  editingId === annotation.id ? (
                    <div key={annotation.id} className={styles.cardSlot}>
                      {renderComposer(annotation.range, annotation)}
                    </div>
                  ) : (
                    <div key={annotation.id} className={styles.cardSlot}>
                      <article
                        className={styles.card}
                        data-origin={annotation.origin}
                        data-track={annotation.track ? 'true' : undefined}
                        tabIndex={-1}
                        ref={(node) => {
                          if (node) cardRefs.current.set(annotation.id, node);
                          else cardRefs.current.delete(annotation.id);
                        }}
                        aria-label={`${
                          annotation.origin === 'author' ? 'Author annotation' : 'Your annotation'
                        } on ${describeRange(annotation.range)}`}
                      >
                        <p className={styles.cardMeta}>
                          <span className={styles.cardRange}>{formatRangeLabel(annotation.range)}</span>
                          <span className={styles.cardOrigin}>
                            {annotation.origin === 'author' ? 'Author' : 'You'}
                          </span>
                          {annotation.track ? <span className={styles.cardTrack}>{annotation.track}</span> : null}
                        </p>
                        <p className={styles.cardBody}>{annotation.body}</p>
                        {annotation.origin === 'student' ? (
                          <p className={styles.cardActions}>
                            <button type="button" className={styles.button} onClick={() => startEdit(annotation)}>
                              Edit<span className={styles.srOnly}> annotation on {describeRange(annotation.range)}</span>
                            </button>
                            <button
                              type="button"
                              className={styles.button}
                              onClick={() => deleteAnnotation(annotation)}
                            >
                              Delete
                              <span className={styles.srOnly}> annotation on {describeRange(annotation.range)}</span>
                            </button>
                          </p>
                        ) : null}
                      </article>
                    </div>
                  )
                )}

                {composerLine === line && composer?.kind === 'create' ? (
                  <div className={styles.cardSlot}>{renderComposer(composer.range, null)}</div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {mode === 'annotate' ? (
        /*
         * The action bar is sticky to the bottom of the block, so on a phone
         * it is still there after scrolling forty lines of code — the
         * affordance never goes off screen, and it never depends on hover.
         */
        <div className={styles.bar}>
          {selection ? (
            <>
              <p className={styles.barLabel}>{formatRangeLabel(selection)}</p>
              <div className={styles.steppers}>
                <span className={styles.stepperGroup}>
                  <span className={styles.stepperLabel}>First</span>
                  <button
                    type="button"
                    className={styles.stepper}
                    onClick={() => stepSelection('start', -1)}
                    aria-label="Move the first selected line up"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className={styles.stepper}
                    onClick={() => stepSelection('start', 1)}
                    aria-label="Move the first selected line down"
                  >
                    +
                  </button>
                </span>
                <span className={styles.stepperGroup}>
                  <span className={styles.stepperLabel}>Last</span>
                  <button
                    type="button"
                    className={styles.stepper}
                    onClick={() => stepSelection('end', -1)}
                    aria-label="Move the last selected line up"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className={styles.stepper}
                    onClick={() => stepSelection('end', 1)}
                    aria-label="Move the last selected line down"
                  >
                    +
                  </button>
                </span>
              </div>
              <div className={styles.barActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => openComposer(selection)}
                  aria-label={`Add an annotation on ${describeRange(selection)}`}
                >
                  Add note
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    setSelection(null);
                    setComposer(null);
                    setStatus('Selection cleared.');
                  }}
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.barLabel}>No lines selected</p>
              <div className={styles.barActions}>
                {/* Needs no aiming at all: annotates the focused line, which
                    starts at line 1 and follows the arrow keys. */}
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => openComposer({ start: focusLine, end: focusLine })}
                >
                  Annotate line {focusLine}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {orphaned.length > 0 ? (
        /*
         * Anchors are never silently moved (design §9.4). If an annotation no
         * longer fits the code it was written against, it is shown here
         * rather than dropped or re-pointed at a line it was not about.
         */
        <section className={styles.orphans} aria-label="Annotations that no longer match this code">
          <h4 className={styles.orphansTitle}>
            {orphaned.length} annotation{orphaned.length === 1 ? '' : 's'} no longer match this code
          </h4>
          {orphaned.map((annotation) => (
            <article key={annotation.id} className={styles.card} data-origin={annotation.origin}>
              <p className={styles.cardMeta}>
                <span className={styles.cardRange}>{formatRangeLabel(annotation.range)}</span>
                <span className={styles.cardOrigin}>out of range</span>
              </p>
              <p className={styles.cardBody}>{annotation.body}</p>
            </article>
          ))}
        </section>
      ) : null}

      {interactive ? (
        <p className={styles.readout} role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
