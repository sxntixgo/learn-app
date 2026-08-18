'use client';

/*
 * The interactive half of the grading view (design §9.4, Phase 9): renders
 * the submission's snapshot through AnnotatableCode in its new `grade` mode
 * (reply to a student annotation, or flag a line they missed — both always-
 * visible controls, never one hidden behind the other), the rubric form, and
 * the deliberate "return to student" action.
 *
 * EVERYTHING IS STAGED LOCALLY UNTIL "RETURN". The grade API has no partial
 * save — every POST .../grade call moves the submission to `returned`
 * (api/src/routes/submissions.ts's own module comment: "status moves to
 * returned unconditionally"). So a reply, a flagged line, or a rubric score
 * is never sent the moment it is typed; they accumulate in this component's
 * own state (mirroring ExercisePanel's `annotationsRef` pattern) and go out
 * together in exactly one network call, behind exactly one clearly-labelled
 * button. That is what makes "returning is its own deliberate control, not
 * a side effect of saving scores" true: nothing here can return a submission
 * except that one button.
 *
 * THE RUBRIC NEVER DISCARDS TYPED WORK. `parseRubricInputs` validates every
 * criterion client-side BEFORE any network call — the API's own 400 for an
 * incomplete score set is a backstop, not the primary defence — and on
 * EITHER kind of failure (client-side or the API's own) the form's state is
 * left exactly as the teacher left it. Nothing is ever cleared on failure.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GradeRequest, Submission } from '../../../../../../../src/lib/api';
import type { components } from '../../../../../../../src/lib/api-types';
import type { Annotation, AuthorAnnotationInput } from '../../../../../../../src/lib/annotations';
import { fromGradedAnnotations, toGradeAnnotationInputs } from '../../../../../../../src/lib/annotations';
import { findRubricCriteria, parseRubricInputs, seedRubricInputs } from '../../../../../../../src/lib/rubric';
import type { RubricScoreInputs } from '../../../../../../../src/lib/rubric';
import AnnotatableCode from '../../AnnotatableCode';
import { gradeSubmissionAction } from './actions';
import styles from './grading-view.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;
type AnnotatedCodeBlock = CodeBlock & { annotations?: AuthorAnnotationInput[] };

export interface GradingFormProps {
  courseSlug: string;
  lessonSlug: string;
  /** The student's user id — the submission's owner. */
  userId: string;
  studentLabel: string;
  /** The submission's frozen snapshot (design §9.4) — never the live lesson. */
  blocks: Block[];
  highlighted: Record<number, string>;
  initialSubmission: Submission;
}

type ReturnStatus = 'idle' | 'saving' | 'error';

function originLabelFor(studentLabel: string) {
  return (annotation: Annotation): string => {
    if (annotation.origin === 'author') return 'Author';
    if (annotation.origin === 'teacher') return 'You';
    return studentLabel;
  };
}

export default function GradingForm({
  courseSlug,
  lessonSlug,
  userId,
  studentLabel,
  blocks,
  highlighted,
  initialSubmission,
}: GradingFormProps) {
  const router = useRouter();
  const [submission, setSubmission] = useState<Submission>(initialSubmission);
  const [returnStatus, setReturnStatus] = useState<ReturnStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const criteria = findRubricCriteria(blocks);
  const [rubricInputs, setRubricInputs] = useState<RubricScoreInputs>(() =>
    seedRubricInputs(criteria, initialSubmission.rubricScores),
  );
  const [rubricProblems, setRubricProblems] = useState<Record<string, string>>({});

  // Same ref-of-current-state pattern as ExercisePanel's annotationsRef:
  // every code block reports its FULL current annotation list (existing +
  // any locally staged replies/flags) on every change, and `handleReturn`
  // reads all of them synchronously rather than trusting stale closures.
  const pendingRef = useRef<Record<number, Annotation[]>>({});

  const originLabel = originLabelFor(studentLabel);

  function handleBlockChange(blockIndex: number, next: Annotation[]) {
    pendingRef.current = { ...pendingRef.current, [blockIndex]: next };
  }

  function handleRubricInput(criterion: string, value: string) {
    setRubricInputs((current) => ({ ...current, [criterion]: value }));
    if (rubricProblems[criterion]) {
      setRubricProblems((current) => {
        const next = { ...current };
        delete next[criterion];
        return next;
      });
    }
  }

  async function handleReturn() {
    if (returnStatus === 'saving') return;
    setErrorMessage(null);

    const parsed = parseRubricInputs(criteria, rubricInputs);
    if (!parsed.ok) {
      setRubricProblems(parsed.problems);
      setReturnStatus('error');
      setErrorMessage('Score every criterion before returning — nothing you typed was lost.');
      return;
    }
    setRubricProblems({});

    const annotations = Object.entries(pendingRef.current).flatMap(([blockIndex, list]) =>
      toGradeAnnotationInputs(list, Number(blockIndex)),
    );

    const body: GradeRequest = { rubricScores: parsed.scores, annotations };

    setReturnStatus('saving');
    const result = await gradeSubmissionAction(courseSlug, lessonSlug, userId, body);

    if (result.ok) {
      setSubmission(result.submission);
      pendingRef.current = {};
      setRubricInputs(seedRubricInputs(criteria, result.submission.rubricScores));
      setReturnStatus('idle');
      // Refreshes any server-rendered chrome (e.g. this page's own status
      // line above the form) so it reflects the fresh submittedAt/returnedAt
      // without a full navigation.
      router.refresh();
    } else {
      setReturnStatus('error');
      setErrorMessage(result.message);
    }
  }

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
                  // Remounts after a successful return so a fresh
                  // initialAnnotations (server ids, nothing pending) replaces
                  // whatever was staged locally — see the module comment.
                  key={`${index}-${submission.updatedAt}`}
                  html={highlighted[index] ?? ''}
                  lang={codeBlock.lang ?? undefined}
                  mode="grade"
                  authorAnnotations={codeBlock.annotations}
                  initialAnnotations={fromGradedAnnotations(submission.annotations, index, userId)}
                  onChange={(next) => handleBlockChange(index, next)}
                  originLabel={originLabel}
                />
              </div>
            );
          }
          // Rubric blocks are scored in the dedicated form below, not
          // rendered a second time here; a `quiz` block never reaches an
          // exercise lesson (design §9.1: one lesson kind, one meaning).
          return null;
        })}
      </div>

      {criteria.length > 0 ? (
        <section className={styles.rubric} aria-labelledby="grading-rubric-heading">
          <h2 className={styles.rubricTitle} id="grading-rubric-heading">
            Rubric
          </h2>
          <ul className={styles.rubricList}>
            {criteria.map((criterion) => {
              const fieldId = `rubric-${criterion.name.replace(/\s+/g, '-')}`;
              const problem = rubricProblems[criterion.name];
              return (
                <li key={criterion.name} className={styles.rubricRow}>
                  <label className={styles.rubricLabel} htmlFor={fieldId}>
                    <span className={styles.rubricName}>
                      {criterion.name}
                      {criterion.track ? <span className={styles.rubricTrack}>{criterion.track}</span> : null}
                    </span>
                    <span className={styles.rubricMax}>max {criterion.max}</span>
                  </label>
                  <input
                    id={fieldId}
                    className={styles.rubricInput}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={criterion.max}
                    step="any"
                    value={rubricInputs[criterion.name] ?? ''}
                    onChange={(event) => handleRubricInput(criterion.name, event.target.value)}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? `${fieldId}-problem` : undefined}
                  />
                  {problem ? (
                    <p className={styles.rubricProblem} id={`${fieldId}-problem`} role="alert">
                      {problem}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className={styles.returnControl}>
        <p className={styles.returnStatus} role="status">
          {returnStatus === 'saving'
            ? 'Returning…'
            : submission.status === 'returned'
              ? 'Returned to the student.'
              : 'Not yet returned — the student cannot see any of this until you return it.'}
        </p>
        {returnStatus === 'error' && errorMessage ? (
          <p className={styles.returnError} role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button
          type="button"
          className={styles.returnButton}
          onClick={() => void handleReturn()}
          disabled={returnStatus === 'saving'}
          aria-busy={returnStatus === 'saving'}
        >
          {returnStatus === 'saving' ? 'Returning…' : 'Return to student'}
        </button>
      </div>
    </>
  );
}
