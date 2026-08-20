import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run search.test.ts');
}

const pool = new Pool({ connectionString });

const TAG = 'srchroute';
const STUDENT_ID = randomUUID();
const OTHER_ID = randomUUID();

const student: Actor = { id: STUDENT_ID, roles: ['student'] };
const teacher: Actor = { id: OTHER_ID, roles: ['teacher'] };
const admin: Actor = { id: OTHER_ID, roles: ['admin'] };

async function seedVisibleLesson(): Promise<void> {
  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title, visibility) values ($1, 'Route Course', 'open') returning id`,
    [`${TAG}-course`],
  );
  const courseId = course.rows[0]!.id;
  const module = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position) values ($1, $2, 'M', 0) returning id`,
    [courseId, `${TAG}-m`],
  );
  await pool.query(
    `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks, position)
     values ($1, $2, $3, $3, 'Photosynthesis route lesson', 'x', $4, $5::jsonb, 0)`,
    [
      courseId,
      module.rows[0]!.id,
      `${TAG}-lesson`,
      randomUUID(),
      JSON.stringify([{ type: 'prose', html: '<p>About photosynthesis.</p>' }]),
    ],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`delete from courses where slug like $1`, [`${TAG}-%`]);
}

describe('GET /api/v1/search (plan Phase 16)', () => {
  beforeAll(async () => {
    setPool(pool);
    await cleanup();
    await seedVisibleLesson();
  });

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it('returns matching lessons grouped by course for a student', async () => {
    const server = await buildServer({ actor: student });
    const response = await server.inject({ method: 'GET', url: '/api/v1/search?q=photosynthesis' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { query: string; groups: { courseSlug: string; lessons: { title: string }[] }[] };
    expect(body.query).toBe('photosynthesis');
    const group = body.groups.find((candidate) => candidate.courseSlug === `${TAG}-course`);
    expect(group).toBeDefined();
    expect(group!.lessons.map((lesson) => lesson.title)).toContain('Photosynthesis route lesson');
    await server.close();
  });

  // The floor check. Each of these is refused before any query runs, so the
  // endpoint cannot be used to probe what exists — a 403 and an empty 200 are
  // very different answers to "does a course about X exist here?".
  it('refuses an anonymous caller', async () => {
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'GET', url: '/api/v1/search?q=photosynthesis' });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('refuses a teacher-only account, exactly as the catalog does', async () => {
    const server = await buildServer({ actor: teacher });
    const response = await server.inject({ method: 'GET', url: '/api/v1/search?q=photosynthesis' });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('refuses an admin, exactly as the catalog does', async () => {
    const server = await buildServer({ actor: admin });
    const response = await server.inject({ method: 'GET', url: '/api/v1/search?q=photosynthesis' });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('treats a missing or blank q as an empty result set, not a 400', async () => {
    const server = await buildServer({ actor: student });
    for (const url of ['/api/v1/search', '/api/v1/search?q=', '/api/v1/search?q=%20%20']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect((response.json() as { groups: unknown[] }).groups, url).toEqual([]);
    }
    await server.close();
  });

  it('honours limit and refuses to be talked into an unbounded one', async () => {
    const server = await buildServer({ actor: student });
    // An absurd limit is clamped, not obeyed: the response stays bounded
    // whatever the caller asks for.
    const response = await server.inject({ method: 'GET', url: '/api/v1/search?q=photosynthesis&limit=100000' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { groups: { lessons: unknown[] }[] };
    const total = body.groups.reduce((sum, group) => sum + group.lessons.length, 0);
    expect(total).toBeLessThanOrEqual(50);
    await server.close();
  });
});
