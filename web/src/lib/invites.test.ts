import { describe, expect, it } from 'vitest';
import type { AuditEntry, Invite } from './api';
import {
  auditActionLabel,
  auditDetail,
  budgetNote,
  canRevoke,
  inviteScopeLabel,
  inviteStatusLabel,
  issuerLabel,
} from './invites';

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: 'platform',
    status: 'pending',
    email: 'invitee@example.test',
    courseSlug: null,
    courseTitle: null,
    issuedById: '22222222-2222-2222-2222-222222222222',
    issuedByHandle: 'teacher',
    issuedByDisplayName: 'A Teacher',
    budgetConsumed: true,
    refunded: false,
    createsAccount: true,
    createdAt: '2026-08-01T10:00:00.000Z',
    expiresAt: '2026-08-15T10:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('inviteStatusLabel', () => {
  it('labels every status the API derives', () => {
    expect(inviteStatusLabel('pending')).toBe('Pending');
    expect(inviteStatusLabel('accepted')).toBe('Accepted');
    expect(inviteStatusLabel('revoked')).toBe('Revoked');
    expect(inviteStatusLabel('expired')).toBe('Expired');
  });
});

describe('canRevoke', () => {
  it('offers revocation only for a pending invitation', () => {
    expect(canRevoke(invite())).toBe(true);
    expect(canRevoke(invite({ status: 'accepted' }))).toBe(false);
    expect(canRevoke(invite({ status: 'revoked' }))).toBe(false);
    // An expired invite is already refunded by the API's sweep; a Revoke
    // button on it would only ever produce a 409.
    expect(canRevoke(invite({ status: 'expired' }))).toBe(false);
  });
});

describe('issuerLabel', () => {
  it('prefers the handle, falls back to the display name', () => {
    expect(issuerLabel(invite())).toBe('@teacher');
    expect(issuerLabel(invite({ issuedByHandle: null }))).toBe('A Teacher');
  });

  it('says something honest when the issuer account is gone', () => {
    expect(issuerLabel(invite({ issuedByHandle: null, issuedByDisplayName: null, issuedById: null }))).toBe(
      'a deleted account',
    );
  });
});

describe('inviteScopeLabel', () => {
  it('names the course for a course invitation', () => {
    expect(inviteScopeLabel(invite({ kind: 'course', courseSlug: 'ts', courseTitle: 'TypeScript' }))).toBe(
      'Course: TypeScript · creates an account',
    );
  });

  it('falls back to the slug when the title is missing', () => {
    expect(inviteScopeLabel(invite({ kind: 'course', courseSlug: 'ts', courseTitle: null }))).toBe(
      'Course: ts · creates an account',
    );
  });

  it('distinguishes an invitation to an address that already has an account', () => {
    expect(inviteScopeLabel(invite({ createsAccount: false }))).toBe('Platform · existing account');
  });
});

describe('budgetNote', () => {
  it('says nothing for an invitation that took no budget (an admin is unlimited)', () => {
    expect(budgetNote(invite({ budgetConsumed: false }))).toBeNull();
  });

  it('distinguishes held, refunded, and spent', () => {
    expect(budgetNote(invite())).toBe('1 invite held');
    expect(budgetNote(invite({ status: 'revoked', refunded: true }))).toBe('1 invite refunded');
    expect(budgetNote(invite({ status: 'expired', refunded: true }))).toBe('1 invite refunded');
    expect(budgetNote(invite({ status: 'accepted', acceptedAt: '2026-08-02T10:00:00.000Z' }))).toBe('1 invite spent');
  });
});

describe('auditActionLabel', () => {
  it('names every privileged action design §12 requires be logged', () => {
    expect(auditActionLabel('invite.issued')).toBe('Invitation issued');
    expect(auditActionLabel('invite.revoked')).toBe('Invitation revoked');
    expect(auditActionLabel('role.assigned')).toBe('Role changed');
    expect(auditActionLabel('invite.budget_granted')).toBe('Invite budget set');
    expect(auditActionLabel('course.visibility_set')).toBe('Course visibility changed');
    expect(auditActionLabel('course.ownership_transferred')).toBe('Course ownership transferred');
  });

  it('shows an unknown action as itself rather than hiding the row', () => {
    expect(auditActionLabel('something.new')).toBe('something.new');
  });
});

describe('auditDetail', () => {
  const entry = (meta: Record<string, unknown>): AuditEntry => ({
    id: '33333333-3333-3333-3333-333333333333',
    action: 'invite.issued',
    actorId: null,
    actorHandle: 'admin',
    target: 'some-id',
    meta,
    occurredAt: '2026-08-01T10:00:00.000Z',
  });

  it('renders meta as key: value pairs, including keys it has never seen', () => {
    expect(auditDetail(entry({ kind: 'course', budgetConsumed: true, somethingNew: 7 }))).toBe(
      'kind: course · budgetConsumed: true · somethingNew: 7',
    );
  });

  it('drops empty values and survives an empty meta', () => {
    expect(auditDetail(entry({ kind: 'platform', courseId: null, note: '' }))).toBe('kind: platform');
    expect(auditDetail(entry({}))).toBe('');
  });

  it('serialises a nested object rather than printing [object Object]', () => {
    expect(auditDetail(entry({ counts: { created: 1 } }))).toBe('counts: {"created":1}');
  });
});
