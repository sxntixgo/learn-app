'use client';

/*
 * "Mark complete" control (design plan, phase 3 web §14: a completion
 * control is not a place to spend delight — quiet, existing tokens only).
 *
 * Only kind "lesson" gets a live button; exercises and quizzes complete
 * through submission/passing in later phases and the API 409s if asked
 * directly, so those kinds get a short explanatory note instead of a dead
 * button (or a button that can fail for a reason the reader can't act on).
 *
 * The page above stays a server component; this is the one piece that needs
 * client state (pending / already-submitted) to avoid a double submit.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Lesson } from '../../../../../src/lib/api';
import { markLessonCompleteAction } from './actions';
import styles from './lesson.module.css';

export interface MarkCompleteButtonProps {
  courseSlug: string;
  lessonSlug: string;
  kind: Lesson['kind'];
  progress: Lesson['progress'];
}

export default function MarkCompleteButton({ courseSlug, lessonSlug, kind, progress }: MarkCompleteButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [complete, setComplete] = useState(progress?.state === 'complete');
  const [error, setError] = useState<string | null>(null);

  if (kind !== 'lesson') {
    const reason = kind === 'exercise' ? 'submitting your answer' : 'passing the quiz';
    return <p className={styles.progressNote}>Completion for this {kind} comes from {reason}, not this control.</p>;
  }

  if (complete) {
    return <p className={styles.progressDone}>Completed</p>;
  }

  function handleClick() {
    setError(null);
    // isPending already guards the button itself, but a second guard here
    // costs nothing and keeps this correct if the click handler is ever
    // wired somewhere isPending doesn't reach.
    if (isPending) return;
    startTransition(async () => {
      const result = await markLessonCompleteAction(courseSlug, lessonSlug);
      if (result.ok) {
        setComplete(true);
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className={styles.progressControl}>
      <button
        type="button"
        className={styles.completeButton}
        onClick={handleClick}
        disabled={isPending}
        aria-busy={isPending}
      >
        {isPending ? 'Marking complete…' : 'Mark complete'}
      </button>
      {error ? (
        <p className={styles.progressError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
