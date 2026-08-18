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
  repliesByParent,
  selectLine,
  sortAnnotations,
  splitHighlightedLines,
  topLevelAnnotations,
  updateAnnotation,
  type Annotation,
  type AuthorAnnotationInput,
  type LineRange,
} from '../../../../../src/lib/annotations';
import styles from './annotatable-code.module.css';

export type { Annotation };

/** Author → "Author", teacher → "Teacher", anything else (a student's own) → "You". Callers override for the other side of a conversation (design §9.4: a teacher grading sees the STUDENT'S notes as not-theirs; the student reading a return sees the TEACHER'S notes as not-theirs — this default already gets both right without an override). */
function defaultOriginLabel(annotation: Annotation): string {
  if (annotation.origin === 'author') return 'Author';
  if (annotation.origin === 'teacher') return 'Teacher';
  return 'You';
}

export interface AnnotatableCodeProps {
  /** Shiki's rendered HTML for the whole block — highlighting stays at render time (CLAUDE.md rule 4). */
  html: string;
  /**
   * `read`: author annotations, read-only (a lesson), plus a student's own
   * plus any teacher replies/flags once returned (design §9.4). `annotate`:
   * the student writes (an exercise). `grade`: a teacher replies to the
   * student's annotations and flags lines the student missed (the grading
   * view) — design §9.4 calls the second "the more instructive of the two",
   * so both are always-visible controls, never one hidden behind the other.
   */
  mode?: 'read' | 'annotate' | 'grade';
  /** Language label for the header chip, e.g. "ts". */
  lang?: string | null;
  /** Author annotations from the content repo (design §6.3 `[!note]` markers). */
  authorAnnotations?: readonly AuthorAnnotationInput[];
  /** Annotations to start from — e.g. a draft restored by the caller, or a submission's stored annotations. */
  initialAnnotations?: readonly Annotation[];
  /** Fired with the FULL current annotation list whenever it changes. Persistence is the caller's job — in `grade` mode, only the `pending: true` entries are new (see `toGradeAnnotationInputs`). */
  onChange?: (annotations: Annotation[]) => void;
  /**
   * Locks a `mode="annotate"` block into read behaviour once a submission is
   * no longer editable (design §9.1: "a submitted exercise offers no further
   * editing"). The API refuses a draft write against a submitted/returned
   * submission anyway (409); this is what keeps the UI from ever inviting
   * that request — no composer, no Edit/Delete on the student's own cards,
   * same as a lesson's read-only author annotations. `mode` still decides
   * the header wording's baseline; `readOnly` overrides the *behaviour*.
   */
  readOnly?: boolean;
  /** Card label per annotation — see `defaultOriginLabel`. Override when the viewer is the OTHER party in the conversation. */
  originLabel?: (annotation: Annotation) => string;
}

type Composer =
  | { kind: 'create'; range: LineRange }
  | { kind: 'edit'; id: string }
  | { kind: 'reply'; parentId: string; range: LineRange };

export default function AnnotatableCode({
  html,
  mode = 'read',
  lang,
  authorAnnotations,
  initialAnnotations,
  onChange,
  readOnly = false,
  originLabel = defaultOriginLabel,
}: AnnotatableCodeProps) {
  // The mode that actually governs behaviour below: a submitted exercise
  // passes mode="annotate" (so the header still reads as an exercise) with
  // readOnly=true, and every interactive branch checks THIS, not `mode`.
  // `grade` is never forced to `read` — a teacher stays able to reply/flag
  // regardless of `readOnly`, which this component never receives in grade
  // mode anyway (the grading view has no draft to lock).
  const effectiveMode = readOnly ? 'read' : mode;
  const domId = useId();
  const { style, lines } = useMemo(() => splitHighlightedLines(html), [html]);
  const lineCount = lines.length;

  // Named for its original (student-draft) use; in `grade` mode this same
  // state holds every LOCALLY ADDED reply/flag too (origin 'teacher',
  // pending: true) — see the module doc on `onChange`.
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
  // Threading (design §9.4): a reply never gets its own line grouping — it
  // renders nested under the top-level annotation it answers instead, via
  // `replies`. `topLevel`/`orphanedTopLevel` are what every line/count/orphan
  // computation below uses, so a reply can never double-appear as if it were
  // its own comment on the line.
  const topLevel = useMemo(() => topLevelAnnotations(anchored), [anchored]);
  const orphanedTopLevel = useMemo(() => topLevelAnnotations(orphaned), [orphaned]);
  const replies = useMemo(() => repliesByParent(anchored), [anchored]);
  const cardsByLine = useMemo(() => groupAnnotationsByEndLine(topLevel), [topLevel]);

  // A read-only block with no annotations is just a code block: no per-line
  // controls, no readout, nothing to tab through. Only blocks that actually
  // carry (or accept) annotations pay the interaction cost. `grade` is
  // always interactive — a teacher can flag any line, even one with nothing
  // on it yet.
  const interactive =
    effectiveMode === 'annotate' || effectiveMode === 'grade' || topLevel.length > 0 || orphanedTopLevel.length > 0;

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
      const covering = annotationsCoveringLine(topLevel, range.start).length;
      const notes =
        range.start === range.end && covering > 0
          ? `, ${covering} annotation${covering === 1 ? '' : 's'} here`
          : '';
      setStatus(`Selected ${describeRange(range)}${notes}.`);
    },
    [topLevel]
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
      if (effectiveMode === 'annotate' || effectiveMode === 'grade') {
        openComposer({ start: line, end: line });
        return;
      }
      const firstCard = cardsByLine.get(line)?.[0];
      if (firstCard) cardRefs.current.get(firstCard.id)?.focus();
    },
    [selection, effectiveMode, select, openComposer, cardsByLine]
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
      // `annotate`: the student's own note. `grade`: a top-level teacher
      // annotation flagging a line the student missed (design §9.4) — staged
      // locally (`pending: true`) until the teacher's own explicit "Return"
      // action sends it (see toGradeAnnotationInputs).
      const isGrading = effectiveMode === 'grade';
      const id = `${isGrading ? 'teacher' : 'student'}-${domId}-${nextId.current++}`;
      setStudentAnnotations((current) =>
        addAnnotation(current, {
          id,
          range: composer.range,
          body,
          createdAt: new Date().toISOString(),
          ...(isGrading ? { origin: 'teacher' as const, pending: true } : {}),
        })
      );
      setStatus(
        isGrading
          ? `Flagged ${describeRange(composer.range)} for the student.`
          : `Annotation added on ${describeRange(composer.range)}.`
      );
      setComposer(null);
      setDraft('');
      focusLineButton(composer.range.end);
      return;
    }

    if (composer.kind === 'reply') {
      const id = `teacher-${domId}-${nextId.current++}`;
      setStudentAnnotations((current) =>
        addAnnotation(current, {
          id,
          range: composer.range,
          body,
          createdAt: new Date().toISOString(),
          origin: 'teacher',
          parentId: composer.parentId,
          pending: true,
        })
      );
      setStatus(`Reply added on ${describeRange(composer.range)}.`);
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
      composer?.kind === 'create' || composer?.kind === 'reply'
        ? composer.range.end
        : (anchored.find((a) => a.id === composer?.id)?.range.end ?? null);
    const wasReply = composer?.kind === 'reply';
    setComposer(null);
    setDraft('');
    setStatus(wasReply ? 'Reply cancelled.' : 'Editing cancelled.');
    if (line) focusLineButton(line);
  }

  function startReply(annotation: Annotation) {
    setDraft('');
    setComposer({ kind: 'reply', parentId: annotation.id, range: annotation.range });
    setStatus(`Replying to ${originLabel(annotation)}'s annotation on ${describeRange(annotation.range)}.`);
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
  const replyParentId = composer?.kind === 'reply' ? composer.parentId : null;
  const headerId = `${domId}-header`;

  function renderComposer(range: LineRange, existing: Annotation | null) {
    const fieldId = `${domId}-composer`;
    const isReply = composer?.kind === 'reply';
    const isFlag = composer?.kind === 'create' && effectiveMode === 'grade';
    const label = existing
      ? 'Edit your annotation on '
      : isReply
        ? 'Your reply, on '
        : isFlag
          ? 'Flag on '
          : 'Your annotation on ';
    return (
      <div className={styles.composer}>
        <label className={styles.composerLabel} htmlFor={fieldId}>
          {label}
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
            {isReply ? 'Save reply' : isFlag ? 'Save flag' : 'Save annotation'}
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
      data-mode={effectiveMode}
    >
      <header className={styles.header}>
        <h3 className={styles.headerTitle} id={headerId}>
          {mode === 'annotate' ? 'Code to annotate' : mode === 'grade' ? 'Code under review' : 'Code'}
          {lang ? <span className={styles.langChip}>{lang}</span> : null}
        </h3>
        {interactive ? (
          <p className={styles.headerHint}>
            {readOnly
              ? `Submitted — ${topLevel.length} annotation${topLevel.length === 1 ? '' : 's'}. Select a line to hear what is on it.`
              : effectiveMode === 'annotate'
                ? 'Select a line, then add a note. Arrow keys move; Shift+Arrow selects a range.'
                : effectiveMode === 'grade'
                  ? 'Reply under any comment, or select a line to flag one the student missed.'
                  : `${topLevel.length} annotation${topLevel.length === 1 ? '' : 's'}. Select a line to hear what is on it.`}
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
            const covering = annotationsCoveringLine(topLevel, line);
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

                {cards.map((annotation) => {
                  const canReply = effectiveMode === 'grade' && !annotation.pending;
                  const annotationReplies = replies.get(annotation.id) ?? [];

                  return editingId === annotation.id ? (
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
                        aria-label={`${originLabel(annotation)}'s annotation on ${describeRange(annotation.range)}`}
                      >
                        <p className={styles.cardMeta}>
                          <span className={styles.cardRange}>{formatRangeLabel(annotation.range)}</span>
                          <span className={styles.cardOrigin}>{originLabel(annotation)}</span>
                          {annotation.track ? <span className={styles.cardTrack}>{annotation.track}</span> : null}
                        </p>
                        <p className={styles.cardBody}>{annotation.body}</p>
                        {annotation.origin === 'student' && effectiveMode === 'annotate' ? (
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
                        {/*
                         * Reply is ALWAYS a visible button, never a hover-only
                         * affordance or a menu item (§14.2) — design §9.4 asks
                         * for both "reply" and "flag a missed line" to be
                         * equally obvious, not one buried under the other.
                         */}
                        {canReply ? (
                          <p className={styles.cardActions}>
                            <button type="button" className={styles.button} onClick={() => startReply(annotation)}>
                              Reply<span className={styles.srOnly}> to the annotation on {describeRange(annotation.range)}</span>
                            </button>
                          </p>
                        ) : null}
                      </article>

                      {annotationReplies.length > 0 ? (
                        <ul className={styles.replyList}>
                          {annotationReplies.map((reply) => (
                            <li key={reply.id} className={styles.replySlot}>
                              <article
                                className={styles.replyCard}
                                aria-label={`${originLabel(reply)}'s reply on ${describeRange(annotation.range)}`}
                              >
                                <p className={styles.cardMeta}>
                                  <span className={styles.cardOrigin}>{originLabel(reply)}</span>
                                  {reply.pending ? <span className={styles.cardPending}>Not sent yet</span> : null}
                                </p>
                                <p className={styles.cardBody}>{reply.body}</p>
                              </article>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {replyParentId === annotation.id ? (
                        <div className={styles.cardSlot}>{renderComposer(annotation.range, null)}</div>
                      ) : null}
                    </div>
                  );
                })}

                {composerLine === line && composer?.kind === 'create' ? (
                  <div className={styles.cardSlot}>{renderComposer(composer.range, null)}</div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {effectiveMode === 'annotate' || effectiveMode === 'grade' ? (
        /*
         * The action bar is sticky to the bottom of the block, so on a phone
         * it is still there after scrolling forty lines of code — the
         * affordance never goes off screen, and it never depends on hover.
         * This is the OTHER half of design §9.4's "both obviously
         * available" pair in grade mode: Reply lives on each card above;
         * flagging a missed line lives here, always visible, never behind
         * a menu.
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
                  aria-label={
                    effectiveMode === 'grade'
                      ? `Flag ${describeRange(selection)} for the student`
                      : `Add an annotation on ${describeRange(selection)}`
                  }
                >
                  {effectiveMode === 'grade' ? 'Flag this line' : 'Add note'}
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
                  {effectiveMode === 'grade' ? `Flag line ${focusLine}` : `Annotate line ${focusLine}`}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {orphanedTopLevel.length > 0 ? (
        /*
         * Anchors are never silently moved (design §9.4). If an annotation no
         * longer fits the code it was written against, it is shown here
         * rather than dropped or re-pointed at a line it was not about.
         */
        <section className={styles.orphans} aria-label="Annotations that no longer match this code">
          <h4 className={styles.orphansTitle}>
            {orphanedTopLevel.length} annotation{orphanedTopLevel.length === 1 ? '' : 's'} no longer match this code
          </h4>
          {orphanedTopLevel.map((annotation) => (
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
