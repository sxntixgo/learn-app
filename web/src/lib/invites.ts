/*
 * Pure presentation helpers for the invitations screen and the audit log
 * (design §12), kept out of the components so they are testable without a
 * browser — same split as src/lib/imports.ts and src/lib/activity.ts.
 */

import type { Invite, InviteStatus, AuditEntry } from './api';

/** A short label for an invitation's status pill. */
export function inviteStatusLabel(status: InviteStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'accepted':
      return 'Accepted';
    case 'revoked':
      return 'Revoked';
    case 'expired':
      return 'Expired';
    default:
      return status;
  }
}

/** Only a pending invitation can be revoked — the other three are already terminal. */
export function canRevoke(invite: Invite): boolean {
  return invite.status === 'pending';
}

/**
 * Who issued this one, as §12's "listing every invite with issuer and
 * status" needs it. The handle is the stable identity and the display name
 * is decoration, so the handle wins when both exist; an issuer whose
 * account has since been deleted still shows as something honest rather
 * than a blank cell.
 */
export function issuerLabel(invite: Invite): string {
  if (invite.issuedByHandle) return `@${invite.issuedByHandle}`;
  if (invite.issuedByDisplayName) return invite.issuedByDisplayName;
  return 'a deleted account';
}

/**
 * What this invitation grants, in one line: the two columns of §12's table
 * (platform vs course) plus the fact that actually matters to an admin
 * reading the list — whether it creates an account, and whether someone
 * paid a unit of budget for it.
 */
export function inviteScopeLabel(invite: Invite): string {
  const where = invite.kind === 'course' ? `Course: ${invite.courseTitle ?? invite.courseSlug ?? 'unknown'}` : 'Platform';
  const account = invite.createsAccount ? 'creates an account' : 'existing account';
  return `${where} · ${account}`;
}

/**
 * What happened to the unit of budget this invitation took, or null when it
 * never took one (an admin's invite is unlimited, §12). An accepted invite
 * is deliberately NOT described as refundable: the unit bought an account,
 * which is exactly what it was spent on.
 */
export function budgetNote(invite: Invite): string | null {
  if (!invite.budgetConsumed) return null;
  if (invite.refunded) return '1 invite refunded';
  if (invite.status === 'accepted') return '1 invite spent';
  return '1 invite held';
}

/**
 * Human phrasing for the `action` strings the API writes. Unknown actions
 * fall through as themselves rather than being hidden: an audit log that
 * silently drops a row it does not recognise is worse than one that shows a
 * raw string.
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'invite.issued': 'Invitation issued',
  'invite.revoked': 'Invitation revoked',
  'invite.accepted': 'Invitation accepted',
  'invite.budget_granted': 'Invite budget set',
  'role.assigned': 'Role changed',
  'course.visibility_set': 'Course visibility changed',
  'course.ownership_transferred': 'Course ownership transferred',
  'instance.bootstrapped': 'Instance claimed',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.refresh_reuse_detected': 'Refresh-token reuse detected',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** The action strings the audit filter offers, in the order §12 names them. */
export const AUDIT_FILTER_ACTIONS: readonly string[] = [
  'invite.issued',
  'invite.revoked',
  'invite.accepted',
  'role.assigned',
  'invite.budget_granted',
  'course.visibility_set',
  'course.ownership_transferred',
];

/**
 * One line of detail for an audit row, built from the entry's `meta`.
 * Deliberately generic: `meta` is free-form jsonb and a future action will
 * carry keys this build has never heard of, so anything unrecognised is
 * rendered as `key: value` rather than dropped.
 */
export function auditDetail(entry: AuditEntry): string {
  const meta = entry.meta ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(' · ');
}
