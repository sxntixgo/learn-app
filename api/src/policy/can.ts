// Authorization seam (CLAUDE.md rule 2 / design doc "Authorization lives in
// one tested policy module"). Every API handler must resolve an `actor` and
// call `can(actor, action, resource)` before returning protected content.
//
// Phase 1: `can()` always returns true and `actor` is the hardcoded
// DEV_ACTOR below. Phase 6 replaces the BODY of `can()` with real rules
// (role checks, ownership checks, etc.) and populates `actor` from a real
// session. Callers must NOT change then — that's the point of the seam.

export type Role = 'student' | 'teacher' | 'admin';

export interface Actor {
  id: string;
  roles: readonly Role[];
}

/**
 * Phase 1: unconditionally true. Phase 6 replaces this body only — the
 * signature and every call site stay exactly as they are.
 */
export function can(actor: Actor, action: string, resource?: unknown): boolean {
  void actor;
  void action;
  void resource;
  return true;
}

// Phase-1-only hardcoded development actor. Stands in for a real
// authenticated user until Phase 6 populates `actor` from a session.
export const DEV_ACTOR: Actor = {
  id: 'dev-user',
  roles: ['admin'],
};
