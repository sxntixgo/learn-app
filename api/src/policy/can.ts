// =============================================================================
// THE AUTHORIZATION CHOKEPOINT.
//
// CLAUDE.md rule 2 / design §5.2: "Authorization lives in one tested policy
// module — can(actor, action, resource). Read access depends on role, course
// visibility, enrollment, and ownership simultaneously; scattered `if`
// statements across route handlers would rot within months."
//
// This module is the whole §5 permission matrix. Every row of that table is a
// row of MATRIX below, including the rows whose features do not exist yet
// (badges, degrees, grading, invites) — a chokepoint that only covers today's
// routes is not a chokepoint, it is a coincidence. api/src/policy/can.test.ts
// asserts one case per cell, for five subjects: anonymous, student, a teacher
// who owns the course, a teacher who does not, and an admin.
//
// THREE PROPERTIES THIS MODULE IS BUILT AROUND
// --------------------------------------------
// 1. THE VOCABULARY IS CLOSED. An action with no entry in MATRIX is denied,
//    for everybody. Until this task `can()` ended with "any other action, for
//    an authenticated actor, is allowed" — the honest description of a
//    half-built matrix, and a fail-open default. It is gone. A typo'd action
//    string in a future route now 403s instead of sailing through.
//
// 2. MISSING CONTEXT DENIES. `can()` is synchronous and ownership lives in
//    Postgres, so the caller supplies it: the route loads the course and
//    passes `{ course: { ownerId } }`. A course-scoped decision made without
//    that context is not "allow by default", it is a caller that forgot, and
//    it denies — for teachers AND for admins. Same for user-scoped actions
//    and `{ userId }`. This is the one design property worth more than any
//    individual cell, because forgetting is the realistic failure, not
//    malice.
//
// 3. ADMIN IS EXCLUSIVE (§5.1). An admin genuinely cannot enrol, hold
//    progress, earn badges, or read a learner profile. Admin is not a
//    superset of student and teacher — it is a disjoint operator role, and
//    the reason is blast radius: "an everyday account carrying admin means
//    every stolen session, XSS, or unlocked laptop is a full instance
//    takeover". Migration 0005 enforces the disjointness in the database with
//    an exclusion constraint; `can()` does NOT rely on that having held —
//    an Actor carrying both is collapsed to admin-only here, so a stale
//    token or a restored backup cannot union the two role sets together.
//
// WHAT IS DELIBERATELY NOT HERE YET
// ---------------------------------
// Course VISIBILITY (§12: open / restricted / hidden) and ENROLLMENT. Neither
// has a table yet. `course:read` / `lesson:read` / `course:enrol` therefore
// check the role and require a course context, and will gain the visibility
// and enrollment predicates in the same change that adds those columns —
// which is a change to this file only, exactly as the seam intends.
// =============================================================================

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

// -----------------------------------------------------------------------------
// The resource: how a synchronous decision gets database facts.
//
// `can()` cannot query. The route already has the rows — it loaded the course
// to 404 on it — so it hands over the two facts the matrix needs. Both are
// read defensively below: a shape that is not exactly right counts as absent,
// and absent denies.
// -----------------------------------------------------------------------------

/** The ownership fact for a course-scoped decision. `ownerId: null` = unowned. */
export interface CourseContext {
  /** `courses.owner_id` (migration 0007). Null means no teacher owns it. */
  ownerId: string | null;
}

/**
 * What a route passes as `resource`. Every field optional and every field
 * checked — routes also pass their own descriptive fields (a slug, a url)
 * alongside, which the policy ignores.
 */
export interface PolicyResource {
  /** Required by every course-scoped action. */
  course?: CourseContext | null;
  /** Required by every action about one person's own data. */
  userId?: string | null;
  /** Required by the teacher half of "Invite to the platform" (§12). */
  budget?: { remaining: number } | null;
}

/**
 * Reads the course context, or null when the caller did not supply one.
 *
 * `{ course: { ownerId: null } }` (unowned) and "no course context at all"
 * are different answers and must not collapse into each other, so an absent
 * or non-string `ownerId` key is treated as *no context*, not as unowned.
 * That is what makes `{ course: {} }` — the shape a route produces when it
 * forgot to select `owner_id` — deny rather than silently grant the admin
 * override.
 */
function courseContextOf(resource: unknown): CourseContext | null {
  if (typeof resource !== 'object' || resource === null) return null;
  const course = (resource as { course?: unknown }).course;
  if (typeof course !== 'object' || course === null) return null;
  if (!('ownerId' in course)) return null;
  const ownerId = (course as { ownerId: unknown }).ownerId;
  if (ownerId === null) return { ownerId: null };
  if (typeof ownerId === 'string' && ownerId !== '') return { ownerId };
  return null;
}

/** Reads whose data this decision is about, or null when unstated. */
function subjectIdOf(resource: unknown): string | null {
  if (typeof resource !== 'object' || resource === null) return null;
  const userId = (resource as { userId?: unknown }).userId;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

/** Reads the issuer's remaining platform-invite budget, or null when unstated. */
function budgetRemainingOf(resource: unknown): number | null {
  if (typeof resource !== 'object' || resource === null) return null;
  const budget = (resource as { budget?: unknown }).budget;
  if (typeof budget !== 'object' || budget === null) return null;
  const remaining = (budget as { remaining?: unknown }).remaining;
  return typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null;
}

// -----------------------------------------------------------------------------
// The five ways a cell can say "yes". Anything not covered says no.
// -----------------------------------------------------------------------------

type Decision = (actor: Actor, resource: unknown) => boolean;

/** The role alone decides — the matrix cell is a bare ✅. */
const ALLOW: Decision = () => true;

/** Only about this actor's own record: own progress, own profile, own sessions. */
const SELF: Decision = (actor, resource) => {
  const subject = subjectIdOf(resource);
  return subject !== null && subject === actor.id;
};

/** §5's "own courses": this actor is the course's owner. Unowned never matches. */
const OWN_COURSE: Decision = (actor, resource) => {
  const course = courseContextOf(resource);
  return course !== null && course.ownerId !== null && course.ownerId === actor.id;
};

/**
 * The admin override ("override + transfer ownership"): any course, owned or
 * not — but still a NAMED course. An admin who cannot say which course this
 * is about has not made a decision either.
 */
const ANY_COURSE: Decision = (_actor, resource) => courseContextOf(resource) !== null;

/**
 * The admin's "curriculum repo only" scope, expressed against the schema we
 * have: a course with no teacher owner is the instance's own content — what
 * the operator imported — and it is the only course an admin may re-sync.
 * A teacher's course is theirs to sync, and the admin cell for that row is
 * not a wildcard.
 */
const UNOWNED_COURSE: Decision = (_actor, resource) => {
  const course = courseContextOf(resource);
  return course !== null && course.ownerId === null;
};

/** §12: a teacher may issue a platform invite only out of a non-zero budget. */
const FROM_BUDGET: Decision = (_actor, resource) => {
  const remaining = budgetRemainingOf(resource);
  return remaining !== null && remaining > 0;
};

/** A course context is required even where the role alone decides the rest. */
const ON_ANY_COURSE = ANY_COURSE;

interface ActionPolicy {
  /** The §5 row this action implements, so the table and the code stay legible together. */
  readonly row: string;
  /** A role with no entry is denied. There is no fallback and no wildcard. */
  readonly student?: Decision;
  readonly teacher?: Decision;
  readonly admin?: Decision;
}

// =============================================================================
// THE MATRIX. Design §5, verbatim in the `row` strings.
//
// | Action area                         | Student | Teacher      | Admin        |
// |-------------------------------------|---------|--------------|--------------|
// | Enroll, read, track own progress     | yes     | no           | no           |
// | Own profile, badges, degrees         | yes     | no           | no           |
// | Register content repos, run syncs    | no      | own courses  | curriculum   |
// | Publish / set course visibility      | no      | own courses  | override     |
// | Create course-scoped badges          | no      | yes          | no           |
// | See progress of enrolled students    | no      | own courses  | no           |
// | Grade submissions, score rubrics     | no      | own courses  | no           |
// | Invite to a course                   | no      | own courses  | no           |
// | Invite to the platform               | no      | from budget  | unlimited    |
// | Define degrees, global badges        | no      | no           | yes          |
// | Assign roles, grant invite budgets   | no      | no           | yes          |
// | Read audit log, instance settings    | no      | no           | yes          |
//
// NAMING. `area:noun:verb`, narrowing left to right, verb last. The area is
// the thing acted on, never the screen it appears on: it is `course:sync`,
// not `teacher:sync`, so the same action string means the same thing whoever
// asks. Actions about the caller's own account/learner data live under `me:`.
// =============================================================================

const MATRIX = {
  // ---- Enroll, read, track own progress ------------------------------------
  // Reading is a STUDENT power even for a teacher's own course. §5: a teacher
  // "can author a course only they can read — register a repo, let the course
  // land hidden, self-enroll". The self-enrollment is not incidental; it is
  // how a teacher reads. A teacher-only account authoring a course sees the
  // course SETTINGS (course:manage:read), not the lessons.
  'course:list': { row: 'Enroll, read, track own progress', student: ALLOW },
  'course:read': { row: 'Enroll, read, track own progress', student: ON_ANY_COURSE },
  'lesson:read': { row: 'Enroll, read, track own progress', student: ON_ANY_COURSE },
  'course:enrol': { row: 'Enroll, read, track own progress', student: ON_ANY_COURSE },
  'lesson:progress:write': { row: 'Enroll, read, track own progress', student: SELF },
  'course:progress:read': { row: 'Enroll, read, track own progress', student: SELF },

  // ---- Own profile, badges, degrees ----------------------------------------
  // The learner-facing profile of design §11. §5.1: operator accounts have
  // "no enrollments, no progress, no badges, and no public profile".
  'me:activity:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:heatmap:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:badges:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:degrees:read': { row: 'Own profile, badges, degrees', student: SELF },
  'profile:read': { row: 'Own profile, badges, degrees', student: SELF },

  // ---- Register content repos, run syncs -----------------------------------
  // Two actions, because the two halves ask different questions.
  //
  // `repo:import` registers a repo and imports the courses in it. There is no
  // course to own yet — they do not exist until the import runs — so this is
  // a role floor, and the importer becomes the owner of what it creates.
  // KNOWN GAP, stated rather than papered over: the import pipeline upserts
  // by course slug, so a teacher importing a repo whose slug collides with an
  // existing course they do not own would write to it. Closing that is a
  // route/pipeline change (resolve the target course, then ask
  // `course:sync`), not a policy change — the action for it already exists
  // below and is already ownership-scoped.
  //
  // `course:sync` re-imports a course that already exists, which is the cell
  // that actually says "own courses" / "curriculum repo only".
  'repo:import': { row: 'Register content repos, run syncs', teacher: ALLOW, admin: ALLOW },
  'import:history:read': { row: 'Register content repos, run syncs', teacher: ALLOW, admin: ALLOW },
  'course:sync': { row: 'Register content repos, run syncs', teacher: OWN_COURSE, admin: UNOWNED_COURSE },

  // ---- Publish / set course visibility -------------------------------------
  // §12: visibility is open / restricted / hidden, lives in the database, and
  // new courses land hidden. The admin cell is "override + transfer
  // ownership" — an override of the owning teacher, not of the requirement to
  // say which course.
  'course:visibility:set': { row: 'Publish / set course visibility', teacher: OWN_COURSE, admin: ANY_COURSE },
  'course:ownership:transfer': { row: 'Publish / set course visibility', admin: ANY_COURSE },
  'course:manage:read': { row: 'Publish / set course visibility', teacher: OWN_COURSE, admin: ANY_COURSE },

  // ---- Create course-scoped badges -----------------------------------------
  // The design table writes a bare ✅ for the teacher. Scoped to a course they
  // do not own, that would contradict §5's own "course ownership scopes a
  // teacher's authority", so it is OWN_COURSE. Admin is a real — here: global
  // badges are theirs (below), course badges are not.
  'course:badge:create': { row: 'Create course-scoped badges', teacher: OWN_COURSE },

  // ---- See progress of enrolled students -----------------------------------
  // §5.2: "a teacher sees individual progress only for students enrolled in
  // courses they own, and students are told so plainly at enrollment.
  // Privacy toggles govern peer visibility, not the teaching relationship.
  // The thing to avoid is a silent override." The admin — is that override.
  'course:students:progress:read': { row: 'See progress of enrolled students', teacher: OWN_COURSE },

  // ---- Grade submissions, score rubrics (§9.4) -----------------------------
  'submission:grade': { row: 'Grade submissions, score rubrics', teacher: OWN_COURSE },
  'rubric:score': { row: 'Grade submissions, score rubrics', teacher: OWN_COURSE },

  // ---- Invite to a course (§12) --------------------------------------------
  'invite:course:create': { row: 'Invite to a course', teacher: OWN_COURSE },

  // ---- Invite to the platform (§12) ----------------------------------------
  // "A teacher's platform-invite budget defaults to 0 — creating accounts is
  // granted deliberately, not assumed." So the teacher cell is decided by the
  // budget the caller reports, and a caller that reports none is refused.
  'invite:platform:create': { row: 'Invite to the platform', teacher: FROM_BUDGET, admin: ALLOW },

  // ---- Define degrees, global badges (§9.2, §9.3) --------------------------
  'degree:define': { row: 'Define degrees, global badges', admin: ALLOW },
  'badge:global:define': { row: 'Define degrees, global badges', admin: ALLOW },

  // ---- Assign roles, grant invite budgets ----------------------------------
  'role:assign': { row: 'Assign roles, grant invite budgets', admin: ALLOW },
  'invite:budget:grant': { row: 'Assign roles, grant invite budgets', admin: ALLOW },

  // ---- Read audit log, instance settings -----------------------------------
  'audit:read': { row: 'Read audit log, instance settings', admin: ALLOW },
  'instance:settings:read': { row: 'Read audit log, instance settings', admin: ALLOW },
  'instance:settings:update': { row: 'Read audit log, instance settings', admin: ALLOW },

  // ---- NOT A §5 ROW: the account record ------------------------------------
  // §5's "Own profile" row is the LEARNER profile — badges, degrees, the
  // public page at /u/:handle. The account itself (who am I, what time zone
  // am I in, sign me out of everything) belongs to every authenticated
  // identity, operator accounts included: an admin still has to be able to
  // see who they are signed in as and to end their own sessions. Kept as
  // separate actions rather than widened student cells, so this divergence
  // from the table is visible in the vocabulary instead of hidden in a
  // predicate. Self-scoped, always.
  'me:read': { row: 'Account (not a §5 row)', student: SELF, teacher: SELF, admin: SELF },
  'me:update': { row: 'Account (not a §5 row)', student: SELF, teacher: SELF, admin: SELF },
  'session:revoke:all': { row: 'Account (not a §5 row)', student: SELF, teacher: SELF, admin: SELF },

  // ---- NOT A §5 ROW: the first-run bootstrap (§5.2) ------------------------
  // The one unauthenticated write endpoint on the instance. It is not gated
  // by a role — there are no accounts yet — but by the log-printed setup
  // token and the atomic `where bootstrapped_at is null` claim, both of which
  // live in the route and the database where they can actually be checked.
  // Login/refresh/logout are absent from this vocabulary on purpose: they are
  // how an actor comes to exist, not decisions about one.
  'instance:setup:status': { row: 'First-run bootstrap (§5.2)', student: ALLOW, teacher: ALLOW, admin: ALLOW },
  'instance:bootstrap': { row: 'First-run bootstrap (§5.2)', student: ALLOW, teacher: ALLOW, admin: ALLOW },
} satisfies Record<string, ActionPolicy>;

/** The complete action vocabulary. `can()` denies anything outside it. */
export type Action = keyof typeof MATRIX;

/** Runtime view of the same vocabulary, for tests and for tooling. */
export const ACTIONS: readonly Action[] = Object.freeze(Object.keys(MATRIX) as Action[]);

/**
 * Actions reachable without a session — the first-run bootstrap and nothing
 * else (design §5.2). Held separately from MATRIX because "which roles may do
 * this" and "is a session required at all" are different questions, and the
 * second one must not be answerable by a role entry someone adds later.
 */
const PUBLIC_ACTIONS: ReadonlySet<Action> = new Set<Action>(['instance:setup:status', 'instance:bootstrap']);

// Indexed lookup, deliberately typed as possibly-undefined: `action` is a
// compile-time union, but this module is also the last line of defence for a
// value that arrived as a string at runtime (a test, a future dynamic caller,
// a JS consumer). `Object.hasOwn` keeps `toString` / `__proto__` from
// resolving to something inherited.
const POLICIES = MATRIX as Record<string, ActionPolicy | undefined>;

const ADMIN_ONLY: readonly Role[] = Object.freeze(['admin'] as Role[]);

/**
 * The roles this decision is actually made with.
 *
 * Unknown role strings are dropped, and admin ABSORBS the learner roles
 * rather than combining with them (§5.1). Migration 0005 makes the mixed
 * state unreachable in the database; this makes it harmless everywhere else.
 */
function effectiveRoles(actor: Actor): readonly Role[] {
  const roles = actor.roles.filter((role) => KNOWN_ROLES.has(role));
  return roles.includes('admin') ? ADMIN_ONLY : roles;
}

/**
 * The single authorization chokepoint. True when `actor` may perform `action`
 * on `resource`.
 *
 * `resource` carries the database facts a synchronous decision cannot fetch:
 * `{ course: { ownerId } }` for anything §5 scopes to "own courses", and
 * `{ userId }` for anything about one person's own data. Omitting them
 * denies — see the header, property 2.
 */
export function can(actor: Actor, action: Action, resource?: unknown): boolean {
  const policy = Object.hasOwn(POLICIES, action) ? POLICIES[action] : undefined;
  if (!policy) return false;

  if (isAnonymous(actor)) return PUBLIC_ACTIONS.has(action);

  for (const role of effectiveRoles(actor)) {
    const decide = policy[role];
    if (decide && decide(actor, resource)) return true;
  }
  return false;
}

/**
 * The seeded users row from db/migrations/0004_progress_and_activity.sql,
 * which every phase-1..5 progress and activity row points at.
 *
 * NOT A DEFAULT ANYWHERE IN PRODUCTION CODE — route modules fall back to the
 * per-request actor resolved from the access token, and to ANONYMOUS_ACTOR
 * when there is none. It survives as the fixture the phase-1..5 route tests
 * inject explicitly.
 *
 * IT IS A STUDENT, not an admin. It was an admin while `can()` returned true
 * for everything, which made the choice invisible; under the real §5 matrix
 * it is a contradiction, because this row OWNS lesson_progress and
 * activity_events rows and §5.1 is explicit that admin accounts have "no
 * enrollments, no progress, no badges". The fixture was wrong, not the
 * matrix.
 */
export const DEV_ACTOR: Actor = {
  id: '00000000-0000-0000-0000-000000000001',
  roles: ['student'],
};
