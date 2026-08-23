'use client';

/*
 * The accept-invitation form (design §12, §13). Two shapes, one Server
 * Action:
 *
 *   needsAccount  the invited address has no account, so this registers one
 *                 (handle + password) AND enrols it where a course is
 *                 attached — one submission, one transaction on the API side.
 *   otherwise     the address already has an account and the invitee is
 *                 signed in as it, so there is nothing to fill in: one
 *                 button that enrols them.
 *
 * A progressively-enhanced Server Action form, same posture as LoginForm:
 * it works by ordinary submission with no client JS. The timezone is the
 * one thing JS contributes — `Intl.DateTimeFormat().resolvedOptions()` is
 * the only way to learn the browser's zone (design §15) — and it stays
 * optional, so a no-JS submission simply lands on the UTC default the API
 * already falls back to.
 */

import { useActionState, useEffect, useState } from 'react';
import type { AcceptFormState } from './actions';
import { acceptInviteAction } from './actions';
import styles from './accept.module.css';

const INITIAL_STATE: AcceptFormState = { error: null };

export default function AcceptForm({
  email,
  needsAccount,
  courseTitle,
}: {
  email: string;
  needsAccount: boolean;
  courseTitle: string | null;
}) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, INITIAL_STATE);
  const [timezone, setTimezone] = useState('');

  useEffect(() => {
    try {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
    } catch {
      setTimezone('');
    }
  }, []);

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="timezone" value={timezone} />

      {needsAccount ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="accept-handle">
              Handle
            </label>
            <input
              id="accept-handle"
              name="handle"
              type="text"
              autoComplete="username"
              required
              minLength={2}
              maxLength={31}
              pattern="[a-z0-9][a-z0-9_\-]{1,30}"
              className={styles.input}
              disabled={pending}
            />
            <p className={styles.hint}>
              Lower-case letters, numbers, hyphens and underscores. This is what other people see at
              /u/your-handle.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="accept-display-name">
              Display name <span className={styles.optional}>optional</span>
            </label>
            <input
              id="accept-display-name"
              name="displayName"
              type="text"
              autoComplete="name"
              maxLength={120}
              className={styles.input}
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="accept-password">
              Password
            </label>
            <input
              id="accept-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              className={styles.input}
              disabled={pending}
            />
            <p className={styles.hint}>At least 12 characters.</p>
          </div>
        </>
      ) : null}

      <button type="submit" className={styles.submitButton} disabled={pending} aria-busy={pending}>
        {pending
          ? 'Accepting…'
          : needsAccount
            ? courseTitle
              ? 'Create account and enrol'
              : 'Create account'
            : 'Accept and enrol'}
      </button>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
