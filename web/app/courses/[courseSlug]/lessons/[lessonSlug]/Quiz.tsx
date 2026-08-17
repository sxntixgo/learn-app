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
import type { Lesson, QuizSubmitRequest, QuizSubmitResult } from '../../../../../src/lib/api';
import type { components } from '../../../../../src/lib/api-types';
import { submitQuizAction } from './actions';
import styles from './lesson.module.css';

type QuizBlock = Extract<components['schemas']['Block'], { type: 'quiz' }>;

export interface QuizProps {
  courseSlug: string;
  lessonSlug: string;
  quiz: QuizBlock;
  progress: Lesson['progress'];
}

export default function Quiz({ courseSlug, lessonSlug, quiz, progress }: QuizProps) {
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

  return (
    <div className={styles.quiz}>
      {result ? (
        <p className={result.passed ? styles.quizResultPass : styles.quizResultFail} role="status">
          {result.passed
            ? `Passed — ${Math.round(result.score * 100)}% correct.`
            : `Not yet — ${Math.round(result.score * 100)}% correct (need ${Math.round(result.pass * 100)}%).`}
        </p>
      ) : null}

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

                const choiceClassName = [
                  styles.quizChoice,
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
                  </label>
                );
              })}
            </div>
            {questionResult ? (
              <p className={questionResult.correct ? styles.quizFeedbackCorrect : styles.quizFeedbackWrong}>
                {questionResult.correct ? 'Correct.' : 'Not quite — the highlighted choice was correct.'}
              </p>
            ) : null}
          </fieldset>
        );
      })}

      <div className={styles.quizControl}>
        <button
          type="button"
          className={styles.completeButton}
          onClick={handleSubmit}
          disabled={isPending}
          aria-busy={isPending}
        >
          {isPending ? 'Scoring…' : result ? 'Submit again' : 'Submit answers'}
        </button>
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
