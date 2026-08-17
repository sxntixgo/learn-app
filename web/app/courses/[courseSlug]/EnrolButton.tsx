'use client';

/*
 * Enrol / leave control (design §12, Task D/E). Quiet, existing tokens only
 * — same posture as the lesson reader's "Mark complete" control. The server
 * is the only thing that knows whether self-enrolling is actually allowed
 * (open vs restricted vs owned, design §12); this button always offers the
 * action and surfaces whatever the API says rather than re-deriving that
 * policy on the client.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enrolAction, unenrolAction } from './actions';
import styles from './course.module.css';

export interface EnrolButtonProps {
  courseSlug: string;
  enrolled: boolean;
}

export default function EnrolButton({ courseSlug, enrolled: initialEnrolled }: EnrolButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [enrolled, setEnrolled] = useState(initialEnrolled);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    if (isPending) return;
    startTransition(async () => {
      const result = enrolled ? await unenrolAction(courseSlug) : await enrolAction(courseSlug);
      if (result.ok) {
        setEnrolled(result.enrolment.enrolled);
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className={styles.enrolControl}>
      <button
        type="button"
        className={enrolled ? styles.leaveButton : styles.enrolButton}
        onClick={handleClick}
        disabled={isPending}
        aria-busy={isPending}
      >
        {isPending ? '…' : enrolled ? 'Leave course' : 'Enrol'}
      </button>
      {error ? (
        <p className={styles.enrolError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
