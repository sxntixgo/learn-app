'use client';

/*
 * One account on the admin roster: its roles, and its platform-invite budget
 * (design §5, §12).
 *
 * ROLES ARE CHECKBOXES BECAUSE ROLES ARE A SET (§5: "roles are a set, not a
 * ladder ... student and teacher combine freely"). A dropdown would encode
 * the ladder the design explicitly rejects. `admin` is in the same set —
 * §5.1 makes it exclusive of the other two, and that exclusivity is a
 * database constraint, so this screen offers the checkbox and shows the
 * API's refusal rather than pre-empting it with a rule of its own that
 * could drift from the constraint.
 *
 * THE BUDGET IS AN ABSOLUTE NUMBER, NOT A DELTA — same reason the API sets
 * rather than increments: two admins granting "+5" a minute apart compound
 * into a number neither intended.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminUser } from '../../../src/lib/api';
import { setInviteBudgetAction, setUserRoleAction } from './actions';
import styles from './people.module.css';

const ROLES = ['student', 'teacher', 'admin'] as const;

export default function PersonCard({ person }: { person: AdminUser }) {
  const router = useRouter();
  const [roles, setRoles] = useState<string[]>(person.roles);
  const [budget, setBudget] = useState(String(person.inviteBudget));
  const [savedBudget, setSavedBudget] = useState(person.inviteBudget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function toggleRole(role: (typeof ROLES)[number], granted: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await setUserRoleAction(person.id, { role, granted });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRoles(result.user.roles);
    setNote(`${granted ? 'Granted' : 'Removed'} ${role}.`);
    router.refresh();
  }

  async function saveBudget(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const value = Number(budget);
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await setInviteBudgetAction(person.id, Number.isFinite(value) ? value : -1);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSavedBudget(result.user.inviteBudget);
    setBudget(String(result.user.inviteBudget));
    setNote(`Invite budget set to ${result.user.inviteBudget}.`);
    router.refresh();
  }

  const name = person.displayName ?? (person.handle ? `@${person.handle}` : 'Unnamed account');
  const isAdmin = roles.includes('admin');

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{name}</span>
        {person.handle ? <span className={styles.handle}>@{person.handle}</span> : null}
        <span className={styles.email}>{person.email ?? 'no email'}</span>
      </div>

      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className={styles.legend}>Roles</legend>
        <div className={styles.roleRow}>
          {ROLES.map((role) => (
            <label key={role} className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(e) => toggleRole(role, e.target.checked)}
              />
              <span>{role}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <form className={styles.budgetForm} onSubmit={saveBudget}>
        <label className={styles.label} htmlFor={`budget-${person.id}`}>
          Platform-invite budget
        </label>
        <div className={styles.budgetRow}>
          <input
            id={`budget-${person.id}`}
            className={styles.budgetInput}
            type="number"
            min={0}
            max={1000}
            value={budget}
            disabled={busy || isAdmin}
            onChange={(e) => setBudget(e.target.value)}
          />
          <button className={styles.saveButton} type="submit" disabled={busy || isAdmin || budget === String(savedBudget)}>
            Save
          </button>
        </div>
        <p className={styles.hint}>
          {isAdmin
            ? 'An admin’s platform invitations are unlimited (§12), so a budget would mean nothing here.'
            : 'How many accounts this person may create. Spent on issue, returned if the invitation expires or is revoked.'}
        </p>
      </form>

      {error !== null ? (
        <p className={styles.requestError} role="alert">
          {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className={styles.note} role="status">
          {note}
        </p>
      ) : null}
    </li>
  );
}
