'use client';

/*
 * Admin-only ownership transfer (design §5: course:ownership:transfer is an
 * admin-exclusive cell — a teacher never sees this control, only
 * PublishControl). A plain user-id field rather than a picker: there is no
 * "search teachers" endpoint in this API, and inventing one is out of scope
 * for closing the gap this page exists to close.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { transferOwnershipAction } from './actions';
import styles from './courses.module.css';

export interface TransferOwnerControlProps {
  courseSlug: string;
  ownerId: string | null;
}

export default function TransferOwnerControl({ courseSlug, ownerId }: TransferOwnerControlProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(ownerId ?? '');
  const [error, setError] = useState<string | null>(null);

  function transferTo(nextOwnerId: string | null) {
    setError(null);
    if (isPending) return;
    startTransition(async () => {
      const result = await transferOwnershipAction(courseSlug, nextOwnerId);
      if (result.ok) {
        setValue(result.course.ownerId ?? '');
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className={styles.transferControl}>
      <label className={styles.transferLabel} htmlFor={`owner-${courseSlug}`}>
        Owner (user id)
      </label>
      <div className={styles.transferRow}>
        <input
          id={`owner-${courseSlug}`}
          className={styles.transferInput}
          type="text"
          placeholder="No owner"
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className={styles.transferButton}
          onClick={() => transferTo(value.trim() === '' ? null : value.trim())}
          disabled={isPending || value.trim() === (ownerId ?? '')}
          aria-busy={isPending}
        >
          {isPending ? 'Saving…' : 'Set owner'}
        </button>
        {ownerId !== null ? (
          <button
            type="button"
            className={styles.transferButton}
            onClick={() => transferTo(null)}
            disabled={isPending}
          >
            Remove owner
          </button>
        ) : null}
      </div>
      {error !== null ? (
        <p className={styles.transferError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
