import { describe, it, expect } from 'vitest';
import { ACTIONS, ANONYMOUS_ACTOR, can, isAnonymous, type Action, type Actor } from './can.ts';

// =============================================================================
// THE §5 PERMISSION MATRIX, ONE CASE PER CELL.
//
// This file is the acceptance criterion for the policy module: every row of
// the design's §5 table, asserted for five subjects —
//
//   anonymous | student | teacher who OWNS the course | teacher who does NOT |
//   admin
//
// The two teacher subjects are the point. §5's "own courses" cells are not a
// role check, they are an ownership check, and a matrix that only tested one
// teacher would pass with the ownership half deleted.
//
// A coverage test at the bottom fails if an action is added to the vocabulary
// without a case here, so this table cannot silently fall behind can().
// =============================================================================

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const TEACHER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_TEACHER_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_STUDENT_ID = '55555555-5555-5555-5555-555555555555';

const student: Actor = { id: STUDENT_ID, roles: ['student'] };
const teacher: Actor = { id: TEACHER_ID, roles: ['teacher'] };
const otherTeacher: Actor = { id: OTHER_TEACHER_ID, roles: ['teacher'] };
const admin: Actor = { id: ADMIN_ID, roles: ['admin'] };
const roleless: Actor = { id: OTHER_STUDENT_ID, roles: [] };

type SubjectName = 'anonymous' | 'student' | 'teacherOwner' | 'teacherOther' | 'admin';

const SUBJECT_ORDER: readonly SubjectName[] = ['anonymous', 'student', 'teacherOwner', 'teacherOther', 'admin'];

const SUBJECTS: Record<SubjectName, Actor> = {
  anonymous: ANONYMOUS_ACTOR,
  student,
  teacherOwner: teacher,
  teacherOther: otherTeacher,
  admin,
};

// --- the resource each cell is decided against -------------------------------
//
// Course-scoped cells all use ONE course, owned by `teacher`. That is what
// makes `teacherOwner` and `teacherOther` differ by ownership alone.

/**
 * A course owned by the `teacherOwner` subject, `open` (migration 0008) —
 * `open` so the pre-existing course:read/lesson:read/course:enrol rows below
 * keep meaning "any authenticated student may read/enrol", independent of
 * the visibility predicates the "course visibility (§12)" describe block
 * exercises directly further down. Every other action ignores `visibility`
 * entirely, so adding it here does not change any of THEIR cells.
 */
const ownedCourse = (): unknown => ({ course: { ownerId: TEACHER_ID, visibility: 'open' } });
/** A course with no owner — an imported/curriculum course (migration 0007). */
const unownedCourse = (): unknown => ({ course: { ownerId: null, visibility: 'open' } });
/** The actor's own user-scoped data (own progress, own profile). */
const ownData = (actor: Actor): unknown => ({ userId: actor.id });
/** No resource at all — the honest shape for instance-wide actions. */
const noResource = (): unknown => undefined;

interface MatrixCase {
  /** The §5 row this cell belongs to, verbatim from the design table. */
  row: string;
  action: Action;
  /** Built per subject so self-scoped rows are "acting on OWN data" for everyone. */
  resource: (actor: Actor) => unknown;
  /** [anonymous, student, teacherOwner, teacherOther, admin] */
  expected: readonly [boolean, boolean, boolean, boolean, boolean];
}

const ALLOW = true;
const DENY = false;

const MATRIX: readonly MatrixCase[] = [
  // ---------------------------------------------------------------------------
  // Row: "Enroll, read, track own progress" — student ✅, teacher —, admin —
  //
  // Reading is a STUDENT power, including for a teacher's own course: §5 says
  // a teacher "can author a course only they can read — register a repo, let
  // the course land hidden, self-enroll". The self-enrollment is the whole
  // point; the reading happens through the student role, not the teacher one.
  // ---------------------------------------------------------------------------
  {
    row: 'Enroll, read, track own progress',
    action: 'course:list',
    resource: noResource,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Enroll, read, track own progress',
    action: 'course:read',
    resource: ownedCourse,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Enroll, read, track own progress',
    action: 'lesson:read',
    resource: ownedCourse,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Enroll, read, track own progress',
    action: 'course:enrol',
    resource: ownedCourse,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Enroll, read, track own progress',
    action: 'lesson:progress:write',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Enroll, read, track own progress',
    action: 'course:progress:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "Own profile, badges, degrees" — student ✅, teacher —, admin —
  //
  // The learner-facing profile of design §11: activity feed, heatmap, badges,
  // degrees. §5.1: admin accounts have "no enrollments, no progress, no
  // badges, and no public profile".
  // ---------------------------------------------------------------------------
  {
    row: 'Own profile, badges, degrees',
    action: 'me:activity:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Own profile, badges, degrees',
    action: 'me:heatmap:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Own profile, badges, degrees',
    action: 'me:badges:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Own profile, badges, degrees',
    action: 'me:degrees:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },
  {
    row: 'Own profile, badges, degrees',
    action: 'profile:read',
    resource: ownData,
    expected: [DENY, ALLOW, DENY, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "Register content repos, run syncs" — teacher own courses,
  //      admin curriculum repo only
  //
  // Two actions, because registering a repo and re-syncing an existing course
  // are different questions. Registering has no course to own yet (the
  // courses do not exist until the import runs), so it is a role floor.
  // Re-syncing targets a course that already exists, so it is ownership —
  // and "curriculum repo only" for the admin is expressed as the unowned
  // course, which is exactly what content imported by the operator is.
  // ---------------------------------------------------------------------------
  {
    row: 'Register content repos, run syncs',
    action: 'repo:import',
    resource: noResource,
    expected: [DENY, DENY, ALLOW, ALLOW, ALLOW],
  },
  {
    row: 'Register content repos, run syncs',
    action: 'import:history:read',
    resource: noResource,
    expected: [DENY, DENY, ALLOW, ALLOW, ALLOW],
  },
  {
    row: 'Register content repos, run syncs',
    action: 'course:sync',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },
  {
    // The admin half of the same cell: "curriculum repo only" — an unowned
    // course is the operator's own content, and the only course an admin may
    // sync. The owning teacher's course above is NOT admin-syncable.
    row: 'Register content repos, run syncs (curriculum repo = unowned course)',
    action: 'course:sync',
    resource: unownedCourse,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // Row: "Publish / set course visibility" — teacher own courses,
  //      admin override + transfer ownership
  // ---------------------------------------------------------------------------
  {
    row: 'Publish / set course visibility',
    action: 'course:visibility:set',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, ALLOW],
  },
  {
    row: 'Publish / set course visibility (transfer ownership)',
    action: 'course:ownership:transfer',
    resource: ownedCourse,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Publish / set course visibility (course settings screen)',
    action: 'course:manage:read',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // Row: "Create course-scoped badges" — teacher ✅
  //
  // The design table writes a bare ✅ for the teacher here, but a badge scoped
  // to a course they do not own would contradict §5's own sentence that
  // "course ownership scopes a teacher's authority". Ownership it is.
  // ---------------------------------------------------------------------------
  {
    row: 'Create course-scoped badges',
    action: 'course:badge:create',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "See progress of enrolled students" — teacher own courses
  //
  // §5.2: "a teacher sees individual progress only for students enrolled in
  // courses they own". Admin is a deliberate — : the operator account does
  // not get to read learner progress.
  // ---------------------------------------------------------------------------
  {
    row: 'See progress of enrolled students',
    action: 'course:students:progress:read',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "Grade submissions, score rubrics" — teacher own courses (§9.4)
  // ---------------------------------------------------------------------------
  {
    row: 'Grade submissions, score rubrics',
    action: 'submission:grade',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },
  {
    row: 'Grade submissions, score rubrics',
    action: 'rubric:score',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "Invite to a course" — teacher own courses (§12)
  // ---------------------------------------------------------------------------
  {
    row: 'Invite to a course',
    action: 'invite:course:create',
    resource: ownedCourse,
    expected: [DENY, DENY, ALLOW, DENY, DENY],
  },

  // ---------------------------------------------------------------------------
  // Row: "Invite to the platform" — teacher from budget, admin unlimited
  //
  // §12: "a teacher's platform-invite budget defaults to 0 — creating
  // accounts is granted deliberately, not assumed". So the teacher cell is
  // decided by the budget carried in the resource, not by the role, and BOTH
  // halves get a case.
  // ---------------------------------------------------------------------------
  {
    row: 'Invite to the platform (budget exhausted)',
    action: 'invite:platform:create',
    resource: () => ({ budget: { remaining: 0 } }),
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Invite to the platform (budget available)',
    action: 'invite:platform:create',
    resource: () => ({ budget: { remaining: 3 } }),
    expected: [DENY, DENY, ALLOW, ALLOW, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // Row: "Define degrees, global badges" — admin ✅
  // ---------------------------------------------------------------------------
  {
    row: 'Define degrees, global badges',
    action: 'degree:define',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Define degrees, global badges',
    action: 'badge:global:define',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // Row: "Assign roles, grant invite budgets" — admin ✅
  // ---------------------------------------------------------------------------
  {
    row: 'Assign roles, grant invite budgets',
    action: 'role:assign',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Assign roles, grant invite budgets',
    action: 'invite:budget:grant',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // Row: "Read audit log, instance settings" — admin ✅
  // ---------------------------------------------------------------------------
  {
    row: 'Read audit log, instance settings',
    action: 'audit:read',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Read audit log, instance settings',
    action: 'instance:settings:read',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },
  {
    row: 'Read audit log, instance settings',
    action: 'instance:settings:update',
    resource: noResource,
    expected: [DENY, DENY, DENY, DENY, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // NOT A §5 ROW: the account itself.
  //
  // §5's "Own profile" row is the learner profile — badges, degrees, the
  // public page. The ACCOUNT record (who am I, what time zone am I in, sign
  // me out everywhere) belongs to every authenticated identity including the
  // operator account, which still has to be able to see itself and sign out.
  // Documented here rather than folded into the student row, so the
  // divergence from the table is visible rather than quiet.
  // ---------------------------------------------------------------------------
  {
    row: 'Account (not a §5 row): every authenticated identity, own record only',
    action: 'me:read',
    resource: ownData,
    expected: [DENY, ALLOW, ALLOW, ALLOW, ALLOW],
  },
  {
    row: 'Account (not a §5 row): every authenticated identity, own record only',
    action: 'me:update',
    resource: ownData,
    expected: [DENY, ALLOW, ALLOW, ALLOW, ALLOW],
  },
  {
    row: 'Account (not a §5 row): every authenticated identity, own record only',
    action: 'session:revoke:all',
    resource: ownData,
    expected: [DENY, ALLOW, ALLOW, ALLOW, ALLOW],
  },

  // ---------------------------------------------------------------------------
  // NOT A §5 ROW: the first-run bootstrap (§5.2), the one unauthenticated
  // write endpoint. Gated by the setup token and the atomic claim, not by a
  // role — so it is allowed for everyone, anonymous included.
  // ---------------------------------------------------------------------------
  {
    row: 'First-run bootstrap (§5.2): public, gated by the setup token',
    action: 'instance:setup:status',
    resource: noResource,
    expected: [ALLOW, ALLOW, ALLOW, ALLOW, ALLOW],
  },
  {
    row: 'First-run bootstrap (§5.2): public, gated by the setup token',
    action: 'instance:bootstrap',
    resource: noResource,
    expected: [ALLOW, ALLOW, ALLOW, ALLOW, ALLOW],
  },
];

describe('the §5 permission matrix — one case per cell', () => {
  for (const testCase of MATRIX) {
    describe(`${testCase.row} → ${testCase.action}`, () => {
      SUBJECT_ORDER.forEach((name, index) => {
        const expected = testCase.expected[index]!;
        it(`${name}: ${expected ? 'ALLOW' : 'deny'}`, () => {
          const actor = SUBJECTS[name];
          expect(can(actor, testCase.action, testCase.resource(actor))).toBe(expected);
        });
      });
    });
  }

  it('covers every action in the vocabulary — no action may exist without a cell', () => {
    const covered = new Set(MATRIX.map((c) => c.action));
    const uncovered = ACTIONS.filter((action) => !covered.has(action));
    expect(uncovered, 'actions with no matrix case above').toEqual([]);
  });
});

// =============================================================================
// The properties the table cannot express, because they are about what
// happens when a CALLER makes a mistake.
// =============================================================================

/** Every action whose teacher cell in §5 reads "own courses". */
const OWNERSHIP_SCOPED: readonly Action[] = [
  'course:sync',
  'course:visibility:set',
  'course:manage:read',
  'course:badge:create',
  'course:students:progress:read',
  'submission:grade',
  'rubric:score',
  'invite:course:create',
];

describe('a missing ownership context denies — it never defaults to allow', () => {
  for (const action of OWNERSHIP_SCOPED) {
    it(`${action}: the owning teacher is refused when no course is supplied`, () => {
      // The failure mode being engineered against is a route that loads the
      // course, decides, and forgets to pass it. Every one of these shapes is
      // "the caller forgot", and every one of them denies.
      expect(can(teacher, action, undefined)).toBe(false);
      expect(can(teacher, action, {})).toBe(false);
      expect(can(teacher, action, { course: null })).toBe(false);
      expect(can(teacher, action, { course: {} })).toBe(false);
      expect(can(teacher, action, { courseId: 'some-course' })).toBe(false);
      // ownerId present but not a real id: still not a decision anyone made.
      expect(can(teacher, action, { course: { ownerId: '' } })).toBe(false);
      expect(can(teacher, action, { course: { ownerId: undefined } })).toBe(false);
    });
  }

  it('admin override is context-scoped too: no course means no decision', () => {
    expect(can(admin, 'course:visibility:set', undefined)).toBe(false);
    expect(can(admin, 'course:ownership:transfer', {})).toBe(false);
    expect(can(admin, 'course:manage:read', { course: {} })).toBe(false);
  });

  it('the student read/enrol cells need a course too', () => {
    expect(can(student, 'course:read', undefined)).toBe(false);
    expect(can(student, 'lesson:read', {})).toBe(false);
    expect(can(student, 'course:enrol', { course: null })).toBe(false);
  });

  it('and, for a non-owner, a course with no (or an unrecognised) visibility denies too', () => {
    // §12 read literally: `open`/`restricted` allow, everything else —
    // including "the caller forgot to select the column" — does not. This is
    // the visibility half of property 2, alongside the ownerId half above.
    expect(can(student, 'course:read', { course: { ownerId: TEACHER_ID } })).toBe(false);
    expect(can(student, 'lesson:read', { course: { ownerId: TEACHER_ID } })).toBe(false);
    expect(can(student, 'course:enrol', { course: { ownerId: TEACHER_ID } })).toBe(false);
    expect(can(student, 'course:read', { course: { ownerId: TEACHER_ID, visibility: 'nonsense' } })).toBe(false);
  });
});

describe('an unowned course (courses.owner_id is null) is admin-only', () => {
  // Migration 0007: courses imported before ownership existed have no owner.
  // The safe reading, and the one implemented: no teacher owns it, so no
  // teacher may act on it; only the admin cells apply.
  it('refuses every teacher, including one who owns other courses', () => {
    for (const action of OWNERSHIP_SCOPED) {
      expect(can(teacher, action, { course: { ownerId: null } }), action).toBe(false);
      expect(can(otherTeacher, action, { course: { ownerId: null } }), action).toBe(false);
    }
  });

  it('still lets the admin publish, transfer, and sync it', () => {
    expect(can(admin, 'course:visibility:set', { course: { ownerId: null } })).toBe(true);
    expect(can(admin, 'course:ownership:transfer', { course: { ownerId: null } })).toBe(true);
    expect(can(admin, 'course:sync', { course: { ownerId: null } })).toBe(true);
  });

  it('does not hand the admin the cells the matrix denies them', () => {
    expect(can(admin, 'course:students:progress:read', { course: { ownerId: null } })).toBe(false);
    expect(can(admin, 'submission:grade', { course: { ownerId: null } })).toBe(false);
    expect(can(admin, 'invite:course:create', { course: { ownerId: null } })).toBe(false);
    expect(can(admin, 'course:badge:create', { course: { ownerId: null } })).toBe(false);
  });
});

// =============================================================================
// Course visibility (§12, migration 0008) — the cells the header comment's
// "VISIBILITY, ADDED HERE" section describes: `course:read` / `lesson:read` /
// `course:enrol` gain a visibility predicate ON TOP of the role check, and
// ownership bypasses it entirely. `student` here is deliberately built with
// BOTH roles for the owner cases — §5's "a teacher holding both roles can
// author a course only they can read... self-enroll" is a dual-role claim,
// not a teacher-role claim, so a subject with `roles: ['teacher']` alone
// (this file's `teacher`/`otherTeacher`) is never the right actor to prove
// it with; that would silently test OWN_COURSE instead of the visibility
// bypass.
// =============================================================================
describe('course visibility (§12)', () => {
  const OWNER_STUDENT_ID = TEACHER_ID;
  /** Holds BOTH roles — the realistic shape of a teacher who reads their own course. */
  const ownerStudent: Actor = { id: OWNER_STUDENT_ID, roles: ['teacher', 'student'] };
  /** A student with no stake in the course at all. */
  const outsider = student;

  const courseWith = (visibility: string | undefined): unknown => ({
    course: {
      ownerId: OWNER_STUDENT_ID,
      ...(visibility === undefined ? {} : { visibility }),
    },
  });

  for (const action of ['course:read', 'lesson:read'] as const) {
    describe(action, () => {
      it('open: any authenticated student reads it, owner or not', () => {
        expect(can(outsider, action, courseWith('open'))).toBe(true);
        expect(can(ownerStudent, action, courseWith('open'))).toBe(true);
      });

      it('restricted: still readable (listed) by any authenticated student', () => {
        expect(can(outsider, action, courseWith('restricted'))).toBe(true);
        expect(can(ownerStudent, action, courseWith('restricted'))).toBe(true);
      });

      it('hidden: denied for a non-owner, allowed for the owner', () => {
        expect(can(outsider, action, courseWith('hidden'))).toBe(false);
        expect(can(ownerStudent, action, courseWith('hidden'))).toBe(true);
      });
    });
  }

  describe('course:enrol', () => {
    it('open: any authenticated student may self-enrol', () => {
      expect(can(outsider, 'course:enrol', courseWith('open'))).toBe(true);
      expect(can(ownerStudent, 'course:enrol', courseWith('open'))).toBe(true);
    });

    it('restricted: listed, but self-enrolling without an invite is refused — even though it reads fine', () => {
      expect(can(outsider, 'course:enrol', courseWith('restricted'))).toBe(false);
      // The owner is the one documented exception (§5's self-enrollment).
      expect(can(ownerStudent, 'course:enrol', courseWith('restricted'))).toBe(true);
    });

    it('hidden: refused for a non-owner; the owner still self-enrols (§5)', () => {
      expect(can(outsider, 'course:enrol', courseWith('hidden'))).toBe(false);
      expect(can(ownerStudent, 'course:enrol', courseWith('hidden'))).toBe(true);
    });
  });

  it('a teacher-only owner (no student role) gets none of this — they read via course:manage:read instead', () => {
    const teacherOnlyOwner: Actor = { id: OWNER_STUDENT_ID, roles: ['teacher'] };
    expect(can(teacherOnlyOwner, 'course:read', courseWith('open'))).toBe(false);
    expect(can(teacherOnlyOwner, 'course:enrol', courseWith('open'))).toBe(false);
    expect(can(teacherOnlyOwner, 'course:manage:read', { course: { ownerId: OWNER_STUDENT_ID } })).toBe(true);
  });
});

describe('user-scoped actions are about the actor’s OWN data', () => {
  it('a student cannot read another student’s progress', () => {
    expect(can(student, 'course:progress:read', { userId: STUDENT_ID })).toBe(true);
    expect(can(student, 'course:progress:read', { userId: OTHER_STUDENT_ID })).toBe(false);
    expect(can(student, 'lesson:progress:write', { userId: OTHER_STUDENT_ID })).toBe(false);
    expect(can(student, 'me:activity:read', { userId: OTHER_STUDENT_ID })).toBe(false);
    expect(can(student, 'me:heatmap:read', { userId: OTHER_STUDENT_ID })).toBe(false);
    expect(can(student, 'profile:read', { userId: OTHER_STUDENT_ID })).toBe(false);
  });

  it('and a missing subject denies, so a route cannot forget to name whose data it is', () => {
    expect(can(student, 'course:progress:read', undefined)).toBe(false);
    expect(can(student, 'lesson:progress:write', {})).toBe(false);
    expect(can(student, 'me:read', {})).toBe(false);
    expect(can(teacher, 'me:update', undefined)).toBe(false);
  });

  it('a teacher reads a student’s progress through the course cell, not the student’s own action', () => {
    // The only route to another person's progress is
    // course:students:progress:read on a course they own — which is where the
    // "scoped and disclosed" rule of §5.2 lives.
    expect(can(teacher, 'course:progress:read', { userId: STUDENT_ID })).toBe(false);
    expect(can(teacher, 'course:students:progress:read', { course: { ownerId: TEACHER_ID } })).toBe(true);
  });
});

describe('admin is exclusive of student and teacher (§5.1)', () => {
  it('an admin cannot enrol', () => {
    expect(can(admin, 'course:enrol', { course: { ownerId: TEACHER_ID } })).toBe(false);
    expect(can(admin, 'course:enrol', { course: { ownerId: null } })).toBe(false);
  });

  it('an admin holds no progress, no badges, no learner profile', () => {
    expect(can(admin, 'lesson:progress:write', { userId: ADMIN_ID })).toBe(false);
    expect(can(admin, 'course:progress:read', { userId: ADMIN_ID })).toBe(false);
    expect(can(admin, 'me:badges:read', { userId: ADMIN_ID })).toBe(false);
    expect(can(admin, 'me:degrees:read', { userId: ADMIN_ID })).toBe(false);
    expect(can(admin, 'profile:read', { userId: ADMIN_ID })).toBe(false);
    expect(can(admin, 'course:list')).toBe(false);
  });

  it('a token or row that somehow carries admin AND a learner role is treated as admin ONLY', () => {
    // The database makes this state unreachable (0005's exclusion
    // constraint), which is exactly why can() must not depend on that being
    // true — a stale token, a restored backup, or a hand-built Actor must not
    // be able to union the two role sets together.
    const both: Actor = { id: ADMIN_ID, roles: ['admin', 'student'] };
    expect(can(both, 'course:enrol', { course: { ownerId: null } })).toBe(false);
    expect(can(both, 'lesson:progress:write', { userId: ADMIN_ID })).toBe(false);
    expect(can(both, 'course:list')).toBe(false);
    // ...and still an admin for the admin cells, rather than nobody at all.
    expect(can(both, 'role:assign')).toBe(true);

    const adminTeacher: Actor = { id: ADMIN_ID, roles: ['teacher', 'admin'] };
    expect(can(adminTeacher, 'course:badge:create', { course: { ownerId: ADMIN_ID } })).toBe(false);
    expect(can(adminTeacher, 'invite:course:create', { course: { ownerId: ADMIN_ID } })).toBe(false);
  });

  it('but student and teacher DO combine freely (§5: "roles are a set, not a ladder")', () => {
    const both: Actor = { id: TEACHER_ID, roles: ['student', 'teacher'] };
    expect(can(both, 'course:list')).toBe(true);
    expect(can(both, 'course:enrol', { course: { ownerId: TEACHER_ID } })).toBe(true);
    expect(can(both, 'course:visibility:set', { course: { ownerId: TEACHER_ID } })).toBe(true);
    expect(can(both, 'course:visibility:set', { course: { ownerId: OTHER_TEACHER_ID } })).toBe(false);
  });
});

describe('the anonymous actor', () => {
  it('is recognised by its flag, by its nil uuid, or by either alone', () => {
    expect(isAnonymous(ANONYMOUS_ACTOR)).toBe(true);
    expect(isAnonymous({ id: ANONYMOUS_ACTOR.id, roles: [] })).toBe(true);
    expect(isAnonymous({ id: STUDENT_ID, roles: ['student'], anonymous: true })).toBe(true);
    expect(isAnonymous(student)).toBe(false);
  });

  it('may do nothing except the two public bootstrap actions', () => {
    for (const action of ACTIONS) {
      const expected = action === 'instance:setup:status' || action === 'instance:bootstrap';
      expect(can(ANONYMOUS_ACTOR, action, { course: { ownerId: null }, userId: ANONYMOUS_ACTOR.id }), action).toBe(
        expected,
      );
    }
  });

  it('cannot escape by carrying roles it was never granted', () => {
    expect(can({ id: ANONYMOUS_ACTOR.id, roles: ['admin'] }, 'repo:import')).toBe(false);
    expect(can({ id: STUDENT_ID, roles: ['admin'], anonymous: true }, 'role:assign')).toBe(false);
  });
});

describe('the vocabulary is closed', () => {
  it('denies an action that is not in the matrix, for every role', () => {
    // The half-built matrix used to end with "any other action, for an
    // authenticated actor, is allowed". That is gone: an action nobody has
    // written a rule for is denied, so a typo'd action string in a future
    // route fails shut rather than open.
    for (const actor of [student, teacher, admin, roleless, ANONYMOUS_ACTOR]) {
      expect(can(actor, 'something:not:yet:invented' as Action)).toBe(false);
      expect(can(actor, 'course:sync ' as Action, { course: { ownerId: TEACHER_ID } })).toBe(false);
      expect(can(actor, '' as Action)).toBe(false);
      expect(can(actor, 'toString' as Action)).toBe(false);
      expect(can(actor, '__proto__' as Action)).toBe(false);
    }
  });

  it('denies an actor whose roles are not roles', () => {
    const bogus = { id: STUDENT_ID, roles: ['superuser'] } as unknown as Actor;
    expect(can(bogus, 'course:list')).toBe(false);
    expect(can(bogus, 'role:assign')).toBe(false);
  });

  it('denies a demoted actor: the decision reads the roles it is handed', () => {
    // The mechanism behind "privileged mutations re-check the database"
    // (design §13) — the route re-loads roles and hands can() the fresh set.
    const demoted: Actor = { id: TEACHER_ID, roles: [] };
    expect(can(demoted, 'repo:import')).toBe(false);
    expect(can(demoted, 'course:sync', { course: { ownerId: TEACHER_ID } })).toBe(false);
  });
});
