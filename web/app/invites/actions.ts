'use server';

/*
 * The invitations screen's two Server Actions (design §12). Same shape as
 * the other actions.ts files in this app: they run on the Next.js server, so
 * the browser never talks to the API directly and web never needs
 * DATABASE_URL (CLAUDE.md rule 1).
 *
 * Neither throws on a refusal. "Your platform-invite budget is 0", "you do
 * not own that course" and "that invitation was already accepted" are
 * ordinary answers this screen must SHOW — with the form's contents intact —
 * not errors to redirect away from.
 */

import { createInvite, revokeInvite } from '../../src/lib/api';
import type { InviteCreateRequest, IssueInviteResult, RevokeInviteResult } from '../../src/lib/api';

export async function issueInviteAction(body: InviteCreateRequest): Promise<IssueInviteResult> {
  try {
    return await createInvite(body);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not issue that invitation.' };
  }
}

export async function revokeInviteAction(inviteId: string): Promise<RevokeInviteResult> {
  try {
    return await revokeInvite(inviteId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not revoke that invitation.' };
  }
}
