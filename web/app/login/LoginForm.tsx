'use client';

/*
 * The email/password form (Task C). A progressively-enhanced Server Action
 * form — `useActionState` binds `loginAction` directly to the <form>, same
 * posture as ThemeToggle's plain forms: it works via ordinary submission
 * with no client JS, and JS only upgrades it to update in place instead of
 * a full navigation. `next` travels as a hidden field rather than a closure
 * over the action, so the plain-HTML-form fallback still carries it.
 */

import { useActionState } from 'react';
import type { LoginFormState } from './actions';
import { loginAction } from './actions';
import styles from './login.module.css';

// Not exported from actions.ts alongside the action itself: a 'use server'
// file may only export async functions (Next.js requirement) — a plain
// object export like this one fails the build with "A 'use server' file can
// only export async functions, found object."
const INITIAL_STATE: LoginFormState = { error: null };

export default function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE);

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="next" value={next} />

      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={styles.input}
          disabled={pending}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={styles.input}
          disabled={pending}
        />
      </div>

      <button type="submit" className={styles.submitButton} disabled={pending} aria-busy={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
