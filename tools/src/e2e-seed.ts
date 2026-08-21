import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseLesson } from '@learn/api/content/parse';
import { hashSnapshot, presentBlocks } from '@learn/api/content/present';
import { hashInviteToken } from '@learn/api/invites/token';
import { hashPassword } from '@learn/api/auth/password';
import { parseConnectionString } from './pg-conn.ts';

const { Pool } = pg;

// Phase 15 task 1: fixture data for the Playwright harness (root
// playwright.config.ts / e2e/). Task 2's journeys read the identifiers
// exported below rather than re-deriving them, so this is the one place
// that defines what "the seeded course" and "the invite" mean.
//
// Modeled on tools/src/seed.ts's "scratch course" idiom (direct SQL,
// idempotent upserts) rather than on the real importer (@learn/api/content/import)
// or the app's own bootstrap/invite HTTP routes: those exist to enforce
// policy and budgets for real users, and none of that applies to a fixture
// this script owns end to end. Where the row shape matters for a later
// journey to work (invite token hashing, lesson blocks), this reuses the
// exact production code that produces it — @learn/api/content/parse for
// blocks, @learn/api/invites/token for the token hash — rather than a
// second, possibly-drifting implementation of either.

export const E2E_COURSE_SLUG = 'e2e-course';
const E2E_MODULE_KEY = 'e2e-module';
const E2E_LESSON_KEY = 'e2e-lesson';
/**
 * Phase 15 task 4: a second module/lesson, kind 'exercise', under the SAME
 * course rather than a new one — E2E_COURSE_SLUG already has a teacher
 * owner (ensureTeacherUser) and E2E_VIEWPORT_* already has a student
 * session, so this only needs to add the one thing neither existing lesson
 * is: something with a real submission to grade. Reaches the last
 * previously-unreachable route, the grading view
 * (/courses/.../submissions/[userId]), which is also the other place
 * AnnotatableCode's `grade` mode lives.
 */
const E2E_EXERCISE_MODULE_KEY = 'e2e-exercise-module';
const E2E_EXERCISE_LESSON_KEY = 'e2e-exercise-lesson';

export const E2E_ISSUER_EMAIL = 'e2e-issuer@example.test';
const E2E_ISSUER_HANDLE = 'e2e-issuer';
/**
 * Phase 15 task 4 (accessibility pass): the issuer account already exists
 * as an admin (see ensureIssuer) purely to issue the platform invite below.
 * Giving it a password too means task 4 can sign in as an admin to reach
 * /admin/* and the admin half of /invites without inventing a second admin
 * identity — there is nothing role-specific left to model once it can log
 * in, it already carries the 'admin' row.
 */
export const E2E_ADMIN_PASSWORD = 'a-long-enough-admin-password';

/** The address Phase 15 task 2's "register via invite" journey registers as. */
export const E2E_INVITE_EMAIL = 'e2e-student@example.test';

/**
 * Phase 15 task 3 (viewport specs): an already-registered account with a
 * known password, distinct from E2E_INVITE_EMAIL.
 *
 * The invite above is single-use (invites are single-use by design, §13)
 * and task 2's core-journeys spec is the one thing allowed to consume it —
 * two specs racing to accept the same token would mean whichever runs
 * second gets a 410 and no session. Viewport specs need a session too (the
 * heatmap and feed are behind auth, design §10/§13) but have no need to
 * exercise registration itself — that is task 2's job — so this fixture
 * skips straight to a signed-in state via the login form instead of
 * spending the invite.
 */
export const E2E_VIEWPORT_EMAIL = 'e2e-viewport@example.test';
export const E2E_VIEWPORT_HANDLE = 'e2e-viewport';
export const E2E_VIEWPORT_PASSWORD = 'a-long-enough-password-too';

/**
 * Phase 15 task 4: an already-registered teacher, same idiom as
 * E2E_VIEWPORT_* — signs in through the login form, never through an
 * invite. Made the owner of E2E_COURSE_SLUG (see ensureTeacherUser) so
 * task 4 can reach /grading and the teacher half of /invites, and so the
 * course page's owner-only controls have a real owner session to render
 * for. Course READ access is unconditional on ownership for 'open'
 * visibility (api/src/policy/can.ts) — handing this course an owner cannot
 * change what task 2/3's specs already see as an anonymous/student viewer.
 */
export const E2E_TEACHER_EMAIL = 'e2e-a11y-teacher@example.test';
export const E2E_TEACHER_HANDLE = 'e2e-a11y-teacher';
export const E2E_TEACHER_PASSWORD = 'a-long-enough-teacher-password';

/**
 * A disposable account, seeded ONLY so the account-deletion e2e spec has
 * something real to actually delete. Every other fixture user in this file
 * (`viewportUser`, `teacherUser`, the issuer) is depended on by other specs
 * — viewport.spec.ts and a11y.spec.ts both sign in as `viewportUser`, for
 * instance — so deleting one of those mid-suite would break every spec that
 * runs after it in the same worker. This account has no such dependents:
 * nothing else in e2e/ ever signs in as it, enrols it, or reads its data.
 *
 * Re-created (not merely upserted-and-left) on every seed run via
 * `ensureDeletableUser`'s call to `resetInvitedAccount`, the same helper
 * `issueFreshPlatformInvite` uses to reset E2E_INVITE_EMAIL — because
 * `playwright.config.ts` sets `reuseExistingServer: false`, every `npm run
 * e2e` invocation re-seeds from scratch, so "the account the previous run's
 * deletion spec deleted" and "the account this run's deletion spec expects
 * to find" are the same identity across runs only because this reset makes
 * it so.
 */
export const E2E_DELETABLE_EMAIL = 'e2e-deletable@example.test';
export const E2E_DELETABLE_HANDLE = 'e2e-deletable';
export const E2E_DELETABLE_PASSWORD = 'a-long-enough-deletable-password';

/**
 * Phase 12 (§11.1): a student who exists only to have their avatar changed.
 *
 * A DEDICATED account rather than reusing `viewportUser`, for the same
 * reason `deletableUser` is one: the avatar spec MUTATES the account it signs
 * in as, and `viewportUser` is depended on, live, by viewport.spec.ts and
 * a11y.spec.ts running in other workers at the same moment
 * (`fullyParallel: true`). Swapping that account's face mid-scan is the kind
 * of cross-file coupling that produces a failure in a spec that never
 * mentioned avatars.
 *
 * Reset on every seed run so a leftover upload from a previous run does not
 * make "starts on the identicon" false.
 */
export const E2E_AVATAR_EMAIL = 'e2e-avatar@example.test';
export const E2E_AVATAR_HANDLE = 'e2e-avatar';
export const E2E_AVATAR_PASSWORD = 'a-long-enough-avatar-password';

/**
 * A student who has read nothing yet, for the stale-dashboard spec.
 *
 * Dedicated and RESET every run for one reason: the spec's whole subject is
 * what the dashboard shows immediately after a lesson is completed for the
 * FIRST time. An account that already completed it in a previous run would
 * make the assertion pass without the write under test happening at all.
 */
export const E2E_FEED_EMAIL = 'e2e-feed@example.test';
export const E2E_FEED_HANDLE = 'e2e-feed';
export const E2E_FEED_PASSWORD = 'a-long-enough-feed-password';

/**
 * Phase 15 task 4: a second, dedicated platform invite, distinct from
 * `invite` (task 2's, single-use and consumed by core-journeys.spec.ts).
 * The accessibility pass only needs to LOAD /invite/[token] and axe-scan
 * the real "you are invited" form — it never accepts it — so this token
 * stays valid for the lifetime of a seeded database and never races task 2
 * for the one it owns.
 */
const E2E_A11Y_INVITE_EMAIL = 'e2e-a11y-invite@example.test';

const INVITE_TTL_DAYS = 14;

// Real markdown through the real parser (seed.ts does the same), so the
// stored `blocks` are exactly what a real import would produce rather than
// a hand-built JSON array that only happens to look right.
const LESSON_MARKDOWN = [
  '# Getting started',
  '',
  'This lesson is seeded fixture data for the Playwright harness (Phase 15) — it exists so an',
  'end-to-end spec has something real to read, not because anyone authored it.',
  '',
  '```text',
  // Phase 15 task 4 (accessibility pass): a real in-source `[!note]` marker
  // (design §6.3, api/src/content/parse.ts's `extractAnnotations`), parsed
  // through the same real importer code every other fixture line here goes
  // through. Without at least one annotation, AnnotatableCode's own
  // `interactive` check (AnnotatableCode.tsx) is false in `read` mode and
  // the block renders as plain code with nothing to tab through — task 4
  // needs a genuinely interactive, annotated block reachable from a lesson
  // a session already has (no new course/role fixtures required), not a
  // synthetic one built only for the accessibility spec to look at.
  'hello, e2e  # [!note] Seeded so the annotatable code block has something to tab to.',
  '```',
  '',
  // A real ```mermaid fence, so the diagram block has something to draw. The
  // corpus this app imports already contains these; before the diagram block
  // existed they rendered as a wall of unhighlighted source.
  '```mermaid',
  '%% caption: How a lesson reaches a reader',
  'graph LR;',
  '  Repo[Content repo] --> Import[Import];',
  '  Import --> Blocks[Typed blocks];',
  '  Blocks --> Reader[Reader];',
  '```',
  '',
  'A closing paragraph, so the lesson renders more than one block.',
  '',
].join('\n');
const LESSON_SOURCE_PATH = 'e2e/fixtures/getting-started.md';

// A minimal exercise (design §9.4: code + rubric), parsed through the same
// real `parseLesson` as LESSON_MARKDOWN. The author annotation gives the
// grading view's AnnotatableCode (`grade` mode) something anchored to read
// alongside the student's own submission, same reasoning as LESSON_MARKDOWN's.
const EXERCISE_MARKDOWN = [
  '# Add two numbers',
  '',
  'An exercise lesson seeded for the accessibility pass (Phase 15 task 4) — a real submission for a',
  'teacher to grade, not a lesson to read.',
  '',
  '```python',
  'def add(a, b):  # [!note] Confirm this handles negative numbers too.',
  '    return a + b',
  '```',
  '',
  '```rubric',
  'criteria:',
  '  - name: Correctness',
  '    max: 5',
  '```',
  '',
].join('\n');
const EXERCISE_SOURCE_PATH = 'e2e/fixtures/add-two-numbers.md';

export interface E2eFixtures {
  courseSlug: string;
  lessonSlug: string;
  invite: {
    email: string;
    /** Plaintext, valid exactly once per seed run — see issueFreshPlatformInvite. */
    token: string;
    acceptPath: string;
  };
  /** Phase 15 task 3: sign in with these rather than consuming `invite`. */
  viewportUser: {
    email: string;
    password: string;
  };
  /** Phase 15 task 4: sign in as the admin who issued `invite`, to reach /admin/* and /invites. */
  adminUser: {
    email: string;
    password: string;
  };
  /** Phase 15 task 4: sign in as the teacher who owns `courseSlug`, to reach /grading and /invites. */
  teacherUser: {
    email: string;
    password: string;
  };
  /** Phase 15 task 4: a live, never-consumed invite distinct from `invite` — see E2E_A11Y_INVITE_EMAIL. */
  a11yInvite: {
    acceptPath: string;
  };
  /** Phase 15 task 4: the grading view — a real submitted exercise, owned by `teacherUser`, submitted by `viewportUser`. */
  exerciseSubmission: {
    courseSlug: string;
    lessonSlug: string;
    studentUserId: string;
  };
  /**
   * A disposable account for the account-deletion spec to actually delete
   * — see E2E_DELETABLE_EMAIL's own comment for why this one, uniquely, has
   * no other spec depending on it.
   */
  /** A student enrolled but with nothing completed, for the stale-dashboard spec. */
  feedUser: {
    email: string;
    password: string;
    handle: string;
  };
  /** Phase 12 (§11.1): a student dedicated to the avatar spec's mutations. */
  avatarUser: {
    email: string;
    password: string;
    handle: string;
  };
  deletableUser: {
    email: string;
    password: string;
    handle: string;
  };
}

async function ensureCourseModuleLesson(
  client: pg.PoolClient,
): Promise<{ courseId: string; courseSlug: string; lessonSlug: string }> {
  // `visibility` defaults to 'hidden' (db/migrations/0008); set explicitly
  // to 'open' on every run so a course a previous local run happened to
  // unpublish (there is no code path that does this today, but nothing
  // stops a future admin-UI test from task 2 doing it) doesn't leave the
  // catalog spec unable to see it.
  const course = await client.query<{ id: string; slug: string }>(
    `
    insert into courses (slug, title, subtitle, visibility)
    values ($1, $2, $3, 'open')
    on conflict (slug) do update set
      title = excluded.title,
      subtitle = excluded.subtitle,
      visibility = 'open'
    returning id, slug
    `,
    [E2E_COURSE_SLUG, 'E2E Course', 'Seeded fixture data for the Playwright harness'],
  );
  const courseId = course.rows[0]!.id;

  const module = await client.query<{ id: string }>(
    `
    insert into modules (course_id, key, title, position)
    values ($1, $2, $3, 0)
    on conflict (course_id, key) do update set title = excluded.title
    returning id
    `,
    [courseId, E2E_MODULE_KEY, 'E2E Module'],
  );
  const moduleId = module.rows[0]!.id;

  const parsed = parseLesson(LESSON_MARKDOWN);
  const contentHash = createHash('sha256').update(LESSON_MARKDOWN).digest('hex');
  const blocksJson = JSON.stringify(parsed.blocks);

  const lesson = await client.query<{ slug: string }>(
    `
    insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks, position)
    values ($1, $2, $3, $3, $4, $5, $6, $7, 0)
    on conflict (module_id, lesson_key) do update set
      title = excluded.title,
      source_path = excluded.source_path,
      content_hash = excluded.content_hash,
      blocks = excluded.blocks,
      updated_at = now()
    returning slug
    `,
    [courseId, moduleId, E2E_LESSON_KEY, parsed.title, LESSON_SOURCE_PATH, contentHash, blocksJson],
  );

  return { courseId, courseSlug: course.rows[0]!.slug, lessonSlug: lesson.rows[0]!.slug };
}

/**
 * The account that issues the fixture invite. Admin, so its unlimited
 * invite budget (design §12) never needs modeling here. Phase 15 task 4
 * gives it a real password (hashed exactly like ensureViewportUser's) so
 * it doubles as the admin session /admin/* and /invites need — it already
 * carries the 'admin' role for task 2's purposes.
 */
async function ensureIssuer(client: pg.PoolClient): Promise<string> {
  const passwordHash = await hashPassword(E2E_ADMIN_PASSWORD);
  const user = await client.query<{ id: string }>(
    `
    insert into users (email, handle, display_name, password_hash, platform_invite_budget)
    values ($1, $2, $3, $4, 0)
    on conflict (email) do update set handle = excluded.handle, password_hash = excluded.password_hash
    returning id
    `,
    [E2E_ISSUER_EMAIL, E2E_ISSUER_HANDLE, 'E2E Issuer', passwordHash],
  );
  const issuerId = user.rows[0]!.id;
  await client.query(
    `insert into user_roles (user_id, role) values ($1, 'admin') on conflict (user_id, role) do nothing`,
    [issuerId],
  );
  return issuerId;
}

/**
 * Creates/refreshes the teacher account and makes it the owner of
 * E2E_COURSE_SLUG — see the module doc on E2E_TEACHER_EMAIL for why.
 */
async function ensureTeacherUser(client: pg.PoolClient, courseSlug: string): Promise<void> {
  const passwordHash = await hashPassword(E2E_TEACHER_PASSWORD);
  const user = await client.query<{ id: string }>(
    `
    insert into users (email, handle, password_hash, display_name)
    values ($1, $2, $3, $4)
    on conflict (email) do update set handle = excluded.handle, password_hash = excluded.password_hash
    returning id
    `,
    [E2E_TEACHER_EMAIL, E2E_TEACHER_HANDLE, passwordHash, 'E2E Teacher'],
  );
  const teacherId = user.rows[0]!.id;
  await client.query(
    `insert into user_roles (user_id, role) values ($1, 'teacher') on conflict (user_id, role) do nothing`,
    [teacherId],
  );
  await client.query(`update courses set owner_id = $2 where slug = $1`, [courseSlug, teacherId]);
}

/**
 * Deletes the account at `email`, cascading its enrollments/progress along
 * with it (0004/0009: user tables reference `users` with on delete
 * cascade) — a prior local run's "register via invite" journey (Phase 15
 * task 2) may have already claimed it.
 *
 * `activity_events` is in that cascade too (`user_id ... on delete
 * cascade`, 0004_progress_and_activity.sql) but is also append-only: a
 * `before delete` trigger unconditionally rejects any DELETE against it,
 * including the one Postgres issues on its own behalf to satisfy that
 * cascade. Once the fixture account has done anything Phase 15 task 2's
 * journey does — marking a lesson complete emits a `lesson_completed` row —
 * a plain `delete from users` starts failing with "activity_events is
 * append-only: DELETE is not permitted", which is not hypothetical: it is
 * exactly what broke the SECOND run of the harness while building that
 * journey, before a single spec even started. Migration 0005 built
 * `audit_log` around this same trap (a bare `actor_id`, deliberately not a
 * foreign key, precisely so an account doing anything privileged doesn't
 * become permanently undeletable) but 0004 predates that lesson and left
 * `activity_events` an FK.
 *
 * Rewriting that schema is out of scope here (Phase 15 task 2 is journeys,
 * not migrations). Disabling the one trigger that blocks the delete, only
 * for the duration of this one transaction, is the narrowest fix available
 * — `learn` owns the table (verified: table owner, not superuser), so this
 * needs no elevated privilege, and the whole thing rolls back cleanly
 * (including the trigger's enabled state, since DDL is transactional in
 * Postgres) if anything here fails. Safe only because this whole module
 * refuses to run against anything but a database whose name contains
 * "test" — see main().
 */
async function resetInvitedAccount(client: pg.PoolClient, email: string): Promise<void> {
  await client.query('begin');
  try {
    // Uses the supported erasure carve-out (migration 0017) rather than
    // disabling the trigger. The previous version did
    // `alter table activity_events disable trigger ...`, which takes an
    // ACCESS EXCLUSIVE lock and switches the append-only guarantee OFF for
    // the whole table — every other session included — for as long as the
    // transaction runs. `set local app.erasing_user` is scoped to this
    // transaction AND to this one account: nobody else's history is
    // deletable even while it is set.
    const { rows } = await client.query<{ id: string }>(`select id from users where email = $1`, [email]);
    for (const row of rows) {
      await client.query(`set local app.erasing_user = '${row.id}'`);
      await client.query(`delete from users where id = $1`, [row.id]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

/**
 * Creates/refreshes the already-registered viewport-spec account (a plain
 * upsert, not a run through invites/accept.ts — there is no invite to
 * consume here, and this fixture only ever needs to exist and be able to
 * sign in). Hashing goes through the real `hashPassword` (api/src/auth/
 * password.ts) so login exercises the real Argon2id verify path rather
 * than a hand-rolled stand-in.
 */
async function ensureViewportUser(client: pg.PoolClient): Promise<string> {
  const passwordHash = await hashPassword(E2E_VIEWPORT_PASSWORD);
  const user = await client.query<{ id: string }>(
    `
    insert into users (email, handle, password_hash, display_name)
    values ($1, $2, $3, $4)
    on conflict (email) do update set handle = excluded.handle, password_hash = excluded.password_hash
    returning id
    `,
    [E2E_VIEWPORT_EMAIL, E2E_VIEWPORT_HANDLE, passwordHash, 'E2E Viewport'],
  );
  const userId = user.rows[0]!.id;
  await client.query(
    `insert into user_roles (user_id, role) values ($1, 'student') on conflict (user_id, role) do nothing`,
    [userId],
  );
  return userId;
}

/**
 * Creates a fresh disposable account for the account-deletion e2e spec to
 * actually delete — see E2E_DELETABLE_EMAIL's own comment for why this
 * fixture, uniquely among the ones in this file, needs no `on conflict do
 * update` upsert: `resetInvitedAccount` (already used above by
 * `issueFreshPlatformInvite` for the identical "idempotent across repeated
 * local runs" reason) deletes any leftover account at this address first,
 * via the same erasure carve-out `deleteAccount` itself uses, so a plain
 * insert afterward always starts from nothing rather than colliding with —
 * or silently reusing — whatever a previous run's deletion spec left
 * behind.
 */
async function ensureDeletableUser(client: pg.PoolClient): Promise<void> {
  await resetInvitedAccount(client, E2E_DELETABLE_EMAIL);
  const passwordHash = await hashPassword(E2E_DELETABLE_PASSWORD);
  const user = await client.query<{ id: string }>(
    `insert into users (email, handle, password_hash, display_name) values ($1, $2, $3, $4) returning id`,
    [E2E_DELETABLE_EMAIL, E2E_DELETABLE_HANDLE, passwordHash, 'E2E Deletable'],
  );
  const userId = user.rows[0]!.id;
  await client.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [userId]);
}

/**
 * The stale-dashboard spec's account: enrolled in the course, with nothing
 * completed. Reset every run so "the first completion" is genuinely the
 * first one.
 */
async function ensureFeedUser(client: pg.PoolClient, courseId: string): Promise<void> {
  await resetInvitedAccount(client, E2E_FEED_EMAIL);
  const passwordHash = await hashPassword(E2E_FEED_PASSWORD);
  const user = await client.query<{ id: string }>(
    `insert into users (email, handle, password_hash, display_name) values ($1, $2, $3, $4) returning id`,
    [E2E_FEED_EMAIL, E2E_FEED_HANDLE, passwordHash, 'E2E Feed'],
  );
  const userId = user.rows[0]!.id;
  await client.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [userId]);
  // Enrolled already: the spec is about what happens after a COMPLETION, and
  // walking the enrolment flow first would only add a second thing that could
  // fail for unrelated reasons.
  await client.query(
    `insert into enrollments (user_id, course_id) values ($1, $2) on conflict (user_id, course_id) do nothing`,
    [userId, courseId],
  );
}

/**
 * Phase 12 (§11.1): the account the avatar spec uploads to. Reset the same
 * way `ensureDeletableUser` is, so every run starts on the identicon.
 */
async function ensureAvatarUser(client: pg.PoolClient): Promise<void> {
  await resetInvitedAccount(client, E2E_AVATAR_EMAIL);
  const passwordHash = await hashPassword(E2E_AVATAR_PASSWORD);
  const user = await client.query<{ id: string }>(
    `insert into users (email, handle, password_hash, display_name) values ($1, $2, $3, $4) returning id`,
    [E2E_AVATAR_EMAIL, E2E_AVATAR_HANDLE, passwordHash, 'E2E Avatar'],
  );
  const userId = user.rows[0]!.id;
  await client.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [userId]);
  // The public page has to be reachable for the anonymous half of the spec,
  // and every section defaults to private (§11) — which is right, and means
  // the header alone is what a stranger sees. That header is where the
  // avatar lives, so nothing else needs opening.
  await client.query(`update users set profile_noindex = true where id = $1`, [userId]);
}

/**
 * Phase 15 task 4: the exercise lesson + its one submitted submission, so
 * the grading view (/courses/.../submissions/[userId]) has something real
 * to render. `studentUserId` is E2E_VIEWPORT_EMAIL's id — reusing the
 * viewport account rather than minting a third student, since nothing here
 * needs it to be a distinct identity, only a real one that can log in.
 *
 * Snapshot/hash are computed with the SAME production functions
 * (`presentBlocks`, `hashSnapshot`, api/src/content/present.ts) the real
 * submit route uses (api/src/routes/submissions.ts's own
 * `createSubmission`), so this is a real, valid snapshot, not a hand-built
 * one the route's own invariants would reject.
 *
 * Idempotent the same way the rest of this module is: the exercise
 * content never changes between seed runs, so re-running this with the
 * same snapshot/hash is a no-op UPDATE that migration 0011's freeze
 * trigger allows (it only rejects a snapshot/snapshot_hash that actually
 * changes) — status/submitted_at may legitimately move to 'returned' if a
 * spec grades it, and this resets them back to 'submitted' on the next
 * seed run without touching the frozen columns.
 */
async function ensureExerciseSubmission(
  client: pg.PoolClient,
  courseId: string,
  studentUserId: string,
): Promise<{ lessonSlug: string }> {
  const module = await client.query<{ id: string }>(
    `
    insert into modules (course_id, key, title, position)
    values ($1, $2, $3, 1)
    on conflict (course_id, key) do update set title = excluded.title
    returning id
    `,
    [courseId, E2E_EXERCISE_MODULE_KEY, 'E2E Exercise Module'],
  );
  const moduleId = module.rows[0]!.id;

  const parsed = parseLesson(EXERCISE_MARKDOWN);
  const contentHash = createHash('sha256').update(EXERCISE_MARKDOWN).digest('hex');
  const blocksJson = JSON.stringify(parsed.blocks);

  const lesson = await client.query<{ id: string; slug: string }>(
    `
    insert into lessons
      (course_id, module_id, lesson_key, slug, title, kind, source_path, content_hash, blocks, position)
    values ($1, $2, $3, $3, $4, 'exercise', $5, $6, $7, 0)
    on conflict (module_id, lesson_key) do update set
      title = excluded.title,
      source_path = excluded.source_path,
      content_hash = excluded.content_hash,
      blocks = excluded.blocks,
      updated_at = now()
    returning id, slug
    `,
    [courseId, moduleId, E2E_EXERCISE_LESSON_KEY, parsed.title, EXERCISE_SOURCE_PATH, contentHash, blocksJson],
  );
  const lessonId = lesson.rows[0]!.id;

  const snapshotJson = JSON.stringify(presentBlocks(parsed.blocks));
  const snapshotHash = hashSnapshot(snapshotJson);

  await client.query(
    `
    insert into exercise_submissions (user_id, lesson_id, status, snapshot, snapshot_hash, submitted_at)
    values ($1, $2, 'submitted', $3::jsonb, $4, now())
    on conflict (user_id, lesson_id) do update set
      status = 'submitted',
      submitted_at = now(),
      returned_at = null,
      updated_at = now()
    `,
    [studentUserId, lessonId, snapshotJson, snapshotHash],
  );

  return { lessonSlug: lesson.rows[0]!.slug };
}

/**
 * Issues a fresh, pending platform invite for `email` and returns its
 * plaintext token.
 *
 * Idempotency here can't mean "reuse what's there": invite tokens are
 * stored only as a SHA-256 hash (api/src/invites/token.ts) precisely so the
 * plaintext can never be recovered after issue, which is exactly what a
 * second `npm run e2e:seed` would need to hand back a still-valid token.
 * So a re-seed instead resets to a known-good state:
 *
 *   1. delete any account at that address — see resetInvitedAccount.
 *   2. revoke any invite still pending for that address, so at most one is
 *      ever live for it.
 *   3. issue a brand new one.
 *
 * Safe only because this whole module refuses to run against anything but
 * a database whose name contains "test" — see main(). Generalised over
 * `email` in Phase 15 task 4 so the accessibility pass's own invite
 * (E2E_A11Y_INVITE_EMAIL) can be issued the identical way task 2's is,
 * without a second copy of this logic.
 */
async function issueFreshPlatformInvite(
  client: pg.PoolClient,
  issuerId: string,
  email: string,
): Promise<E2eFixtures['invite']> {
  await resetInvitedAccount(client, email);
  await client.query(
    `update invites set revoked_at = now() where email = $1 and accepted_at is null and revoked_at is null`,
    [email],
  );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await client.query(
    `
    insert into invites (kind, issued_by, email, token_hash, course_id, expires_at, creates_account, budget_consumed)
    values ('platform', $1, $2, $3, null, $4, true, false)
    `,
    [issuerId, email, hashInviteToken(token), expiresAt],
  );

  return { email, token, acceptPath: `/invite/${token}` };
}

/**
 * Clears badge and degree definitions, and with them (by `cascade`) every
 * award and activity event in the database.
 *
 * This exists because vitest and Playwright share one physical
 * `TEST_DATABASE_URL`, and the badge suites leave their definitions behind —
 * roughly fourteen per `npm test`, accumulating without bound across runs.
 * Badges are awarded by criteria, not by name, so every stale definition the
 * fixture student happens to satisfy becomes another `badge_awarded` row in
 * their feed. The dashboard feed shows twenty entries; once the leftovers
 * exceed that, they push the `lesson_completed` event the core journey
 * asserts on off the end of the list and the spec fails — having proved
 * nothing about the app. Locally that is a hard failure; in CI, where the
 * database is fresh, it is a single `npm test` worth of leftovers sitting
 * just under the limit, which is a spec waiting to break rather than one
 * that works.
 *
 * `truncate`, not `delete`: `activity_events` is append-only, enforced by a
 * `before delete` trigger (migration 0004) that rejects a plain `delete`
 * outright. `truncate` does not fire row-level triggers, and `cascade`
 * reaches `user_badges`, `user_degrees` and `activity_events` — which
 * reference `badges` — in one statement.
 *
 * Safe only because this module refuses to run against anything but a
 * database whose name says "test" (see main()).
 */
async function clearAwardableState(client: pg.PoolClient): Promise<void> {
  await client.query('truncate table badges, degrees cascade');
}

/**
 * The uuid migration 0004 seeds as DEV_ACTOR. Every phase-1..5 progress and
 * activity row points at it, and policy/can.ts names it, so it is the one
 * account that must survive a reset.
 */
const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Removes every account except the seeded DEV_ACTOR, so a run starts from a
 * known population rather than an accumulated one.
 *
 * Same failure mode as the stale badges above, found the same way. vitest and
 * Playwright share one TEST_DATABASE_URL and both create accounts; nothing
 * removed them, so they accumulated — 2,354 of them by the time this was
 * written. `/admin/people` renders that list, and the accessibility spec's
 * axe scan of it walks every row: the scan had grown to 18-20s against a 30s
 * test timeout, and eventually tipped over it. The spec was not flaky; it was
 * measuring a database that kept getting bigger.
 *
 * Ordered after clearAwardableState deliberately: that truncates
 * `activity_events` (via its FK to `badges`), so no account has history left
 * and this plain DELETE cannot hit the append-only trigger. Everything else
 * follows each FK's own rule — personal rows cascade, `courses.owner_id` and
 * `invites.issued_by` go null.
 *
 * Safe only because this module refuses to run against anything but a
 * database whose name says "test" (see main()).
 */
async function clearAccumulatedAccounts(client: pg.PoolClient): Promise<void> {
  await client.query(`delete from users where id <> $1`, [DEV_ACTOR_ID]);
}

/** Creates/refreshes every fixture the Playwright harness needs. Safe to call repeatedly. */
export async function seedE2eFixtures(pool: pg.Pool): Promise<E2eFixtures> {
  const client = await pool.connect();
  try {
    await clearAwardableState(client);
    await clearAccumulatedAccounts(client);
    const { courseId, courseSlug, lessonSlug } = await ensureCourseModuleLesson(client);
    const issuerId = await ensureIssuer(client);
    const invite = await issueFreshPlatformInvite(client, issuerId, E2E_INVITE_EMAIL);
    const a11yInvite = await issueFreshPlatformInvite(client, issuerId, E2E_A11Y_INVITE_EMAIL);
    const viewportUserId = await ensureViewportUser(client);
    await ensureTeacherUser(client, courseSlug);
    const exercise = await ensureExerciseSubmission(client, courseId, viewportUserId);
    await ensureDeletableUser(client);
    await ensureAvatarUser(client);
    await ensureFeedUser(client, courseId);
    return {
      courseSlug,
      lessonSlug,
      invite,
      viewportUser: { email: E2E_VIEWPORT_EMAIL, password: E2E_VIEWPORT_PASSWORD },
      adminUser: { email: E2E_ISSUER_EMAIL, password: E2E_ADMIN_PASSWORD },
      teacherUser: { email: E2E_TEACHER_EMAIL, password: E2E_TEACHER_PASSWORD },
      a11yInvite: { acceptPath: a11yInvite.acceptPath },
      exerciseSubmission: {
        courseSlug,
        lessonSlug: exercise.lessonSlug,
        studentUserId: viewportUserId,
      },
      deletableUser: {
        email: E2E_DELETABLE_EMAIL,
        password: E2E_DELETABLE_PASSWORD,
        handle: E2E_DELETABLE_HANDLE,
      },
      avatarUser: {
        email: E2E_AVATAR_EMAIL,
        password: E2E_AVATAR_PASSWORD,
        handle: E2E_AVATAR_HANDLE,
      },
      feedUser: {
        email: E2E_FEED_EMAIL,
        password: E2E_FEED_PASSWORD,
        handle: E2E_FEED_HANDLE,
      },
    };
  } finally {
    client.release();
  }
}

const FIXTURES_OUT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../e2e/.fixtures.json',
);

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  // This script DELETEs rows (issueFreshPlatformInvite) to stay idempotent
  // across repeated local runs. That is fine for a disposable test
  // database and never fine for anything else, so it refuses to run
  // against a database whose name doesn't say "test" — the same shape of
  // guard as CLAUDE.md's "web must never receive DATABASE_URL", applied to
  // a script rather than a service.
  const { database } = parseConnectionString(connectionString);
  if (!database.toLowerCase().includes('test') && !process.env.E2E_SEED_ALLOW_NON_TEST_DB) {
    console.error(
      `Refusing to run against database ${JSON.stringify(database)}: tools/src/e2e-seed.ts deletes and ` +
        're-creates fixture rows and is meant for a test database only. Point DATABASE_URL at one whose ' +
        'name contains "test", or set E2E_SEED_ALLOW_NON_TEST_DB=1 to override.',
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    const fixtures = await seedE2eFixtures(pool);
    await mkdir(path.dirname(FIXTURES_OUT_FILE), { recursive: true });
    await writeFile(FIXTURES_OUT_FILE, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');
    console.log(
      `Seeded e2e fixtures: course=${fixtures.courseSlug} lesson=${fixtures.lessonSlug} invite=${fixtures.invite.email}`,
    );
    console.log(`Fixture manifest written to ${FIXTURES_OUT_FILE}`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
