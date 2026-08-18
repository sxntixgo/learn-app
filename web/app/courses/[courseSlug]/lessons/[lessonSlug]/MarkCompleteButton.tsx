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
import type { AwardNotice, Lesson } from '../../../../../src/lib/api';
import { markLessonCompleteAction } from './actions';
import AwardAnnouncement from './AwardAnnouncement';
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
  // What THIS click earned (design §9.3). Kept in state rather than read
  // from a refreshed server render so the panel appears the instant the
  // write returns — which is the point of evaluating synchronously.
  const [awarded, setAwarded] = useState<AwardNotice | undefined>(undefined);

  // Checked BEFORE the kind branch below: once a quiz is passed (Task C —
  // "a passed quiz shows its state on revisit") or an exercise is
  // submitted (Phase 8), the lesson IS complete, and the note about how
  // completion works is no longer the useful thing to show — the state is.
  if (complete) {
    return (
      <>
        <p className={styles.progressDone}>Completed</p>
        <AwardAnnouncement awarded={awarded} />
      </>
    );
  }

  if (kind !== 'lesson') {
    const reason = kind === 'exercise' ? 'submitting your answer' : 'passing the quiz';
    return <p className={styles.progressNote}>Completion for this {kind} comes from {reason}, not this control.</p>;
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
        setAwarded(result.progress.awarded);
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
