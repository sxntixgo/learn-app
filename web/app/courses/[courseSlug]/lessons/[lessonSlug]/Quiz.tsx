'use client';

/*
 * The quiz block (Task C, design §9.1/§6.3). Quizzes are the one lesson
 * kind that is NOT markable — they complete only by passing, scored
 * server-side against the stored block (which the browser never sees:
 * routes/courses.ts strips `correct` before this component's props even
 * exist). This component renders questions/choices, submits answers to the
 * scoring endpoint, and shows per-question feedback once a result comes
 * back — everything about "is this right" is the API's answer, not this
 * component's.
 *
 * Existing tokens only (design §14, phone-first): 44px choice rows, no
 * hover-only affordance (native radios carry their own keyboard/focus
 * support), and the container respects the same 46ch prose measure as the
 * rest of the reader at 375px and up.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Lesson, QuizSubmitRequest, QuizSubmitResult } from '../../../../../src/lib/api';
import type { components } from '../../../../../src/lib/api-types';
import { submitQuizAction } from './actions';
import AwardAnnouncement from './AwardAnnouncement';
import styles from './lesson.module.css';

type QuizBlock = Extract<components['schemas']['Block'], { type: 'quiz' }>;

export interface QuizProps {
  courseSlug: string;
  lessonSlug: string;
  quiz: QuizBlock;
  progress: Lesson['progress'];
  /**
   * The previous lesson's URL (PL6/P7's "← THE BASE CASE" back link, reused
   * here as the graded-not-passed footer's "LESSON" link — "have another
   * read of the material, then retry"). Undefined when this checkpoint is
   * the course's first lesson, in which case the LESSON link is simply
   * absent rather than pointing nowhere.
   */
  previousLessonHref?: string;
}

export default function Quiz({ courseSlug, lessonSlug, quiz, progress, previousLessonHref }: QuizProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Design §9.1: a passed quiz stays passed on revisit — seeded from the
  // lesson's own progress, not re-derived from a fresh attempt.
  const [passed, setPassed] = useState(progress?.state === 'complete');
  const [retaking, setRetaking] = useState(false);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [result, setResult] = useState<QuizSubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (passed && !retaking) {
    return (
      <div className={styles.quiz}>
        <p className={styles.quizPassed}>Passed this quiz.</p>
        <button
          type="button"
          className={styles.quizRetakeButton}
          onClick={() => {
            setRetaking(true);
            setResult(null);
            setAnswers({});
          }}
        >
          Retake quiz
        </button>
      </div>
    );
  }

  function selectChoice(questionIndex: number, choiceIndex: number) {
    if (isPending) return;
    setAnswers((prev) => ({ ...prev, [questionIndex]: choiceIndex }));
  }

  function handleSubmit() {
    setError(null);
    if (isPending) return;

    const payload: QuizSubmitRequest['answers'] = Object.entries(answers).map(([questionIndex, choiceIndex]) => ({
      questionIndex: Number(questionIndex),
      choiceIndex,
    }));

    startTransition(async () => {
      const outcome = await submitQuizAction(courseSlug, lessonSlug, payload);
      if (outcome.ok) {
        setResult(outcome.result);
        if (outcome.result.passed) {
          setPassed(true);
          setRetaking(false);
        }
        // Refreshes the server-rendered page so MarkCompleteButton (and
        // any other progress-derived UI on it) picks up the new state too.
        router.refresh();
      } else {
        setError(outcome.message);
      }
    });
  }

  const allAnswered = quiz.questions.every((_, questionIndex) => answers[questionIndex] !== undefined);
  const correctCount = result?.results.filter((r) => r.correct).length ?? 0;

  return (
    <div className={styles.quiz}>
      {/*
       * P7's graded banner: "N of M correct — not passed", a gold-bordered
       * card. `result.passed` can't actually reach this render in practice
       * (a passing submit also flips `passed` above, which returns the
       * terminal .quizPassed state instead before this paints) — styled
       * anyway rather than assuming that can never change.
       */}
      {result ? (
        <div className={styles.quizResultBanner} role="status">
          <p className={result.passed ? `${styles.quizResultHeading} ${styles.quizResultHeadingPass}` : styles.quizResultHeading}>
            {correctCount} of {quiz.questions.length} correct — {result.passed ? 'passed' : 'not passed'}
          </p>
          <p className={styles.quizResultBody}>
            {result.passed
              ? 'Nice work — this checkpoint is complete.'
              : "Have another read of the material, then retry. Attempts aren't limited and only your best result is recorded."}
          </p>
        </div>
      ) : null}

      {/*
       * Any attempt can earn something, not only a passing one: a failed
       * attempt still moves a track score, and a retake can be the first
       * 100 % (design §9.3, criteria.ts's `quiz_attempted` row). So this
       * reads `result.awarded` rather than gating on `result.passed`.
       */}
      <AwardAnnouncement awarded={result?.awarded} />

      {quiz.questions.map((question, questionIndex) => {
        const questionResult = result?.results.find((r) => r.questionIndex === questionIndex) ?? null;

        return (
          <fieldset key={questionIndex} className={styles.quizQuestion} disabled={isPending}>
            <legend className={styles.quizPrompt}>{question.prompt}</legend>
            <div className={styles.quizChoices}>
              {question.choices.map((choice, choiceIndex) => {
                const selected = answers[questionIndex] === choiceIndex;
                const isCorrectChoice = questionResult !== null && questionResult.correctChoiceIndex === choiceIndex;
                const isWrongPick =
                  questionResult !== null && questionResult.choiceIndex === choiceIndex && !questionResult.correct;

                // Not yet graded: a neutral "chosen" tint (selection isn't
                // correctness). Once graded, correctness classes replace it
                // — P7 shows both the student's own pick AND the actual
                // correct choice, whether or not they're the same row.
                const choiceClassName = [
                  styles.quizChoice,
                  !questionResult && selected ? styles.quizChoiceSelected : '',
                  isCorrectChoice ? styles.quizChoiceCorrect : '',
                  isWrongPick ? styles.quizChoiceWrong : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <label key={choiceIndex} className={choiceClassName}>
                    <input
                      type="radio"
                      name={`quiz-${lessonSlug}-q${questionIndex}`}
                      checked={selected}
                      onChange={() => selectChoice(questionIndex, choiceIndex)}
                      disabled={isPending}
                    />
                    <span>{choice.text}</span>
                    {/*
                     * The "✓" mark (P7) is decorative (aria-hidden); the
                     * sr-only text beside it carries the same fact for
                     * anyone not reading colour/glyphs off the row.
                     */}
                    {isCorrectChoice ? (
                      <>
                        <span className={styles.quizChoiceMark} aria-hidden="true">
                          ✓
                        </span>
                        <span className={styles.srOnly}>Correct answer.</span>
                      </>
                    ) : null}
                    {isWrongPick ? <span className={styles.srOnly}>Your answer — not correct.</span> : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <div className={styles.quizControl}>
        {result && !result.passed ? (
          // P7: graded and not passed — RETRY (resubmit) beside LESSON
          // (back to the material the back link above also points at).
          <div className={styles.quizRetryRow}>
            <button
              type="button"
              className={styles.quizRetryButton}
              onClick={handleSubmit}
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? 'Scoring…' : 'Retry'}
            </button>
            {previousLessonHref ? (
              <Link href={previousLessonHref} className={styles.quizLessonLink}>
                Lesson
              </Link>
            ) : null}
          </div>
        ) : (
          // PL6: nothing graded yet — one "CHECK ANSWERS" pill.
          <button
            type="button"
            className={styles.quizCheckButton}
            onClick={handleSubmit}
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? 'Scoring…' : 'Check answers'}
          </button>
        )}
        {!allAnswered && !result ? (
          <p className={styles.progressNote}>Unanswered questions count as incorrect.</p>
        ) : null}
        {error ? (
          <p className={styles.progressError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
