'use client';

/*
 * Changing your own password — the only credential-change path there is.
 * Design §2 excludes password-reset mail and SMTP, so there is no "forgot
 * password" behind this and no administrator who can do it for you.
 *
 * Three fields, and the third is not sent anywhere: the confirmation is
 * compared in the Server Action and discarded. A password typed twice is a
 * typing aid, not something the API needs to know about, and every field that
 * reaches the request body is another place a secret could be logged.
 *
 * `type="password"` with the right autocomplete tokens throughout, so a
 * password manager offers to fill the current one and to save the new one.
 * Getting these wrong is why so many change-password forms quietly break
 * managers.
 */

import { useRef, useState, useTransition } from 'react';
import { MIN_PASSWORD_LENGTH } from '../../../src/lib/password-rules';
import { changePasswordAction } from './actions';
import styles from './account.module.css';

export default function ChangePasswordForm() {
  const form = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    const data = new FormData(event.currentTarget);
    setError(null);
    setDone(false);

    startTransition(async () => {
      const result = await changePasswordAction(data);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDone(true);
      form.current?.reset();
    });
  }

  return (
    <form ref={form} className={styles.passwordForm} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="currentPassword">
          Current password
        </label>
        <input
          className={styles.input}
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="newPassword">
          New password
        </label>
        <input
          className={styles.input}
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={isPending}
          aria-describedby="password-rule"
        />
        <p className={styles.hint} id="password-rule">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="confirmPassword">
          Confirm new password
        </label>
        <input
          className={styles.input}
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={isPending}
        />
      </div>

      <button className={styles.save} type="submit" disabled={isPending}>
        {isPending ? 'Changing…' : 'Change password'}
      </button>

      <p aria-live="polite" className={error ? styles.error : styles.saved}>
        {error ??
          (done
            ? 'Your password has been changed. Every other session has been signed out; this one is still active.'
            : '')}
      </p>
    </form>
  );
}
