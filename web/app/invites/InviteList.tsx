'use client';

/*
 * The invitation table (design §12: "admins get a screen listing every
 * invite with issuer and status, and all privileged actions ... are written
 * to audit_log"). The same component serves both scopes — the API decides
 * which rows an actor sees, so an admin gets the whole instance and a
 * teacher gets their own, and neither needs a different screen.
 *
 * THE ISSUER COLUMN IS THE POINT. Teachers can create accounts now, so
 * "who let this person in" has to be visible without opening the audit log.
 * It renders for every viewer, not only admins: a teacher's own list shows
 * only their own name, which costs nothing and keeps one component.
 *
 * Revoke is a real button, never a hover-revealed one (design §14): a
 * pointer-only affordance is invisible on the 375px layout this app is
 * built for first.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Invite } from '../../src/lib/api';
import { budgetNote, canRevoke, inviteScopeLabel, inviteStatusLabel, issuerLabel } from '../../src/lib/invites';
import { formatOccurredAt } from '../../src/lib/activity';
import { revokeInviteAction } from './actions';
import styles from './invites.module.css';

export default function InviteList({ invites, timezone }: { invites: Invite[]; timezone: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke(invite: Invite) {
    if (busyId !== null) return;
    setBusyId(invite.id);
    setError(null);
    const result = await revokeInviteAction(invite.id);
    setBusyId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  if (invites.length === 0) {
    return <p className={styles.empty}>No invitations yet. The first one you issue shows up here.</p>;
  }

  return (
    <>
      {error !== null ? (
        <p className={styles.requestError} role="alert">
          {error}
        </p>
      ) : null}
      <ul className={styles.list}>
        {invites.map((invite) => {
          const created = formatOccurredAt(invite.createdAt, timezone);
          const expires = formatOccurredAt(invite.expiresAt, timezone);
          const budget = budgetNote(invite);
          return (
            <li key={invite.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.statusPill} data-status={invite.status}>
                  {inviteStatusLabel(invite.status)}
                </span>
                <span className={styles.email}>{invite.email}</span>
                <time className={styles.time} dateTime={created.iso}>
                  {created.relative}
                </time>
              </div>

              <dl className={styles.meta}>
                <div className={styles.metaRow}>
                  <dt>Grants</dt>
                  <dd className={styles.metaValue}>{inviteScopeLabel(invite)}</dd>
                </div>
                <div className={styles.metaRow}>
                  <dt>Issued by</dt>
                  <dd className={styles.metaValue}>{issuerLabel(invite)}</dd>
                </div>
                <div className={styles.metaRow}>
                  <dt>{invite.status === 'expired' ? 'Expired' : 'Expires'}</dt>
                  <dd className={styles.metaValue}>
                    <time dateTime={expires.iso}>{expires.absolute}</time>
                  </dd>
                </div>
                {budget !== null ? (
                  <div className={styles.metaRow}>
                    <dt>Budget</dt>
                    <dd className={styles.metaValue}>{budget}</dd>
                  </div>
                ) : null}
              </dl>

              {canRevoke(invite) ? (
                <button
                  className={styles.revokeButton}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => handleRevoke(invite)}
                >
                  {busyId === invite.id ? 'Revoking…' : 'Revoke'}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
