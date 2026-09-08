import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { validateBadge } from '../content/validate.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run admin-badges.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

async function applyMigrations(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [version]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const PREFIX = `adminbadge-${RUN_ID}`;
const COURSE_SLUG = `${PREFIX}-course`;

let admin: Actor;
let learner: Actor;

interface AdminBadgeBody {
  slug: string;
  title: string;
  description: string | null;
  source: 'git' | 'admin';
  courseSlug: string | null;
  criteria: { type: string; count?: number; min?: number };
  awardCount: number;
}

/** A signed-in admin, whose role is read back out of `user_roles` by the mutating routes. */
async function makeAdmin(): Promise<Actor> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, timezone) values ($1, null) returning id`,
    [`Admin Badge Test Admin ${RUN_ID}`],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [id]);
  // The token's own claim, which the mutating routes deliberately discard in
  // favour of the row above (design §13).
  return { id, roles: ['admin'] };
}

async function makeLearner(): Promise<Actor> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, timezone) values ($1, null) returning id`,
    [`Admin Badge Test Student ${RUN_ID}`],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [id]);
  return { id, roles: ['student'] };
}

async function insertBadge(
  slug: string,
  source: 'git' | 'admin',
  criteria: unknown = { type: 'lessons_completed', count: 2 },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into badges (slug, title, description, source, criteria)
     values ($1, $2, 'Seeded', $3, $4::jsonb) returning id`,
    [slug, `Badge ${slug}`, source, JSON.stringify(criteria)],
  );
  return rows[0]!.id;
}

describe('admin badge routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    admin = await makeAdmin();
    learner = await makeLearner();

    await pool.query(`insert into courses (slug, title, visibility) values ($1, $2, 'open')`, [
      COURSE_SLUG,
      'Admin Badge Test Course',
    ]);
  });

  beforeEach(async () => {
    // Every test starts from a known badge set. Safe to delete: nothing here
    // is ever awarded except in the one test that then asserts the delete is
    // refused, and that test cleans up its own award.
    await pool.query('delete from user_badges where badge_id in (select id from badges where slug like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from badges where slug like $1', [`${PREFIX}%`]);
    await pool.query('delete from degrees where slug like $1', [`${PREFIX}%`]);
  });

  afterAll(async () => {
    await pool.query('delete from user_badges where badge_id in (select id from badges where slug like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from badges where slug like $1', [`${PREFIX}%`]);
    await pool.query('delete from degrees where slug like $1', [`${PREFIX}%`]);
    await pool.query('delete from courses where slug like $1', [`${PREFIX}%`]);
    await closePool();
  });

  describe('GET /api/v1/admin/badges', () => {
    it('lists both sources with an award count, and 403s a student', async () => {
      await insertBadge(`${PREFIX}-git-one`, 'git');
      await insertBadge(`${PREFIX}-admin-one`, 'admin');

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/admin/badges' });
      expect(response.statusCode).toBe(200);

      const badges = JSON.parse(response.payload) as AdminBadgeBody[];
      const git = badges.find((b) => b.slug === `${PREFIX}-git-one`)!;
      const own = badges.find((b) => b.slug === `${PREFIX}-admin-one`)!;
      expect(git.source).toBe('git');
      expect(own.source).toBe('admin');
      expect(own.awardCount).toBe(0);
      await fastify.close();

      const asStudent = await buildServer({ actor: learner });
      const denied = await asStudent.inject({ method: 'GET', url: '/api/v1/admin/badges' });
      expect(denied.statusCode).toBe(403);
      await asStudent.close();
    });
  });

  describe('POST /api/v1/admin/badges', () => {
    it('creates an admin-sourced badge', async () => {
      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/badges',
        payload: {
          slug: `${PREFIX}-new`,
          title: 'A New Badge',
          description: 'Tuned against real data',
          course: COURSE_SLUG,
          criteria: { type: 'track_score', track: 'cx', min: 90 },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload) as AdminBadgeBody;
      expect(body.source).toBe('admin');
      expect(body.courseSlug).toBe(COURSE_SLUG);
      expect(body.criteria).toEqual({ type: 'track_score', track: 'cx', min: 90 });
      await fastify.close();
    });

    it('rejects criteria outside the closed vocabulary with a 400', async () => {
      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/badges',
        payload: {
          slug: `${PREFIX}-bogus`,
          title: 'Bogus',
          // A ninth type. Design §9.3: adding one is a deliberate platform
          // change, not something a POST body can do.
          criteria: { type: 'lessons_read', count: 3 },
        },
      });

      expect(response.statusCode).toBe(400);
      const rows = await pool.query('select 1 from badges where slug = $1', [`${PREFIX}-bogus`]);
      expect(rows.rowCount).toBe(0);
      await fastify.close();
    });

    it('409s on a slug already taken by a git badge — slugs are globally unique across both sources', async () => {
      await insertBadge(`${PREFIX}-taken`, 'git');

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/badges',
        payload: {
          slug: `${PREFIX}-taken`,
          title: 'Colliding',
          criteria: { type: 'streak_days', days: 3 },
        },
      });

      expect(response.statusCode).toBe(409);
      await fastify.close();
    });

    it('400s a course scope this instance has never imported', async () => {
      // Unlike the importer, which tolerates a manifest naming another
      // repo's course (design §8's cross-repo rule is about IMPORTS), an
      // admin typing a slug into a form has simply made a mistake — and a
      // badge silently created unscoped would be a global badge nobody
      // asked for.
      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/badges',
        payload: {
          slug: `${PREFIX}-nocourse`,
          title: 'Scoped To Nothing',
          course: `${PREFIX}-not-imported`,
          criteria: { type: 'streak_days', days: 3 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect((JSON.parse(response.payload) as { message: string }).message).toMatch(/No course with slug/);
      const rows = await pool.query('select 1 from badges where slug = $1', [`${PREFIX}-nocourse`]);
      expect(rows.rowCount).toBe(0);
      await fastify.close();
    });
  });

  describe('PATCH /api/v1/admin/badges/:badgeSlug', () => {
    it('retunes an admin badge without touching its awards', async () => {
      const badgeId = await insertBadge(`${PREFIX}-tune`, 'admin');
      await pool.query('insert into user_badges (user_id, badge_id) values ($1, $2)', [learner.id, badgeId]);

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/admin/badges/${PREFIX}-tune`,
        payload: { title: 'Retuned', criteria: { type: 'lessons_completed', count: 40 } },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as AdminBadgeBody;
      expect(body.title).toBe('Retuned');
      expect(body.criteria).toEqual({ type: 'lessons_completed', count: 40 });

      // Design §9.3: badges are never revoked. The award predates the edit
      // and survives it.
      expect(body.awardCount).toBe(1);
      const awards = await pool.query('select 1 from user_badges where badge_id = $1', [badgeId]);
      expect(awards.rowCount).toBe(1);
      await fastify.close();
    });

    it('refuses to edit a GIT-sourced badge (409) — the next sync would undo it', async () => {
      await insertBadge(`${PREFIX}-fromgit`, 'git');

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/admin/badges/${PREFIX}-fromgit`,
        payload: { title: 'Trying to edit git' },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.payload).message).toMatch(/git-sourced/);

      const row = await pool.query<{ title: string }>('select title from badges where slug = $1', [
        `${PREFIX}-fromgit`,
      ]);
      expect(row.rows[0]!.title).toBe(`Badge ${PREFIX}-fromgit`);
      await fastify.close();
    });

    it('404s an unknown slug', async () => {
      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/admin/badges/${PREFIX}-nope`,
        payload: { title: 'Nothing' },
      });
      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('refuses a field of the wrong shape, and writes nothing when it does', async () => {
      await insertBadge(`${PREFIX}-shapes`, 'admin');
      const fastify = await buildServer({ actor: admin });

      const cases: Array<{ what: string; payload: Record<string, unknown>; expect: RegExp }> = [
        {
          what: 'criteria outside the closed vocabulary',
          payload: { criteria: { type: 'lessons_read', count: 3 } },
          expect: /Invalid criteria/,
        },
        { what: 'a blank title', payload: { title: '   ' }, expect: /title must be a non-empty string/ },
        {
          what: 'a description that is neither a string nor null',
          payload: { description: 7 },
          expect: /description must be a string or null/,
        },
        {
          what: 'a course that is not a slug at all',
          payload: { course: 7 },
          expect: /course must be a course slug or null/,
        },
        {
          what: 'a course slug this instance does not have',
          payload: { course: `${PREFIX}-not-imported` },
          expect: /No course with slug/,
        },
      ];

      for (const testCase of cases) {
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/admin/badges/${PREFIX}-shapes`,
          payload: testCase.payload,
        });
        expect(response.statusCode, testCase.what).toBe(400);
        expect((JSON.parse(response.payload) as { message: string }).message, testCase.what).toMatch(testCase.expect);
      }

      // The badge is exactly as it was seeded. Every refusal above happens
      // before the UPDATE, and the UPDATE is one statement with a coalesce
      // per column — so a refusal that leaked through would show up here as
      // a badge that lost a field it never asked to change.
      const { rows } = await pool.query<{
        title: string;
        description: string | null;
        criteria: unknown;
        course_id: string | null;
      }>('select title, description, criteria, course_id from badges where slug = $1', [`${PREFIX}-shapes`]);
      expect(rows[0]).toMatchObject({
        title: `Badge ${PREFIX}-shapes`,
        description: 'Seeded',
        criteria: { type: 'lessons_completed', count: 2 },
        course_id: null,
      });

      await fastify.close();
    });

    it('re-scopes a badge to a course that does exist', async () => {
      // The mirror of the refusal above, and the reason it cannot simply be
      // "any string is fine": a valid slug has to resolve to a real
      // `course_id`, because that column is what every course-scoped badge
      // query joins on.
      await insertBadge(`${PREFIX}-rescope`, 'admin');
      const fastify = await buildServer({ actor: admin });

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/admin/badges/${PREFIX}-rescope`,
        payload: { course: COURSE_SLUG },
      });
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.payload) as AdminBadgeBody).courseSlug).toBe(COURSE_SLUG);

      await fastify.close();
    });
  });

  describe('DELETE /api/v1/admin/badges/:badgeSlug', () => {
    it('deletes an unearned admin badge', async () => {
      await insertBadge(`${PREFIX}-unearned`, 'admin');

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/admin/badges/${PREFIX}-unearned`,
      });

      expect(response.statusCode).toBe(204);
      const rows = await pool.query('select 1 from badges where slug = $1', [`${PREFIX}-unearned`]);
      expect(rows.rowCount).toBe(0);
      await fastify.close();
    });

    it('refuses to delete a badge somebody earned (409) — deleting would revoke an award', async () => {
      const badgeId = await insertBadge(`${PREFIX}-earned`, 'admin');
      await pool.query('insert into user_badges (user_id, badge_id) values ($1, $2)', [learner.id, badgeId]);

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/admin/badges/${PREFIX}-earned`,
      });

      expect(response.statusCode).toBe(409);
      const rows = await pool.query('select 1 from badges where id = $1', [badgeId]);
      expect(rows.rowCount).toBe(1);
      await fastify.close();
    });

    it('refuses to delete a git-sourced badge (409)', async () => {
      await insertBadge(`${PREFIX}-gitdel`, 'git');

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({ method: 'DELETE', url: `/api/v1/admin/badges/${PREFIX}-gitdel` });
      expect(response.statusCode).toBe(409);
      await fastify.close();
    });

    it('404s a slug that was never there', async () => {
      // Distinct from the two 409s above: "no such badge" and "that badge
      // may not be deleted" are different answers, and collapsing them
      // would make a typo look like a policy refusal.
      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({ method: 'DELETE', url: `/api/v1/admin/badges/${PREFIX}-ghost` });
      expect(response.statusCode).toBe(404);
      await fastify.close();
    });
  });

  describe('GET /api/v1/admin/badges/:badgeSlug/export', () => {
    it('emits a course.yaml badges: list item that validates against the badge schema', async () => {
      await pool.query(
        `insert into badges (slug, title, description, source, course_id, criteria)
         values ($1, 'The Complexity Eye', 'Tuned against real data', 'admin',
                 (select id from courses where slug = $2), $3::jsonb)`,
        [`${PREFIX}-export`, COURSE_SLUG, JSON.stringify({ type: 'track_score', track: 'cx', min: 90 })],
      );

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/admin/badges/${PREFIX}-export/export`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/yaml/);

      // Indented two spaces, so it pastes under a `badges:` key whose other
      // items are indented too — mixing the two is a YAML parse error.
      expect(response.payload.split('\n')[0]).toMatch(/^ {2}- slug:/);

      // The round trip is the point of the feature (design §9.3: "promoted
      // into git"): what comes out must be what an importer would accept.
      const parsed = parseYaml(response.payload) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(validateBadge(parsed[0]).valid).toBe(true);
      expect(parsed[0]).toEqual({
        slug: `${PREFIX}-export`,
        title: 'The Complexity Eye',
        description: 'Tuned against real data',
        course: COURSE_SLUG,
        criteria: { type: 'track_score', track: 'cx', min: 90 },
      });

      await fastify.close();
    });

    it('404s an unknown slug and 403s a student', async () => {
      const fastify = await buildServer({ actor: admin });
      const missing = await fastify.inject({ method: 'GET', url: `/api/v1/admin/badges/${PREFIX}-gone/export` });
      expect(missing.statusCode).toBe(404);
      await fastify.close();

      await insertBadge(`${PREFIX}-private`, 'admin');
      const asStudent = await buildServer({ actor: learner });
      const denied = await asStudent.inject({
        method: 'GET',
        url: `/api/v1/admin/badges/${PREFIX}-private/export`,
      });
      expect(denied.statusCode).toBe(403);
      await asStudent.close();
    });

    it('422s a badge that would not validate, rather than emitting YAML that cannot be imported', async () => {
      // Nothing in the authoring path can create this: the importer and the
      // admin POST both validate against schemas/badge.schema.json first. A
      // restored backup, a hand-edited row, or a criteria type retired from
      // the schema can — and design §9.3's whole point in having an export
      // is that the fragment can be pasted into a curriculum repo. An export
      // that does not validate would fail on the next import of that repo,
      // and the operator would only find out then.
      await pool.query(
        `insert into badges (slug, title, description, source, criteria)
         values ($1, 'Half A Badge', null, 'git', $2::jsonb)`,
        // `streak_days` requires `days`; jsonb happily stores it without.
        [`${PREFIX}-unexportable`, JSON.stringify({ type: 'streak_days' })],
      );

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/v1/admin/badges/${PREFIX}-unexportable/export`,
      });

      expect(response.statusCode).toBe(422);
      const message = (JSON.parse(response.payload) as { message: string }).message;
      // The message has to name the badge and say what is wrong with it —
      // an operator staring at a 422 with no detail cannot fix the row.
      expect(message).toMatch(`${PREFIX}-unexportable`);
      expect(message).toMatch(/badge\.schema\.json/);
      await fastify.close();
    });
  });

  describe('GET /api/v1/admin/degrees', () => {
    it('marks a degree naming an unimported course unsatisfiable, and names the missing slugs', async () => {
      await pool.query(
        `insert into degrees (slug, title, description, required_slugs, electives_choose, electives_from)
         values ($1, 'Admin Degree', null, $2::text[], 0, '{}'::text[])`,
        [`${PREFIX}-degree`, [COURSE_SLUG, `${PREFIX}-absent`]],
      );

      const fastify = await buildServer({ actor: admin });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/admin/degrees' });
      expect(response.statusCode).toBe(200);

      const degrees = JSON.parse(response.payload) as Array<{
        slug: string;
        satisfiable: boolean;
        missingCourses: string[];
        required: string[];
        electives: unknown;
        awardCount: number;
      }>;
      const degree = degrees.find((d) => d.slug === `${PREFIX}-degree`)!;
      expect(degree.satisfiable).toBe(false);
      expect(degree.missingCourses).toEqual([`${PREFIX}-absent`]);
      expect(degree.required).toEqual([COURSE_SLUG, `${PREFIX}-absent`]);
      expect(degree.electives).toBeNull();
      expect(degree.awardCount).toBe(0);
      await fastify.close();
    });
  });

  describe('the policy seam', () => {
    it('asks can() with the badge action and 403s when denied', async () => {
      const canSpy = vi.fn().mockReturnValue(false);
      const fastify = await buildServer({ actor: admin, can: canSpy });

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/badges',
        payload: { slug: `${PREFIX}-denied`, title: 'Denied', criteria: { type: 'streak_days', days: 2 } },
      });

      expect(response.statusCode).toBe(403);
      const [, actionArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('badge:global:define');

      // Denied before any write.
      const rows = await pool.query('select 1 from badges where slug = $1', [`${PREFIX}-denied`]);
      expect(rows.rowCount).toBe(0);
      await fastify.close();
    });
  });
});
