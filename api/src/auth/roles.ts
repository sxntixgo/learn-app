import type pg from 'pg';
import type { Actor, Role } from '../policy/can.ts';
import { isAnonymous, KNOWN_ROLES } from '../policy/can.ts';

// Design §13: "Role is in the token for cheap reads; privileged mutations
// re-check the database, so a demotion takes effect immediately rather than
// at next refresh."
//
// This module is the second half of that sentence. The access token carries
// roles so that reads cost no query, and lives ~15 minutes — which means a
// revoked role could otherwise stay usable for up to fifteen minutes. For a
// read that is an acceptable trade. For a mutation that changes what other
// people can see or do, it is not: an admin who has just been demoted (or
// whose account was compromised and stripped) must stop being able to act
// at the very next request.
//
// So a privileged mutation calls `actorWithFreshRoles()` and hands the
// RESULT to `can()`. The token's own role claim is discarded there. The
// route code does not change shape — it still resolves an actor and asks
// `can()` — which is the whole point of the seam.

type Queryable = Pick<pg.Pool, 'query'>;

/** The roles this user holds RIGHT NOW, straight from `user_roles`. */
export async function loadRoles(db: Queryable, userId: string): Promise<Role[]> {
  const { rows } = await db.query<{ role: string }>('select role from user_roles where user_id = $1 order by role', [
    userId,
  ]);
  // Filtered against the known vocabulary for the same reason the token
  // claim is: nothing that is not a Role may reach can().
  return rows.map((r) => r.role).filter((role): role is Role => KNOWN_ROLES.has(role as Role));
}

/**
 * Returns `actor` with its roles replaced by the database's answer.
 *
 * An account that has been deleted, or that never had a role, comes back
 * with none — which `can()` then refuses for anything role-gated. Anonymous
 * actors are returned untouched: there is nothing to re-check, and the nil
 * uuid matches no row.
 */
export async function actorWithFreshRoles(db: Queryable, actor: Actor): Promise<Actor> {
  if (isAnonymous(actor)) return actor;
  return { ...actor, roles: await loadRoles(db, actor.id) };
}
