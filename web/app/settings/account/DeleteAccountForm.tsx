'use client';

/*
 * The typed-confirmation delete form (plan: "Account deletion and data
 * export"). Progressively-enhanced Server Action form, same posture as
 * LoginForm/ProfileSettingsForm: `useActionState` binds `deleteAccountAction`
 * directly to the <form>, so it works via ordinary submission with no client
 * JS, and JS only upgrades it to update in place and disable the button
 * mid-request.
 *
 * The typed handle is checked SERVER-SIDE (api/src/routes/me.ts) — this
 * component does not compare it against anything client-side, deliberately.
 * Requiring it here is about not surprising anyone with an accidental
 * click, not about enforcement; a stray DELETE without a body, or with the
 * wrong handle, still 400s from the API regardless of what this form does.
 */

import { useActionState } from 'react';
import type { DeleteAccountFormState } from './actions';
import { deleteAccountAction } from './actions';
import styles from './account.module.css';

const INITIAL_STATE: DeleteAccountFormState = { error: null };

export default function DeleteAccountForm() {
  const [state, formAction, pending] = useActionState(deleteAccountAction, INITIAL_STATE);

  return (
    <form action={formAction} className={styles.deleteForm}>
      <label className={styles.confirmLabel} htmlFor="confirm-handle">
        Type your account handle to confirm
      </label>
      <input
        id="confirm-handle"
        name="confirmHandle"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        required
        className={styles.confirmInput}
        disabled={pending}
      />
      <button type="submit" className={styles.deleteButton} disabled={pending} aria-busy={pending}>
        {pending ? 'Deleting…' : 'Permanently delete my account'}
      </button>
      {/* A live region: an error that only appears visually is invisible to
          a screen-reader user (design §14), same as every other form in
          this app. */}
      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
