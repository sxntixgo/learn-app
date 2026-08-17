import { describe, it, expect } from 'vitest';
import { ANONYMOUS_ACTOR, can, isAnonymous, type Actor } from './can.ts';

const student: Actor = { id: '11111111-1111-1111-1111-111111111111', roles: ['student'] };
const teacher: Actor = { id: '22222222-2222-2222-2222-222222222222', roles: ['teacher'] };
const admin: Actor = { id: '33333333-3333-3333-3333-333333333333', roles: ['admin'] };
const roleless: Actor = { id: '44444444-4444-4444-4444-444444444444', roles: [] };

describe('can()', () => {
  describe('the anonymous actor', () => {
    it('is recognised by its flag, by its nil uuid, or by either alone', () => {
      expect(isAnonymous(ANONYMOUS_ACTOR)).toBe(true);
      expect(isAnonymous({ id: ANONYMOUS_ACTOR.id, roles: [] })).toBe(true);
      expect(isAnonymous({ id: student.id, roles: ['student'], anonymous: true })).toBe(true);
      expect(isAnonymous(student)).toBe(false);
    });

    it('may run the first-run bootstrap and read its status (design §5.2)', () => {
      expect(can(ANONYMOUS_ACTOR, 'instance:setup:status')).toBe(true);
      expect(can(ANONYMOUS_ACTOR, 'instance:bootstrap')).toBe(true);
    });

    it('may do nothing else — including anything a role would otherwise allow', () => {
      for (const action of [
        'course:list',
        'course:read',
        'lesson:read',
        'progress:read',
        'progress:write',
        'me:read',
        'me:update',
        'me:activity:read',
        'me:heatmap:read',
        'repo:import',
        'import:history:read',
        'session:revoke:all',
        'something:not:yet:invented',
      ]) {
        expect(can(ANONYMOUS_ACTOR, action)).toBe(false);
      }
    });

    it('cannot escape by carrying roles it was never granted', () => {
      // A forged actor object with the nil id is still nobody.
      expect(can({ id: ANONYMOUS_ACTOR.id, roles: ['admin'] }, 'repo:import')).toBe(false);
    });
  });

  describe('role-restricted actions (design §5)', () => {
    it('allows content import for teachers and admins only', () => {
      expect(can(teacher, 'repo:import', { url: 'https://example.test/x.git' })).toBe(true);
      expect(can(admin, 'repo:import', { url: 'https://example.test/x.git' })).toBe(true);
      expect(can(student, 'repo:import', { url: 'https://example.test/x.git' })).toBe(false);
      expect(can(roleless, 'repo:import')).toBe(false);
    });

    it('scopes the import history the same way', () => {
      expect(can(admin, 'import:history:read')).toBe(true);
      expect(can(student, 'import:history:read')).toBe(false);
    });

    it('denies a demoted actor: the decision reads the roles it is handed', () => {
      // This is the whole mechanism behind "privileged mutations re-check the
      // database" (design §13) — the route re-loads roles and hands can() the
      // fresh set, so an actor demoted mid-session is refused here.
      const demoted: Actor = { id: teacher.id, roles: [] };
      expect(can(demoted, 'repo:import')).toBe(false);
    });
  });

  it('still allows an authenticated actor the actions the matrix does not yet cover', () => {
    // Honest statement of a half-built matrix: the remaining cells land with
    // enrollment and course visibility in the next task.
    expect(can(student, 'course:list')).toBe(true);
    expect(can(student, 'me:read')).toBe(true);
  });
});
