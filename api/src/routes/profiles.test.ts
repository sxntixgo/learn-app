import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';
import { avatarSeed } from '../profile/serialize.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run profiles.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pool = new Pool({ connectionString });

// Mirrors me.test.ts / courses.test.ts — each DB-touching file owns its
// migration bootstrap.
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

// ---------------------------------------------------------------------------
// Fixtures. Handles are globally unique, so every one is suffixed with a run
// id; nothing here touches another test file's rows.
// ---------------------------------------------------------------------------
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 12);
const SUBJECT_HANDLE = `p${RUN_ID}sub`;
const VISITOR_HANDLE = `p${RUN_ID}vis`;
const TEACHER_HANDLE = `p${RUN_ID}tea`;
const COURSE_SLUG = `profile-course-${RUN_ID}`;
const BADGE_SLUG = `profile-badge-${RUN_ID}`;
const SUBJECT_EMAIL = `subject-${RUN_ID}@example.test`;

let subject: Actor;
let visitor: Actor;
let teacher: Actor;
let courseId: string;
let lessonId: string;

async function setVisibility(userId: string, section: string, visibility: string): Promise<void> {
  await pool.query(
    `insert into profile_section_visibility (user_id, section, visibility)
     values ($1, $2, $3)
     on conflict (user_id, section) do update set visibility = excluded.visibility`,
    [userId, section, visibility],
  );
}

async function clearVisibility(userId: string): Promise<void> {
  await pool.query('delete from profile_section_visibility where user_id = $1', [userId]);
}

/** A server whose actor is fixed, the seam every other route test uses. */
async function serverFor(actor: Actor, extra: Record<string, unknown> = {}) {
  return buildServer({ actor, ...extra });
}

async function getProfile(actor: Actor, handle = SUBJECT_HANDLE) {
  const app = await serverFor(actor);
  try {
    return await app.inject({ method: 'GET', url: `/api/v1/profiles/${handle}` });
  } finally {
    await app.close();
  }
}

/** Every key anywhere in a payload, however deeply nested. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

describe('profile routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const insertUser = async (handle: string, email: string, name: string, role: string): Promise<Actor> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (handle, email, display_name, timezone, bio)
         values ($1, $2, $3, 'America/Denver', $4) returning id`,
        [handle, email, name, `Bio of ${name}`],
      );
      const id = rows[0]!.id;
      await pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, role]);
      return { id, roles: [role as 'student' | 'teacher'] };
    };

    subject = await insertUser(SUBJECT_HANDLE, SUBJECT_EMAIL, 'Subject Person', 'student');
    visitor = await insertUser(VISITOR_HANDLE, `visitor-${RUN_ID}@example.test`, 'Visitor Person', 'student');
    teacher = await insertUser(TEACHER_HANDLE, `teacher-${RUN_ID}@example.test`, 'Teacher Person', 'teacher');

    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, visibility) values ($1, $2, 'open') returning id`,
      [COURSE_SLUG, 'Profile Course'],
    );
    courseId = course.rows[0]!.id;

    const module = await pool.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, 'mod-a', 'Module A', 0) returning id`,
      [courseId],
    );
    const lesson = await pool.query<{ id: string }>(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, 'lesson-one', 'profile-lesson', 'Profile Lesson', 'lesson', 0, 'l.md', 'h1', '[]')
       returning id`,
      [courseId, module.rows[0]!.id],
    );
    lessonId = lesson.rows[0]!.id;

    await pool.query(`insert into enrollments (user_id, course_id, status) values ($1, $2, 'active')`, [
      subject.id,
      courseId,
    ]);
    await pool.query(
      `insert into lesson_progress (user_id, lesson_id, state) values ($1, $2, 'complete')
       on conflict (user_id, lesson_id) do update set state = 'complete'`,
      [subject.id, lessonId],
    );
    await pool.query(
      `insert into activity_events (user_id, type, course_id, lesson_id, occurred_at)
       values ($1, 'lesson_completed', $2, $3, now())`,
      [subject.id, courseId, lessonId],
    );

    const badge = await pool.query<{ id: string }>(
      `insert into badges (slug, title, description, source, criteria)
       values ($1, 'Profile Badge', 'Earned it', 'admin', $2::jsonb) returning id`,
      [BADGE_SLUG, JSON.stringify({ type: 'lessons_completed', count: 1 })],
    );
    await pool.query('insert into user_badges (user_id, badge_id) values ($1, $2)', [subject.id, badge.rows[0]!.id]);
  });

  afterAll(async () => {
    // Same reasoning as me.test.ts / progress.test.ts: `activity_events` is
    // append-only (migration 0004's trigger), so the fixture rows here — and
    // the users, courses and lessons they point at — cannot be deleted
    // without tripping it. Per-run handles and slugs are what keep repeated
    // runs from colliding instead. The visibility rows CAN go, and do: they
    // are the table this phase added and the one whose absence means
    // "private", so leaving stale ones behind would poison the next run.
    await pool.query('delete from profile_section_visibility where user_id = any($1::uuid[])', [
      [subject.id, visitor.id, teacher.id],
    ]);
    // closePool() ends the very pool setPool() was handed, so there is no
    // second pool.end() here — that would end it twice.
    await closePool();
  });

  // =========================================================================
  // The default: nothing has been opened, so nothing is shown.
  // =========================================================================
  describe('deny by default — a profile nobody configured', () => {
    beforeAll(async () => {
      await clearVisibility(subject.id);
    });

    it('shows a stranger the handle and no sections at all', async () => {
      const res = await getProfile(ANONYMOUS_ACTOR);
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.handle).toBe(SUBJECT_HANDLE);
      expect(body.viewer).toBe('anonymous');
      expect(body.sections).toEqual({});
    });

    it('shows another signed-in student nothing either — signed in is not a key', async () => {
      const res = await getProfile(visitor);
      expect(res.statusCode).toBe(200);
      expect(res.json().sections).toEqual({});
      expect(res.json().viewer).toBe('signed_in');
    });

    it('shows the owner everything, unconfigured or not', async () => {
      const res = await getProfile(subject);
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.viewer).toBe('owner');
      expect(Object.keys(body.sections).sort()).toEqual([
        'activity_feed',
        'activity_heatmap',
        'badges',
        'courses',
        'degrees',
      ]);
      // And their own settings, so the toggles can render.
      expect(body.visibility).toEqual({
        badges: 'private',
        degrees: 'private',
        courses: 'private',
        activity_feed: 'private',
        activity_heatmap: 'private',
      });
    });
  });

  // =========================================================================
  // The same profile, three viewers, three payloads.
  // =========================================================================
  describe('one profile, three viewers', () => {
    beforeAll(async () => {
      await clearVisibility(subject.id);
      await setVisibility(subject.id, 'badges', 'public');
      await setVisibility(subject.id, 'courses', 'signed_in');
      await setVisibility(subject.id, 'activity_feed', 'public');
      // degrees and activity_heatmap deliberately left with NO ROW at all.
    });

    it('an anonymous viewer gets only the public sections', async () => {
      const body = (await getProfile(ANONYMOUS_ACTOR)).json();
      expect(Object.keys(body.sections).sort()).toEqual(['activity_feed', 'badges']);
      expect(body.sections.badges[0].slug).toBe(BADGE_SLUG);
    });

    it('a signed-in viewer also gets the signed_in ones', async () => {
      const body = (await getProfile(visitor)).json();
      expect(Object.keys(body.sections).sort()).toEqual(['activity_feed', 'badges', 'courses']);
      expect(body.sections.courses.completed[0].slug).toBe(COURSE_SLUG);
    });

    it('the owner gets all five, including the ones with no row', async () => {
      const body = (await getProfile(subject)).json();
      expect(Object.keys(body.sections).sort()).toEqual([
        'activity_feed',
        'activity_heatmap',
        'badges',
        'courses',
        'degrees',
      ]);
    });

    it('a hidden section is ABSENT from the response body, not sent and hidden', async () => {
      const raw = (await getProfile(ANONYMOUS_ACTOR)).body;
      expect(raw).not.toContain('activity_heatmap');
      expect(raw).not.toContain('"courses"');
      expect(raw).not.toContain('inProgress');
      expect(raw).not.toContain('longestStreak');
    });

    it('never carries the email address, to any viewer', async () => {
      for (const actor of [ANONYMOUS_ACTOR, visitor, subject]) {
        const res = await getProfile(actor);
        expect(allKeys(res.json())).not.toContain('email');
        expect(res.body).not.toContain(SUBJECT_EMAIL);
        expect(res.body).not.toContain('@example.test');
      }
    });

    it('never carries the user id either — the identicon seed is a hash of it', async () => {
      const body = (await getProfile(ANONYMOUS_ACTOR)).json();
      expect(body.avatar).toEqual({ kind: 'identicon', seed: avatarSeed(subject.id) });
      expect((await getProfile(ANONYMOUS_ACTOR)).body).not.toContain(subject.id);
    });

    it('does not link an anonymous reader into lesson content (§12)', async () => {
      const anon = (await getProfile(ANONYMOUS_ACTOR)).json();
      expect(anon.sections.activity_feed[0].lesson).toEqual({ title: 'Profile Lesson' });

      const signedIn = (await getProfile(visitor)).json();
      expect(signedIn.sections.activity_feed[0].lesson).toEqual({ slug: 'profile-lesson', title: 'Profile Lesson' });
    });
  });

  // =========================================================================
  // Who has a profile at all.
  // =========================================================================
  describe('subjects', () => {
    it('404s an unknown handle', async () => {
      const res = await getProfile(ANONYMOUS_ACTOR, `nobody-${RUN_ID}`);
      expect(res.statusCode).toBe(404);
    });

    it('404s a malformed handle without touching the database', async () => {
      const res = await getProfile(ANONYMOUS_ACTOR, 'Not%20A%20Handle');
      expect(res.statusCode).toBe(404);
    });

    it('404s an account with no learner profile (§5.1: operators have none)', async () => {
      const res = await getProfile(ANONYMOUS_ACTOR, TEACHER_HANDLE);
      expect(res.statusCode).toBe(404);
      // The refusal is the same one an unknown handle gets: it does not
      // confirm that the handle is taken.
      expect(res.json().message).toBe((await getProfile(ANONYMOUS_ACTOR, `nobody-${RUN_ID}`)).json().message);
    });
  });

  // =========================================================================
  // §11: "The unauthenticated route is rate-limited."
  // =========================================================================
  describe('rate limiting (the §13 limiter, reused)', () => {
    it('429s with Retry-After once an address has had its allowance', async () => {
      const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 60_000, baseLockoutMs: 30_000 });
      const app = await buildServer({ actor: ANONYMOUS_ACTOR, profileRateLimiter: limiter });
      try {
        const url = `/api/v1/profiles/${SUBJECT_HANDLE}`;
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);

        const limited = await app.inject({ method: 'GET', url });
        expect(limited.statusCode).toBe(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    it('lets the address back in once the lockout is over, without compounding', async () => {
      // The defaults' shape, in miniature: the lockout is as long as the
      // window the counter is forgotten after. Nothing here ever calls
      // reset() — a page view is not a "success" the way a login is — so if
      // the lockout were the shorter of the two, every request that got
      // through afterwards would double the next one and an address that
      // once burst would never fully recover.
      let now = 1_000_000;
      const limiter = new LoginRateLimiter({
        maxAttempts: 2,
        windowMs: 10_000,
        baseLockoutMs: 10_000,
        maxLockoutMs: 10_000,
        now: () => now,
      });
      const app = await buildServer({ actor: ANONYMOUS_ACTOR, profileRateLimiter: limiter });
      const url = `/api/v1/profiles/${SUBJECT_HANDLE}`;
      try {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(429);

        now += 10_001;
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
        // And the slate really is clean: a full fresh allowance, not one
        // request before the next lockout.
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('counts a request that 404s too, so scanning for handles is limited as well', async () => {
      const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 60_000, baseLockoutMs: 30_000 });
      const app = await buildServer({ actor: ANONYMOUS_ACTOR, profileRateLimiter: limiter });
      try {
        expect((await app.inject({ method: 'GET', url: `/api/v1/profiles/nobody-${RUN_ID}` })).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: `/api/v1/profiles/${SUBJECT_HANDLE}` })).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // The owner's settings screen.
  // =========================================================================
  describe('GET /api/v1/me/profile', () => {
    it('refuses an anonymous caller', async () => {
      const app = await serverFor(ANONYMOUS_ACTOR);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/v1/me/profile' });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns the owner’s settings, with unset sections reading private', async () => {
      await clearVisibility(subject.id);
      await setVisibility(subject.id, 'badges', 'public');

      const app = await serverFor(subject);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/v1/me/profile' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.handle).toBe(SUBJECT_HANDLE);
        expect(body.noindex).toBe(true);
        expect(body.visibility.badges).toBe('public');
        expect(body.visibility.activity_heatmap).toBe('private');
        expect(allKeys(body)).not.toContain('email');
        // The same face the public page shows — one seed, two screens.
        expect(body.avatar).toEqual({ kind: 'identicon', seed: avatarSeed(subject.id) });
      } finally {
        await app.close();
      }
    });
  });

  describe('PATCH /api/v1/me/profile', () => {
    it('refuses an anonymous caller', async () => {
      const app = await serverFor(ANONYMOUS_ACTOR);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          payload: { noindex: false },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('sets sections, the noindex toggle, and the bio in one call', async () => {
      await clearVisibility(subject.id);
      const app = await serverFor(subject);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          payload: {
            bio: '  Learning things.  ',
            noindex: false,
            visibility: { badges: 'public', activity_heatmap: 'signed_in' },
          },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.bio).toBe('Learning things.');
        expect(body.noindex).toBe(false);
        expect(body.visibility).toEqual({
          badges: 'public',
          degrees: 'private',
          courses: 'private',
          activity_feed: 'private',
          activity_heatmap: 'signed_in',
        });
      } finally {
        await app.close();
      }

      const { rows } = await pool.query<{ section: string; visibility: string }>(
        'select section, visibility from profile_section_visibility where user_id = $1 order by section',
        [subject.id],
      );
      expect(rows).toEqual([
        { section: 'activity_heatmap', visibility: 'signed_in' },
        { section: 'badges', visibility: 'public' },
      ]);
    });

    it('leaves out what the request left out', async () => {
      const app = await serverFor(subject);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          payload: { visibility: { badges: 'private' } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().visibility.activity_heatmap).toBe('signed_in');
        expect(res.json().visibility.badges).toBe('private');
        expect(res.json().bio).toBe('Learning things.');
        expect(res.json().noindex).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('stores a blank bio as null rather than an empty string', async () => {
      const app = await serverFor(subject);
      try {
        const res = await app.inject({ method: 'PATCH', url: '/api/v1/me/profile', payload: { bio: '   ' } });
        expect(res.statusCode).toBe(200);
        expect(res.json().bio).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('refuses an unknown section, an unknown visibility, and an over-long bio — and writes nothing', async () => {
      const app = await serverFor(subject);
      try {
        for (const payload of [
          { visibility: { study_groups: 'public' } },
          { visibility: { badges: 'everyone' } },
          { visibility: { badges: 'PUBLIC' } },
          { noindex: 'yes' },
          { bio: 'x'.repeat(2001) },
        ]) {
          const res = await app.inject({ method: 'PATCH', url: '/api/v1/me/profile', payload });
          expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        }
      } finally {
        await app.close();
      }

      const { rows } = await pool.query<{ section: string }>(
        `select section from profile_section_visibility where user_id = $1 and section = 'study_groups'`,
        [subject.id],
      );
      expect(rows).toEqual([]);
    });

    it('cannot be used to change anybody else’s profile — there is no subject in the body', async () => {
      const app = await serverFor(visitor);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          payload: { userId: subject.id, handle: SUBJECT_HANDLE, visibility: { badges: 'public' } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().handle).toBe(VISITOR_HANDLE);
      } finally {
        await app.close();
      }

      const { rows } = await pool.query<{ visibility: string }>(
        `select visibility from profile_section_visibility where user_id = $1 and section = 'badges'`,
        [subject.id],
      );
      expect(rows[0]?.visibility).toBe('private');
    });

    it('refuses a teacher-only account: §5 gives the profile row to students', async () => {
      const app = await serverFor(teacher);
      try {
        const res = await app.inject({ method: 'PATCH', url: '/api/v1/me/profile', payload: { noindex: false } });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });
});
