'use client';

/*
 * The owner's/admin's publish control (Task C/E, design §12). Only rendered
 * when the API says `canPublish` — the server has already decided this
 * actor may call course:visibility:set; the client never re-derives
 * ownership or role. A plain <select> + button rather than a fancier
 * toggle: three states (open/restricted/hidden), and this is a settings
 * control, not a place to spend delight (design §14).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CourseVisibility } from '../../../src/lib/api';
import { setVisibilityAction } from './actions';
import styles from './course.module.css';

export interface PublishControlProps {
  courseSlug: string;
  visibility: CourseVisibility;
}

const OPTIONS: { value: CourseVisibility; label: string }[] = [
  { value: 'hidden', label: 'Hidden — draft, only you can see it' },
  { value: 'restricted', label: 'Restricted — listed, invite to enrol' },
  { value: 'open', label: 'Open — anyone may self-enrol' },
];

export default function PublishControl({ courseSlug, visibility: initial }: PublishControlProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState(initial);
  const [pendingValue, setPendingValue] = useState<CourseVisibility>(initial);
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    setError(null);
    if (isPending || pendingValue === visibility) return;
    startTransition(async () => {
      const result = await setVisibilityAction(courseSlug, pendingValue);
      if (result.ok) {
        setVisibility(result.visibility);
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className={styles.publishControl}>
      <label className={styles.publishLabel} htmlFor="course-visibility">
        Visibility
      </label>
      <div className={styles.publishRow}>
        <select
          id="course-visibility"
          className={styles.publishSelect}
          value={pendingValue}
          onChange={(e) => setPendingValue(e.target.value as CourseVisibility)}
          disabled={isPending}
        >
          {OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.publishButton}
          onClick={handleSave}
          disabled={isPending || pendingValue === visibility}
          aria-busy={isPending}
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error ? (
        <p className={styles.publishError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
