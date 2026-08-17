// Authorization seam (CLAUDE.md rule 2 / design §5.2: "authorization lives
// in one tested policy module"). Every API handler resolves an `actor` and
// calls `can(actor, action, resource)` before returning protected content.
//
// PHASE 6, THIS TASK: `actor` is now real. It is resolved per request from
// the EdDSA access-token cookie (api/src/auth/actor.ts) and is the ANONYMOUS
// actor when there is no valid token. That makes `can()` — not a scattering
// of per-route `if (!request.user)` checks — the thing that refuses an
// unauthenticated request. Adding such a check to a route would be a
// regression: it would move the decision out of the one module that is
// tested against the design's permission matrix.
//
// STILL TO COME (the plan's next opus task, "complete the policy module"):
// the full §5 matrix — course visibility, enrollment, ownership, one test
// case per cell. What is here now is deliberately the subset this task
// needs and can defend:
//
//   1. Anonymous actors may do nothing except the explicitly public actions.
//   2. Actions that the §5 matrix restricts to particular roles check those
//      roles. Only the two admin/teacher content-import actions exist so
//      far; the rest of the matrix is not yet expressible without
//      enrollment and visibility, which land with it.
//   3. Any other action, for an authenticated actor, is still allowed.
//
// (3) is the honest description of a half-built matrix, and it is why the
// gate on exposing this app publicly is the NEXT task, not this one.

export type Role = 'student' | 'teacher' | 'admin';

/** The complete role vocabulary. Anything else is not a role, wherever it came from. */
export const KNOWN_ROLES: ReadonlySet<Role> = new Set<Role>(['student', 'teacher', 'admin']);

export interface Actor {
  id: string;
  roles: readonly Role[];
  /**
   * True only for the anonymous actor. Redundant with the nil-uuid id below
   * and deliberately so — an actor is treated as unauthenticated if EITHER
   * says so, because the failure mode worth engineering against is a future
   * caller that constructs an actor and forgets one of them.
   */
  anonymous?: boolean;
}

/**
 * The actor for a request with no valid session.
 *
 * The nil UUID is not a users row and cannot become one: `gen_random_uuid()`
 * never returns it. So it is safe as an FK-shaped value that matches
 * nothing, and an anonymous actor that leaked into a query would find no
 * rows rather than someone else's.
 */
export const ANONYMOUS_ACTOR: Actor = Object.freeze({
  id: '00000000-0000-0000-0000-000000000000',
  roles: Object.freeze([]) as readonly Role[],
  anonymous: true,
});

/** True when this actor represents "nobody is signed in". */
export function isAnonymous(actor: Actor): boolean {
  return actor.anonymous === true || actor.id === ANONYMOUS_ACTOR.id;
}

/**
 * Actions reachable without a session.
 *
 * Exactly the first-run bootstrap (design §5.2: the one unauthenticated
 * write endpoint, gated by the setup token and the atomic claim). Login,
 * refresh and logout are not here because they are not authorization
 * decisions — they are how an actor comes to exist — and `GET /health`
 * takes no policy decision at all.
 */
const PUBLIC_ACTIONS: ReadonlySet<string> = new Set(['instance:setup:status', 'instance:bootstrap']);

/**
 * Actions the §5 matrix restricts to a role set.
 *
 * Design §5: registering content repos and running syncs is a teacher power
 * (own courses) and an admin power (curriculum repo only) — never a plain
 * student's. Course-scoped narrowing arrives with the ownership rules in the
 * next task; the role floor is what is defensible today.
 */
const REQUIRED_ROLES: ReadonlyMap<string, ReadonlySet<Role>> = new Map<string, ReadonlySet<Role>>([
  ['repo:import', new Set<Role>(['admin', 'teacher'])],
  ['import:history:read', new Set<Role>(['admin', 'teacher'])],
]);

/**
 * The single authorization chokepoint. Returns true when `actor` may perform
 * `action` on `resource`.
 */
export function can(actor: Actor, action: string, resource?: unknown): boolean {
  void resource;

  if (isAnonymous(actor)) {
    return PUBLIC_ACTIONS.has(action);
  }

  const required = REQUIRED_ROLES.get(action);
  if (required) {
    return actor.roles.some((role) => required.has(role));
  }

  return true;
}

// The seeded users row from db/migrations/0004_progress_and_activity.sql,
// which every phase-1..5 progress and activity row points at.
//
// NO LONGER A DEFAULT ANYWHERE IN PRODUCTION CODE. Route modules used to
// fall back to it when no actor was injected; they now fall back to the
// per-request actor resolved from the access token, and to ANONYMOUS_ACTOR
// when there is none. It survives as the fixture the phase-1..5 route tests
// inject explicitly, so those tests keep exercising their own behaviour
// rather than re-testing authentication.
export const DEV_ACTOR: Actor = {
  id: '00000000-0000-0000-0000-000000000001',
  roles: ['admin'],
};
