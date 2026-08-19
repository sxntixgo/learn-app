'use server';

/*
 * The two admin mutations of design §5's last-but-one row — "Assign roles,
 * grant invite budgets" — as Server Actions.
 *
 * Neither throws on a refusal. The one that matters is §5.1's exclusivity:
 * granting `admin` to an account that already learns something answers 409
 * with the API's own sentence explaining why, and that sentence is what the
 * screen shows. Turning it into a thrown error would replace an explanation
 * with a stack trace.
 */

import { setInviteBudget, setUserRole } from '../../../src/lib/api';
import type { AdminUserResult, RoleAssignRequest } from '../../../src/lib/api';

export async function setUserRoleAction(userId: string, body: RoleAssignRequest): Promise<AdminUserResult> {
  try {
    return await setUserRole(userId, body);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not change that role.' };
  }
}

export async function setInviteBudgetAction(userId: string, budget: number): Promise<AdminUserResult> {
  try {
    return await setInviteBudget(userId, budget);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not set that budget.' };
  }
}
