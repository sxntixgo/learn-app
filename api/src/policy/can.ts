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
// VISIBILITY (§12), ADDED HERE, EXACTLY AS THE SEAM INTENDED
// ------------------------------------------------------------------
// Migration 0008 adds `courses.visibility` (open / restricted / hidden,
// defaulting to hidden) and 0009 adds `enrollments`. This is the "same
// change that adds those columns" the previous version of this comment
// promised: `course:read` / `lesson:read` / `course:enrol` now read
// `resource.course.visibility` alongside `ownerId`, below. No route changed
// shape to get this — they already passed a `course` context, and now pass
// one more fact on it, which is the whole point of the seam (CLAUDE.md rule
// 2's third bullet).
//
// THE OWNERSHIP BYPASS. §5: a teacher "can author a course only they can
// read — register a repo, let the course land hidden, self-enroll." That
// sentence is the reason STUDENT_VISIBLE_OR_OWN and STUDENT_ENROLLABLE below
// both check ownership FIRST and visibility second: the owner reads and
// enrols in their own course regardless of its visibility, provided they
// also hold the student role (§5: "a teacher holding BOTH roles"). A
// teacher-only owner (no student role) does not get this — they read their
// course's settings through `course:manage:read` instead, which is
// unconditional on ownership and does not care about visibility at all.
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

/** `courses.visibility` (migration 0008). */
export type CourseVisibility = 'open' | 'restricted' | 'hidden';

const COURSE_VISIBILITIES: ReadonlySet<CourseVisibility> = new Set<CourseVisibility>([
  'open',
  'restricted',
  'hidden',
]);

/** The ownership fact for a course-scoped decision. `ownerId: null` = unowned. */
export interface CourseContext {
  /** `courses.owner_id` (migration 0007). Null means no teacher owns it. */
  ownerId: string | null;
  /**
   * `courses.visibility` (migration 0008). Optional because most
   * course-scoped actions (sync, badges, grading, invites, manage) do not
   * depend on it — only the visibility-aware decisions below read it, and
   * they treat an absent/invalid value as "the caller forgot", not as
   * `open`. See courseContextOf.
   */
  visibility?: CourseVisibility | null;
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
  const visibilityRaw = (course as { visibility?: unknown }).visibility;
  const visibility =
    typeof visibilityRaw === 'string' && COURSE_VISIBILITIES.has(visibilityRaw as CourseVisibility)
      ? (visibilityRaw as CourseVisibility)
      : null;
  if (ownerId === null) return { ownerId: null, visibility };
  if (typeof ownerId === 'string' && ownerId !== '') return { ownerId, visibility };
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

/**
 * §12: a course is readable by a browsing student when it is LISTED (open
 * or restricted — hidden is "absent from the catalog") OR the actor owns
 * it. The ownership check comes first and does not consult visibility at
 * all: this is what lets a teacher-who-is-also-a-student read their own
 * course the moment it lands `hidden` at import, per §5's "let the course
 * land hidden, self-enroll". A missing/unrecognised visibility denies for a
 * non-owner — the same "caller forgot" failure mode as a missing ownerId
 * (property 2), not a silent "treat it as open".
 */
const STUDENT_VISIBLE_OR_OWN: Decision = (actor, resource) => {
  const course = courseContextOf(resource);
  if (course === null) return false;
  if (course.ownerId !== null && course.ownerId === actor.id) return true;
  return course.visibility === 'open' || course.visibility === 'restricted';
};

/**
 * §12: a student may self-enrol in an `open` course, or in a course they
 * own (again, ownership checked first, independent of visibility — the
 * self-enrollment §5 describes for a teacher's own hidden course). A
 * `restricted` course is listed but requires a teacher's invite (Phase 13,
 * not built), so it denies here for anyone but the owner; the route
 * distinguishes "needs an invite" from "does not exist" by reading
 * `visibility` itself; see api/src/routes/courses.ts.
 */
const STUDENT_ENROLLABLE: Decision = (actor, resource) => {
  const course = courseContextOf(resource);
  if (course === null) return false;
  if (course.ownerId !== null && course.ownerId === actor.id) return true;
  return course.visibility === 'open';
};

/** §12: a teacher may issue a platform invite only out of a non-zero budget. */
const FROM_BUDGET: Decision = (_actor, resource) => {
  const remaining = budgetRemainingOf(resource);
  return remaining !== null && remaining > 0;
};

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
  // Phase 16. Deliberately the same grant as `course:list`, not a broader
  // one: search is the catalog reached by typing, so anyone who may not
  // browse the catalog may not search it either. It takes no course context
  // because it spans courses — the per-result visibility filtering is
  // `lesson:read`'s rule applied in SQL, and api/src/search/query.test.ts
  // asserts the two agree for every role/visibility/ownership combination
  // rather than trusting that they do.
  'search:query': { row: 'Enroll, read, track own progress', student: ALLOW },
  'course:read': { row: 'Enroll, read, track own progress', student: STUDENT_VISIBLE_OR_OWN },
  'lesson:read': { row: 'Enroll, read, track own progress', student: STUDENT_VISIBLE_OR_OWN },
  'course:enrol': { row: 'Enroll, read, track own progress', student: STUDENT_ENROLLABLE },
  'lesson:progress:write': { row: 'Enroll, read, track own progress', student: SELF },
  'course:progress:read': { row: 'Enroll, read, track own progress', student: SELF },
  // Phase 7: submitting a quiz attempt (design §9.1 — "passed, through the
  // new scoring endpoint") is the SAME kind of action as writing progress:
  // about the actor's own record, nothing else. SELF, not a new predicate.
  'lesson:quiz:submit': { row: 'Enroll, read, track own progress', student: SELF },
  // Phase 8: exercise submissions (design §9.4). Three actions, all SELF,
  // all about the actor's own work — reading their own submission, saving a
  // draft of it, and handing it in.
  //
  // There is deliberately NO teacher cell on any of them. §9.4: "a
  // submission and its annotations are visible to the student who wrote it
  // and to teachers of the OWNING COURSE" — the second half is
  // `submission:grade` below, which is OWN_COURSE. A teacher cell here
  // would be a role check, and a role check would hand every teacher on the
  // instance every student's work.
  'lesson:exercise:read': { row: 'Enroll, read, track own progress', student: SELF },
  'lesson:exercise:save': { row: 'Enroll, read, track own progress', student: SELF },
  'lesson:exercise:submit': { row: 'Enroll, read, track own progress', student: SELF },

  // ---- Own profile, badges, degrees ----------------------------------------
  // The learner-facing profile of design §11. §5.1: operator accounts have
  // "no enrollments, no progress, no badges, and no public profile".
  'me:activity:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:heatmap:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:badges:read': { row: 'Own profile, badges, degrees', student: SELF },
  'me:degrees:read': { row: 'Own profile, badges, degrees', student: SELF },
  'profile:read': { row: 'Own profile, badges, degrees', student: SELF },
  // Phase 12 (§11). Changing your own handle-page settings — bio, the five
  // section toggles, the `noindex` switch. SELF for the same reason
  // `profile:read` is: it is only ever about the account holder's own page,
  // and there is deliberately no teacher or admin cell. A teacher-only
  // account has no learner profile to configure (the §5 row above is
  // student-only), and §5.1 is explicit that an operator account has "no
  // public profile" at all.
  'profile:update': { row: 'Own profile, badges, degrees', student: SELF },
  // Account portability and erasure. SELF for both, and granted to `teacher`
  // as well as `student`: a teacher-only account holds real data (the courses
  // it owns, the invites it issued) and must be able to leave. `admin` is
  // deliberately absent — an admin account is instance infrastructure, and
  // self-deleting the last one would leave nobody able to administer the
  // instance. Removing an admin belongs in admin tooling, where the
  // last-admin check can live; see the plan's Gate 12 entry.
  'me:export': { row: 'Own profile, badges, degrees', student: SELF, teacher: SELF },
  'me:delete': { row: 'Own profile, badges, degrees', student: SELF, teacher: SELF },

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
  // The grading QUEUE (§9.4: "across the courses they own") is not a
  // single-course decision the way `submission:grade` is — there is no one
  // `{ course: { ownerId } }` to check, because the whole point is spanning
  // every course the actor owns at once. So this is a role floor, same shape
  // as `import:history:read`: `can()` only answers "is this actor a
  // teacher", and the route's own SQL does the actual scoping, keyed off the
  // actor's id (`courses.owner_id = actor.id`) rather than off a resource
  // this function could check. Not OWNERSHIP_SCOPED in can.test.ts for that
  // reason — there is no per-call course context to forget.
  'submission:queue:read': { row: 'Grade submissions, score rubrics', teacher: ALLOW },

  // ---- Invite to a course (§12) --------------------------------------------
  'invite:course:create': { row: 'Invite to a course', teacher: OWN_COURSE },

  // ---- Invite to the platform (§12) ----------------------------------------
  // "A teacher's platform-invite budget defaults to 0 — creating accounts is
  // granted deliberately, not assumed." So the teacher cell is decided by the
  // budget the caller reports, and a caller that reports none is refused.
  //
  // Phase 13 asks this cell for ANY invite that would create an account,
  // including a COURSE invite to an address that has no account yet (§12's
  // "one action issues one link that both registers the person and enrolls
  // them"). Creating an account is the budgeted power; which screen it was
  // reached from is not a licence to skip the budget.
  'invite:platform:create': { row: 'Invite to the platform', teacher: FROM_BUDGET, admin: ALLOW },

  // Phase 13, both role floors in the same sense `submission:queue:read` is
  // one: the resource is "the invites this actor may see/act on", which
  // spans many courses and cannot be reduced to a single
  // `{ course: { ownerId } }` for `can()` to check. The scoping is the
  // route's own SQL — `issued_by = actor.id` for a teacher, unscoped for an
  // admin — keyed off the actor's id rather than off a resource. §12 is
  // explicit that the unscoped view is an ADMIN screen: "admins get a screen
  // listing every invite with issuer and status".
  'invite:list': { row: 'Invite to a course / to the platform', teacher: ALLOW, admin: ALLOW },
  'invite:revoke': { row: 'Invite to a course / to the platform', teacher: ALLOW, admin: ALLOW },

  // ---- Define degrees, global badges (§9.2, §9.3) --------------------------
  'degree:define': { row: 'Define degrees, global badges', admin: ALLOW },
  'badge:global:define': { row: 'Define degrees, global badges', admin: ALLOW },
  // Phase 11. The rest of the badge lifecycle, split by VERB rather than
  // folded into `badge:global:define`, because these are the actions an
  // audit log has to be able to tell apart: reading every definition,
  // retuning one, removing one, and exporting one to YAML for promotion
  // into git (§9.3).
  //
  // Role floors, like `submission:queue:read` and unlike the course-scoped
  // rows: the resource is the badge catalogue as a whole, and there is no
  // per-call `{ course: { ownerId } }` for `can()` to check. The refusals
  // that actually protect a badge — a git-sourced row is read-only, an
  // earned badge cannot be deleted — are not authorization questions at
  // all and live in the route and in the schema respectively (migration
  // 0013's `on delete restrict`).
  //
  // §5's teacher cell for "create course-scoped badges" is
  // `course:badge:create` above, which is OWN_COURSE and deliberately not
  // widened here: these actions reach every badge on the instance.
  'badge:list': { row: 'Define degrees, global badges', admin: ALLOW },
  'badge:update': { row: 'Define degrees, global badges', admin: ALLOW },
  'badge:delete': { row: 'Define degrees, global badges', admin: ALLOW },
  'badge:export': { row: 'Define degrees, global badges', admin: ALLOW },
  'degree:list': { row: 'Define degrees, global badges', admin: ALLOW },

  // ---- Assign roles, grant invite budgets ----------------------------------
  'role:assign': { row: 'Assign roles, grant invite budgets', admin: ALLOW },
  'invite:budget:grant': { row: 'Assign roles, grant invite budgets', admin: ALLOW },
  // Phase 13: the roster those two mutations act on. Not folded into either
  // of them, because "who is on this instance" is a read an audit log should
  // be able to tell apart from a grant — and not folded into
  // `instance:settings:read` either, because a list of people is not a
  // setting. Admin only: §5's row is admin-only, and a teacher has no reason
  // to enumerate every account on the instance.
  'user:list': { row: 'Assign roles, grant invite budgets', admin: ALLOW },

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

  // ---- NOT A §5 ROW: the public profile page (§11) -------------------------
  // §11's `/u/:handle` is reachable without a session — that is what the
  // per-section visibility, the rate limit, the `noindex` toggle and the Open
  // Graph tags in §11 are all FOR. So this action is public in the same
  // narrow sense the bootstrap ones are: it says "this endpoint may be
  // reached", not "this reader may see anything". WHAT comes back is decided
  // by profile/visibility.ts against the viewer, and the deny-by-default
  // serializer means the answer for a stranger is, by default, a handle and
  // nothing else.
  //
  // It carries no resource because it cannot: an anonymous reader is
  // identified by nothing, and the subject of the page is resolved from a
  // handle in the path AFTER this check. The self-scoped `profile:read`
  // above is what the route then asks to find out whether this viewer is the
  // owner and gets the unfiltered view.
  'profile:public:read': { row: 'Public profile (§11, not a §5 row)', student: ALLOW, teacher: ALLOW, admin: ALLOW },

  // ---- NOT A §5 ROW: accepting an invitation (§12, §13) --------------------
  // The second and third unauthenticated endpoints on the instance, and for
  // the same reason as the bootstrap: an invitee has no account yet, so
  // there is no role to check. What gates them is the invite token — 256
  // bits of randomness, stored only as a SHA-256, bound to one email address,
  // single-use, expiring — and the atomic `where accepted_at is null` claim
  // (invites/accept.ts). A role cell here would be meaningless; the token IS
  // the authorization, exactly as the setup token is for the bootstrap.
  //
  // `invite:preview` reveals what a link is for (which course, which
  // address) to whoever holds the link — which is the invitee, by
  // construction. It reveals nothing to anyone who does not.
  'invite:preview': { row: 'Accept an invitation (§12, not a §5 row)', student: ALLOW, teacher: ALLOW, admin: ALLOW },
  'invite:accept': { row: 'Accept an invitation (§12, not a §5 row)', student: ALLOW, teacher: ALLOW, admin: ALLOW },
} satisfies Record<string, ActionPolicy>;

/** The complete action vocabulary. `can()` denies anything outside it. */
export type Action = keyof typeof MATRIX;

/** Runtime view of the same vocabulary, for tests and for tooling. */
export const ACTIONS: readonly Action[] = Object.freeze(Object.keys(MATRIX) as Action[]);

/**
 * Actions reachable without a session: the first-run bootstrap (§5.2) and the
 * public profile page (§11). Held separately from MATRIX because "which roles
 * may do this" and "is a session required at all" are different questions, and
 * the second one must not be answerable by a role entry someone adds later —
 * adding a `student:` cell to an action does NOT make it reachable anonymously.
 */
const PUBLIC_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'instance:setup:status',
  'instance:bootstrap',
  // Phase 12 (§11): the profile page is an unauthenticated ROUTE, not
  // unauthenticated DATA. See the action's entry in MATRIX.
  'profile:public:read',
  // Phase 13 (§12, §13): an invitee has no account yet. Gated by the invite
  // token and the atomic claim, not by a role.
  'invite:preview',
  'invite:accept',
]);

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
