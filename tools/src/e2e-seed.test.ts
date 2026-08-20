import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { verifyPassword } from '@learn/api/auth/password';

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run e2e-seed.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.join(here, 'migrate.ts');
const seedCli = path.join(here, 'e2e-seed.ts');
const fixturesFile = path.resolve(here, '../../e2e/.fixtures.json');

// The CLI reads DATABASE_URL. Spawning the real binary (not calling
// seedE2eFixtures in-process) is deliberate, same reasoning as
// tools/src/seed.test.ts: a test that never executes the CLI's own
// argv/env handling and safety guard would not actually cover them.
const cliEnv = { ...process.env, DATABASE_URL: connectionString };

async function seed(): Promise<{ stdout: string }> {
  const { stdout } = await run(process.execPath, [seedCli], { env: cliEnv });
  return { stdout: stdout.trim() };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

interface FixtureFile {
  courseSlug: string;
  lessonSlug: string;
  invite: { email: string; token: string; acceptPath: string };
  viewportUser: { email: string; password: string };
}

describe.sequential('e2e-seed CLI', () => {
  const pool = new Pool({ connectionString });

  beforeAll(async () => {
    await run(process.execPath, [migrateCli], { env: cliEnv });
  });

  afterAll(async () => {
    // courses cascades modules/lessons; user emails cascade their own
    // roles/enrollments/progress (0004/0005/0009's `on delete cascade`).
    // invites.issued_by is `on delete set null`, so any invite rows this
    // suite created are cleaned up explicitly rather than left orphaned.
    await pool.query(`delete from courses where slug = 'e2e-course'`);
    await pool.query(
      `delete from users where email in ('e2e-issuer@example.test', 'e2e-student@example.test', 'e2e-viewport@example.test')`,
    );
    await pool.query(`delete from invites where email = 'e2e-student@example.test'`);
    await pool.end();
  });

  it('creates an open course with a module and the reader lesson', async () => {
    await seed();

    const { rows } = await pool.query(
      `select c.slug as course_slug, c.visibility, m.key as module_key, l.slug as lesson_slug, l.title, l.blocks
         from courses c
         join modules m on m.course_id = c.id
         join lessons l on l.module_id = m.id
        where c.slug = 'e2e-course'
        order by l.slug`,
    );

    // Identified by slug rather than by row count. Fixture lessons get added
    // as later specs need them — the exercise lesson arrived with Phase 15's
    // accessibility pass, which needed a submission to point its grading-view
    // route at — and a bare `toHaveLength(1)` here turned that unrelated
    // addition into two red tests. What this test actually cares about is the
    // reader lesson's shape, so it asserts that directly.
    const reader = rows.find((row) => row.lesson_slug === 'e2e-lesson');
    expect(reader, 'the reader lesson e2e-lesson should exist').toBeDefined();
    expect(reader.visibility).toBe('open');
    expect(reader.module_key).toBe('e2e-module');
    expect(reader.title).toBe('Getting started');
    expect(reader.blocks).toHaveLength(3);
    expect(reader.blocks[0].type).toBe('prose');
    expect(reader.blocks[1].type).toBe('code');
    expect(reader.blocks[2].type).toBe('prose');
  });

  it('creates an admin issuer and one pending platform invite for the fixed address', async () => {
    const { stdout } = await seed();
    expect(stdout).toContain('e2e-student@example.test');

    const issuer = await pool.query(
      `select u.id, r.role from users u join user_roles r on r.user_id = u.id where u.email = 'e2e-issuer@example.test'`,
    );
    expect(issuer.rows).toHaveLength(1);
    expect(issuer.rows[0].role).toBe('admin');

    const pending = await pool.query(
      `select kind, creates_account, budget_consumed, token_hash
         from invites
        where email = 'e2e-student@example.test' and accepted_at is null and revoked_at is null`,
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].kind).toBe('platform');
    expect(pending.rows[0].creates_account).toBe(true);
    expect(pending.rows[0].budget_consumed).toBe(false);

    const fixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;
    expect(fixtures.invite.email).toBe('e2e-student@example.test');
    expect(hashToken(fixtures.invite.token)).toBe(pending.rows[0].token_hash);
    expect(fixtures.invite.acceptPath).toBe(`/invite/${fixtures.invite.token}`);
  });

  it('creates an already-registered viewport-spec account that can sign in with the fixture password', async () => {
    await seed();
    const fixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;

    expect(fixtures.viewportUser.email).toBe('e2e-viewport@example.test');

    const viewportUser = await pool.query<{ id: string; password_hash: string | null }>(
      `select u.id, u.password_hash, r.role
         from users u join user_roles r on r.user_id = u.id
        where u.email = $1`,
      [fixtures.viewportUser.email],
    );
    expect(viewportUser.rows).toHaveLength(1);
    expect(viewportUser.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect((viewportUser.rows[0] as unknown as { role: string }).role).toBe('student');

    // Not just "a hash was stored" — the exact fixture password the spec
    // will type into the login form actually verifies against it.
    await expect(verifyPassword(viewportUser.rows[0]!.password_hash, fixtures.viewportUser.password)).resolves.toBe(
      true,
    );
  });

  it('re-seeding does not duplicate the viewport account or its role, and its password keeps working', async () => {
    await seed();
    const firstFixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;
    await seed();
    const secondFixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;

    expect(secondFixtures.viewportUser).toEqual(firstFixtures.viewportUser);

    const users = await pool.query(`select id from users where email = $1`, [firstFixtures.viewportUser.email]);
    expect(users.rows).toHaveLength(1);
    const roles = await pool.query(`select role from user_roles where user_id = $1`, [users.rows[0].id]);
    expect(roles.rows).toHaveLength(1);
    expect(roles.rows[0].role).toBe('student');

    const passwordHash = await pool.query<{ password_hash: string }>(
      `select password_hash from users where id = $1`,
      [users.rows[0].id],
    );
    await expect(
      verifyPassword(passwordHash.rows[0]!.password_hash, secondFixtures.viewportUser.password),
    ).resolves.toBe(true);
  });

  it('re-seeding does not duplicate the course/module/lessons and rotates to a fresh pending invite', async () => {
    // Ids of every module and lesson hanging off the fixture course, in a
    // stable order. Compared before and after the second seed rather than
    // counted: "does not duplicate" is a property of the second seed relative
    // to the first — the same rows, with the same ids, upserted rather than
    // inserted again. Asserting fixed counts instead goes red every time a
    // later spec needs another fixture, which is exactly what happened when
    // the accessibility pass added an exercise module and lesson.
    const contentIds = async (): Promise<{ modules: string[]; lessons: string[] }> => {
      const modules = await pool.query<{ id: string }>(
        `select m.id from courses c join modules m on m.course_id = c.id
          where c.slug = 'e2e-course' order by m.key`,
      );
      const lessons = await pool.query<{ id: string }>(
        `select l.id
           from courses c
           join modules m on m.course_id = c.id
           join lessons l on l.module_id = m.id
          where c.slug = 'e2e-course'
          order by l.slug`,
      );
      return { modules: modules.rows.map((row) => row.id), lessons: lessons.rows.map((row) => row.id) };
    };

    await seed();
    const firstFixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;
    const afterFirstSeed = await contentIds();
    expect(afterFirstSeed.modules.length).toBeGreaterThan(0);
    expect(afterFirstSeed.lessons.length).toBeGreaterThan(0);

    await seed();
    const secondFixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;

    const courses = await pool.query(`select id from courses where slug = 'e2e-course'`);
    expect(courses.rows).toHaveLength(1);
    expect(await contentIds()).toEqual(afterFirstSeed);

    // A fresh token each run — the old one's plaintext can never come back
    // (only its hash is stored), so re-seeding always rotates rather than
    // pretending to reuse it.
    expect(secondFixtures.invite.token).not.toBe(firstFixtures.invite.token);

    const pending = await pool.query(
      `select id from invites where email = 'e2e-student@example.test' and accepted_at is null and revoked_at is null`,
    );
    expect(pending.rows).toHaveLength(1); // exactly one live invite, not two

    const oldHash = hashToken(firstFixtures.invite.token);
    const revoked = await pool.query(
      `select revoked_at from invites where email = 'e2e-student@example.test' and token_hash = $1`,
      [oldHash],
    );
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();
  });

  it('resets a previously-registered fixture account back to a pending invite', async () => {
    await seed();
    const fixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;

    // Simulate what api/src/invites/accept.ts does on registration: an
    // account appears at the invited address and the invite is spent.
    const registered = await pool.query<{ id: string }>(
      `insert into users (email, handle, display_name) values ($1, 'e2e-student', 'E2E Student') returning id`,
      [fixtures.invite.email],
    );
    await pool.query(
      `update invites set accepted_at = now() where email = $1 and accepted_at is null and revoked_at is null`,
      [fixtures.invite.email],
    );

    await seed();

    const stillThere = await pool.query(`select id from users where id = $1`, [registered.rows[0]!.id]);
    expect(stillThere.rows).toHaveLength(0); // the simulated registration was reset

    const pending = await pool.query(
      `select id from invites where email = $1 and accepted_at is null and revoked_at is null`,
      [fixtures.invite.email],
    );
    expect(pending.rows).toHaveLength(1);
  });

  it('resets a fixture account even after it has recorded an append-only activity event', async () => {
    await seed();
    const fixtures = JSON.parse(await readFile(fixturesFile, 'utf8')) as FixtureFile;

    // Same registration simulation as the test above, plus the one extra
    // step that actually broke a second seed run while building Phase 15
    // task 2's "mark a lesson complete" journey: activity_events is
    // append-only (0004_progress_and_activity.sql's before-delete trigger),
    // and users.id -> activity_events.user_id is `on delete cascade` — so
    // once this account has one of these rows, a plain `delete from users`
    // fails with "activity_events is append-only: DELETE is not permitted"
    // and every subsequent seed run breaks the whole harness before a
    // single spec starts. resetInvitedAccount (e2e-seed.ts) is the fix;
    // this is its regression test.
    const registered = await pool.query<{ id: string }>(
      `insert into users (email, handle, display_name) values ($1, 'e2e-student', 'E2E Student') returning id`,
      [fixtures.invite.email],
    );
    await pool.query(`insert into activity_events (user_id, type) values ($1, 'lesson_completed')`, [
      registered.rows[0]!.id,
    ]);
    await pool.query(
      `update invites set accepted_at = now() where email = $1 and accepted_at is null and revoked_at is null`,
      [fixtures.invite.email],
    );

    await seed(); // must not throw

    const stillThere = await pool.query(`select id from users where id = $1`, [registered.rows[0]!.id]);
    expect(stillThere.rows).toHaveLength(0); // the simulated registration was reset

    const pending = await pool.query(
      `select id from invites where email = $1 and accepted_at is null and revoked_at is null`,
      [fixtures.invite.email],
    );
    expect(pending.rows).toHaveLength(1);
  });

  it('clears badge definitions left behind by other suites, so the feed stays deterministic', async () => {
    // vitest and Playwright share one TEST_DATABASE_URL, and the badge suites
    // leave definitions behind. Badges are awarded by criteria, so a stale one
    // the fixture student satisfies becomes another badge_awarded row in their
    // feed — and the dashboard shows only twenty entries, so enough leftovers
    // push the lesson_completed event the core journey asserts on off the end.
    // This is the guard against that failure returning silently.
    await pool.query(
      `insert into badges (slug, title, source, criteria)
       values ('leftover-from-another-suite', 'Leftover', 'admin', $1::jsonb)`,
      [JSON.stringify({ kind: 'lessons_completed', count: 1 })],
    );
    expect((await pool.query(`select 1 from badges`)).rows.length).toBeGreaterThan(0);

    await seed();

    const badges = await pool.query(`select slug from badges`);
    expect(badges.rows).toHaveLength(0);
  });

  it('clears accounts accumulated by other suites, so /admin/people stays a known size', async () => {
    // Same failure mode as the stale badges: vitest and Playwright share one
    // database and both create accounts, nothing removed them, and the
    // accessibility spec's axe scan of /admin/people walks every row — it had
    // grown to 18-20s against a 30s timeout before this existed.
    const strays = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of strays) {
      await pool.query(`insert into users (id, display_name) values ($1, 'stray from another suite')`, [id]);
    }

    await seed();

    const left = await pool.query(`select id from users where id = any($1::uuid[])`, [strays]);
    expect(left.rows).toHaveLength(0);

    // The seeded DEV_ACTOR must survive — migration 0004's rows point at it.
    const devActor = await pool.query(`select 1 from users where id = '00000000-0000-0000-0000-000000000001'`);
    expect(devActor.rows).toHaveLength(1);
  });

  it('refuses to run against a database whose name does not say "test"', async () => {
    const nonTestEnv = { ...process.env, DATABASE_URL: 'postgres://learn:x@localhost:5432/learn_prod_lookalike' };
    await expect(run(process.execPath, [seedCli], { env: nonTestEnv })).rejects.toThrow();
  });
});
