'use client';

/*
 * Joins the annotatable `code` block to the submissions API (Phase 8, design
 * §9.1/§9.4). AnnotatableCode.tsx only ever surfaced student annotations
 * through `onChange`; this is the thing that persists them, aggregated
 * across every annotatable block in the lesson into ONE submission (a
 * submission belongs to the lesson, not to a single block — `blockIndex`
 * is how one annotation says which block it's on).
 *
 * SAVE STRATEGY — autosave, not an explicit "Save draft" button. The choice
 * is deliberate: AnnotatableCode's composer already gates every change
 * behind its own explicit action (Save annotation / Edit / Delete), so
 * `onChange` here fires once per COMMITTED annotation, never per keystroke.
 * A second manual save step on top of that would not buy legibility — it
 * would just be a second click for something the student already clicked
 * once — and it is strictly worse for not losing work: closing the tab
 * right after "Save annotation" must not lose the note. Autosave with a
 * visible, honest status line is how neither student is left guessing:
 *
 *   - "Nothing saved yet" / "Draft saved." / "Saving…" is always rendered
 *     (a `role="status"` region — announced, not hover-only), never blank.
 *   - A failed save shows the API's own message AND a Retry button, and
 *     Submit is disabled until the failure is resolved — submitting sends
 *     no annotations of its own (POST .../submit takes no body; it hands in
 *     whatever is already stored), so submitting past an unsaved failure
 *     would silently hand in stale work. That is the one thing this
 *     component refuses to let happen quietly.
 *
 * READ-ONLY ON SUBMIT — once `submission.status !== 'draft'`, every code
 * block renders from `submission.snapshot`, not from the live lesson (design
 * §9.4's central rule), and AnnotatableCode's own `readOnly` prop suppresses
 * the composer and the student's Edit/Delete controls — the UI does not
 * invite an action the API would refuse (409) anyway.
 */

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Lesson, Submission, SubmissionAnnotationInput } from '../../../../../src/lib/api';
import type { components } from '../../../../../src/lib/api-types';
import type { Annotation, AuthorAnnotationInput } from '../../../../../src/lib/annotations';
import { fromSubmissionAnnotations, toSubmissionAnnotationInputs } from '../../../../../src/lib/annotations';
import AnnotatableCode from './AnnotatableCode';
import Quiz from './Quiz';
import { saveSubmissionDraftAction, submitExerciseAction } from './actions';
import styles from './lesson.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;
type QuizBlock = Extract<Block, { type: 'quiz' }>;

/* Same local widening page.tsx uses: author annotations ride along on the
 * stored block but aren't in openapi's CodeBlock yet outside this pair. */
type AnnotatedCodeBlock = CodeBlock & { annotations?: AuthorAnnotationInput[] };

export interface ExercisePanelProps {
  courseSlug: string;
  lessonSlug: string;
  /**
   * The blocks to render: the SNAPSHOT when a submission exists (any status
   * — design §9.4 anchors are only ever valid against the stored snapshot,
   * not the live lesson), or the live lesson's own blocks when the student
   * has not started yet and there is no snapshot to defer to.
   */
  blocks: Block[];
  /** Shiki HTML for each `code` block, keyed by its (stringified) index into `blocks`. */
  highlighted: Record<string, string>;
  initialSubmission: Submission | null;
  progress: Lesson['progress'];
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function initialAnnotationsByBlock(blocks: Block[], submission: Submission | null): Record<number, Annotation[]> {
  const map: Record<number, Annotation[]> = {};
  if (!submission) return map;
  blocks.forEach((block, index) => {
    if (block.type !== 'code') return;
    const forBlock = fromSubmissionAnnotations(submission.annotations, index);
    if (forBlock.length > 0) map[index] = forBlock;
  });
  return map;
}

export default function ExercisePanel({
  courseSlug,
  lessonSlug,
  blocks,
  highlighted,
  initialSubmission,
  progress,
}: ExercisePanelProps) {
  const router = useRouter();
  const [submission, setSubmission] = useState<Submission | null>(initialSubmission);
  // A submission that already exists and is a draft IS saved — seeded from
  // that, not from 'idle', or a revisited draft would falsely claim to be
  // unsaved until the student touches it again.
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(initialSubmission ? 'saved' : 'idle');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(null);
  const [isSubmitPending, startSubmitTransition] = useTransition();

  // The authoritative "what would a save send" state. A ref, not React
  // state: PUT replaces the whole submission's annotations, so every save
  // needs every block's current set, not just the one that just changed —
  // and reading it synchronously (rather than via a stale closure over
  // state) is what keeps two saves fired in quick succession from racing
  // each other's payload.
  const annotationsRef = useRef<Record<number, Annotation[]>>(initialAnnotationsByBlock(blocks, initialSubmission));
  const saveSeqRef = useRef(0);

  // Design §9.1: submitted or returned is finished work. The API refuses a
  // further draft write (409); this is what keeps the UI from ever offering
  // one.
  const readOnly = submission !== null && submission.status !== 'draft';

  async function saveDraft() {
    const seq = ++saveSeqRef.current;
    setSaveStatus('saving');
    setSaveErrorMessage(null);

    const payload: SubmissionAnnotationInput[] = Object.entries(annotationsRef.current).flatMap(([index, anns]) =>
      toSubmissionAnnotationInputs(anns, Number(index)),
    );

    const result = await saveSubmissionDraftAction(courseSlug, lessonSlug, payload);

    // A newer save has since started (another edit landed while this one was
    // in flight) — its own result will settle the status; an older response
    // must never overwrite a fresher one.
    if (seq !== saveSeqRef.current) return;

    if (result.ok) {
      setSubmission(result.submission);
      setSaveStatus('saved');
    } else {
      setSaveStatus('error');
      setSaveErrorMessage(result.message);
    }
  }

  function handleBlockChange(blockIndex: number, next: Annotation[]) {
    annotationsRef.current = { ...annotationsRef.current, [blockIndex]: next };
    void saveDraft();
  }

  function handleSubmit() {
    if (readOnly || isSubmitPending) return;
    setSubmitErrorMessage(null);
    startSubmitTransition(async () => {
      const result = await submitExerciseAction(courseSlug, lessonSlug);
      if (result.ok) {
        setSubmission(result.submission);
        // Refreshes the server-rendered page so MarkCompleteButton (and any
        // other progress-derived UI) picks up the newly-complete lesson —
        // same technique Quiz.tsx uses on a pass.
        router.refresh();
      } else {
        setSubmitErrorMessage(result.message);
      }
    });
  }

  // Submitting sends no annotations of its own — it hands in whatever the
  // API already has stored. Submitting while the latest edit hasn't saved
  // (still in flight, or failed) would silently hand in a stale draft, so
  // both states block the button rather than letting that happen quietly.
  const submitDisabled = isSubmitPending || readOnly || saveStatus === 'saving' || saveStatus === 'error';

  return (
    <>
      <div className={styles.body}>
        {blocks.map((block, index) => {
          if (block.type === 'prose') {
            return <div key={index} className={styles.prose} dangerouslySetInnerHTML={{ __html: block.html }} />;
          }
          if (block.type === 'code') {
            const codeBlock = block as AnnotatedCodeBlock;
            return (
              <div key={index} className={styles.code}>
                <AnnotatableCode
                  // Remounts only when the submission's STATUS changes (a
                  // draft going read-only on submit) — never on an
                  // in-between autosave, which would blow away whatever the
                  // student is mid-typing in another block's composer.
                  key={`${index}-${submission?.status ?? 'new'}`}
                  html={highlighted[String(index)] ?? ''}
                  lang={codeBlock.lang ?? undefined}
                  mode="annotate"
                  readOnly={readOnly}
                  authorAnnotations={codeBlock.annotations}
                  initialAnnotations={submission ? fromSubmissionAnnotations(submission.annotations, index) : []}
                  onChange={readOnly ? undefined : (next) => handleBlockChange(index, next)}
                />
              </div>
            );
          }
          return (
            <Quiz
              key={index}
              courseSlug={courseSlug}
              lessonSlug={lessonSlug}
              quiz={block as QuizBlock}
              progress={progress}
            />
          );
        })}
      </div>

      <div className={styles.exercise}>
        {readOnly ? (
          <p className={styles.progressDone}>{submission?.status === 'returned' ? 'Returned' : 'Submitted'}</p>
        ) : (
          <>
            <p className={styles.exerciseSaveStatus} role="status">
              {saveStatus === 'idle'
                ? 'Nothing saved yet. Add a note, or press Submit to hand in an empty response.'
                : null}
              {saveStatus === 'saving' ? 'Saving…' : null}
              {saveStatus === 'saved' ? 'Draft saved.' : null}
              {saveStatus === 'error' ? 'Your last change did not save.' : null}
            </p>
            {saveStatus === 'error' ? (
              <p className={styles.progressError} role="alert">
                {saveErrorMessage ?? 'Could not save your draft.'}{' '}
                <button type="button" className={styles.quizRetakeButton} onClick={() => void saveDraft()}>
                  Retry save
                </button>
              </p>
            ) : null}
            <div className={styles.progressControl}>
              <button
                type="button"
                className={styles.completeButton}
                onClick={handleSubmit}
                disabled={submitDisabled}
                aria-busy={isSubmitPending}
              >
                {isSubmitPending ? 'Submitting…' : 'Submit exercise'}
              </button>
              {saveStatus === 'saving' ? (
                <p className={styles.progressNote}>Waiting for your last change to save before you can submit.</p>
              ) : null}
              {saveStatus === 'error' ? (
                <p className={styles.progressNote}>Save your latest change before submitting.</p>
              ) : null}
              {submitErrorMessage ? (
                <p className={styles.progressError} role="alert">
                  {submitErrorMessage}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}
