import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run invites.test.ts');
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
const PREFIX = `inviteroute${RUN_ID}`;
const OWNED_SLUG = `${PREFIX}-owned`;
const OTHER_SLUG = `${PREFIX}-other`;

let counter = 0;
function next(): string {
  counter += 1;
  return `${PREFIX}${counter}`;
}

interface Person extends Actor {
  email: string;
}

async function makePerson(role: 'student' | 'teacher' | 'admin', budget = 0): Promise<Person> {
  const suffix = next();
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, email, handle, platform_invite_budget) values ($1, $2, $3, $4) returning id`,
    [`Invite Route ${suffix}`, `${suffix}@example.test`, suffix, budget],
  );
  const id = rows[0]!.id;
  await pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, role]);
  return { id, roles: [role], email: `${suffix}@example.test` };
}

let teacher: Person;
let otherTeacher: Person;
let admin: Person;
let student: Person;

interface InviteBody {
  id: string;
  kind: string;
  status: string;
  email: string;
  courseSlug: string | null;
  issuedByHandle: string | null;
  budgetConsumed: boolean;
  refunded: boolean;
  createsAccount: boolean;
}

interface IssuedBody {
  invite: InviteBody;
  token: string;
  acceptPath: string;
  remainingBudget: number;
}

async function budgetOf(userId: string): Promise<number> {
  const { rows } = await pool.query<{ platform_invite_budget: number }>(
    'select platform_invite_budget from users where id = $1',
    [userId],
  );
  return rows[0]!.platform_invite_budget;
}

async function setBudget(userId: string, budget: number): Promise<void> {
  await pool.query('update users set platform_invite_budget = $2 where id = $1', [userId, budget]);
}

async function issueAs(actor: Actor, payload: Record<string, unknown>) {
  const fastify = await buildServer({ actor });
  const response = await fastify.inject({ method: 'POST', url: '/api/v1/invites', payload });
  await fastify.close();
  return response;
}

describe('invitation routes (design §12)', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    teacher = await makePerson('teacher');
    otherTeacher = await makePerson('teacher', 5);
    admin = await makePerson('admin');
    student = await makePerson('student');

    await pool.query(`insert into courses (slug, title, visibility, owner_id) values ($1, $2, 'restricted', $3)`, [
      OWNED_SLUG,
      'A Course The Teacher Owns',
      teacher.id,
    ]);
    await pool.query(`insert into courses (slug, title, visibility, owner_id) values ($1, $2, 'restricted', $3)`, [
      OTHER_SLUG,
      'Someone Else’s Course',
      otherTeacher.id,
    ]);
  });

  beforeEach(async () => {
    await pool.query('delete from invites where email like $1', [`${PREFIX}%`]);
    await setBudget(teacher.id, 0);
  });

  afterAll(async () => {
    await pool.query('delete from enrollments where course_id in (select id from courses where slug like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from invites where email like $1', [`${PREFIX}%`]);
    await pool.query('delete from courses where slug like $1', [`${PREFIX}%`]);
    await pool.query('delete from user_roles where user_id in (select id from users where handle like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from users where handle like $1', [`${PREFIX}%`]);
    await closePool();
  });

  describe('POST /api/v1/invites — the two scopes', () => {
    it('refuses a teacher whose platform-invite budget is 0 (§12: granted deliberately, not assumed)', async () => {
      const response = await issueAs(teacher, { kind: 'platform', email: `${next()}@example.test` });
      expect(response.statusCode).toBe(403);
      expect(await budgetOf(teacher.id)).toBe(0);
    });

    it('lets a teacher with budget issue a platform invite, and CHARGES IT ON ISSUE', async () => {
      await setBudget(teacher.id, 2);
      const email = `${next()}@example.test`;
      const response = await issueAs(teacher, { kind: 'platform', email });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload) as IssuedBody;
      expect(body.invite.kind).toBe('platform');
      expect(body.invite.status).toBe('pending');
      expect(body.invite.budgetConsumed).toBe(true);
      expect(body.token.length).toBeGreaterThan(20);
      expect(body.acceptPath).toBe(`/invite/${body.token}`);
      expect(body.remainingBudget).toBe(1);
      // Nothing has been accepted, and the unit is already gone.
      expect(await budgetOf(teacher.id)).toBe(1);
    });

    it('does not charge an admin (§12: unlimited)', async () => {
      const response = await issueAs(admin, { kind: 'platform', email: `${next()}@example.test` });
      expect(response.statusCode).toBe(201);
      expect(await budgetOf(admin.id)).toBe(0);
      expect((JSON.parse(response.payload) as IssuedBody).invite.budgetConsumed).toBe(false);
    });

    it('REFUSES A TEACHER INVITING TO A COURSE THEY DO NOT OWN', async () => {
      await setBudget(teacher.id, 5);
      const response = await issueAs(teacher, {
        kind: 'course',
        courseSlug: OTHER_SLUG,
        email: `${next()}@example.test`,
      });
      expect(response.statusCode).toBe(403);
      expect(await budgetOf(teacher.id)).toBe(5);
    });

    it('lets a teacher invite to their own course', async () => {
      await setBudget(teacher.id, 1);
      const response = await issueAs(teacher, {
        kind: 'course',
        courseSlug: OWNED_SLUG,
        email: `${next()}@example.test`,
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload) as IssuedBody;
      expect(body.invite.courseSlug).toBe(OWNED_SLUG);
      // The invitee has no account, so this invite creates one — and account
      // creation is what the budget is for, whichever screen it came from.
      expect(body.invite.createsAccount).toBe(true);
      expect(body.invite.budgetConsumed).toBe(true);
      expect(await budgetOf(teacher.id)).toBe(0);
    });

    it('refuses a course invite to a NEW address when the budget is 0 — the budget is about creating accounts', async () => {
      const response = await issueAs(teacher, {
        kind: 'course',
        courseSlug: OWNED_SLUG,
        email: `${next()}@example.test`,
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).message).toContain('budget');
    });

    it('allows a course invite to an EXISTING account with no budget at all', async () => {
      const response = await issueAs(teacher, { kind: 'course', courseSlug: OWNED_SLUG, email: student.email });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload) as IssuedBody;
      expect(body.invite.createsAccount).toBe(false);
      expect(body.invite.budgetConsumed).toBe(false);
      expect(await budgetOf(teacher.id)).toBe(0);
    });

    it('refuses a platform invite to an address that already has an account', async () => {
      await setBudget(teacher.id, 3);
      const response = await issueAs(teacher, { kind: 'platform', email: student.email });
      expect(response.statusCode).toBe(409);
      expect(await budgetOf(teacher.id)).toBe(3);
    });

    it('refuses a student and an anonymous visitor', async () => {
      expect((await issueAs(student, { kind: 'platform', email: `${next()}@example.test` })).statusCode).toBe(403);
      expect(
        (await issueAs(ANONYMOUS_ACTOR, { kind: 'platform', email: `${next()}@example.test` })).statusCode,
      ).toBe(403);
    });

    it('validates the body before touching anything', async () => {
      await setBudget(teacher.id, 5);
      expect((await issueAs(teacher, { kind: 'nonsense', email: 'a@b.test' })).statusCode).toBe(400);
      expect((await issueAs(teacher, { kind: 'platform', email: 'not-an-email' })).statusCode).toBe(400);
      expect((await issueAs(teacher, { kind: 'course', email: 'a@b.test' })).statusCode).toBe(400);
      expect(
        (await issueAs(teacher, { kind: 'platform', email: 'a@b.test', courseSlug: OWNED_SLUG })).statusCode,
      ).toBe(400);
      expect(
        (await issueAs(teacher, { kind: 'platform', email: `${next()}@example.test`, expiresInDays: 400 })).statusCode,
      ).toBe(400);
      expect((await issueAs(teacher, { kind: 'course', courseSlug: 'no-such-course', email: 'a@b.test' })).statusCode).toBe(
        404,
      );
      expect(await budgetOf(teacher.id)).toBe(5);
    });

    it('writes invite.issued to the audit log', async () => {
      await setBudget(teacher.id, 1);
      const email = `${next()}@example.test`;
      const issued = await issueAs(teacher, { kind: 'platform', email });
      const inviteId = (JSON.parse(issued.payload) as IssuedBody).invite.id;

      const { rows } = await pool.query<{ action: string; meta: Record<string, unknown> }>(
        'select action, meta from audit_log where target = $1',
        [inviteId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('invite.issued');
      expect(rows[0]!.meta.email).toBe(email);
    });
  });

  describe('GET /api/v1/invites', () => {
    it('shows an admin every invite with its issuer, and a teacher only their own', async () => {
      await setBudget(teacher.id, 1);
      const mine = await issueAs(teacher, { kind: 'platform', email: `${next()}@example.test` });
      const theirs = await issueAs(otherTeacher, { kind: 'platform', email: `${next()}@example.test` });
      const mineId = (JSON.parse(mine.payload) as IssuedBody).invite.id;
      const theirsId = (JSON.parse(theirs.payload) as IssuedBody).invite.id;

      const asAdmin = await buildServer({ actor: admin });
      const adminView = await asAdmin.inject({ method: 'GET', url: '/api/v1/invites?limit=200' });
      await asAdmin.close();
      expect(adminView.statusCode).toBe(200);
      const all = JSON.parse(adminView.payload) as InviteBody[];
      const ids = all.map((i) => i.id);
      expect(ids).toContain(mineId);
      expect(ids).toContain(theirsId);
      // §12: "listing every invite with issuer and status".
      expect(all.find((i) => i.id === mineId)!.issuedByHandle).not.toBeNull();

      const asTeacher = await buildServer({ actor: teacher });
      const teacherView = await asTeacher.inject({ method: 'GET', url: '/api/v1/invites?limit=200' });
      await asTeacher.close();
      const own = JSON.parse(teacherView.payload) as InviteBody[];
      expect(own.map((i) => i.id)).toContain(mineId);
      expect(own.map((i) => i.id)).not.toContain(theirsId);
      // No listing anywhere carries the token.
      expect(teacherView.payload).not.toContain('acceptPath');
    });

    it('refuses a student and an anonymous visitor', async () => {
      for (const actor of [student, ANONYMOUS_ACTOR]) {
        const fastify = await buildServer({ actor });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/invites' });
        await fastify.close();
        expect(response.statusCode).toBe(403);
      }
    });

    it('reports an expired invite as expired, and refunds it in passing', async () => {
      await setBudget(teacher.id, 1);
      const issued = await issueAs(teacher, { kind: 'platform', email: `${next()}@example.test` });
      const inviteId = (JSON.parse(issued.payload) as IssuedBody).invite.id;
      await pool.query(`update invites set expires_at = now() - interval '1 second' where id = $1`, [inviteId]);
      expect(await budgetOf(teacher.id)).toBe(0);

      const fastify = await buildServer({ actor: teacher });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/invites' });
      await fastify.close();

      const list = JSON.parse(response.payload) as InviteBody[];
      const row = list.find((i) => i.id === inviteId)!;
      expect(row.status).toBe('expired');
      expect(row.refunded).toBe(true);
      expect(await budgetOf(teacher.id)).toBe(1);
    });
  });

  describe('POST /api/v1/invites/:id/revoke', () => {
    it('revokes and refunds, and refuses a second revocation', async () => {
      await setBudget(teacher.id, 1);
      const issued = await issueAs(teacher, { kind: 'platform', email: `${next()}@example.test` });
      const inviteId = (JSON.parse(issued.payload) as IssuedBody).invite.id;

      const fastify = await buildServer({ actor: teacher });
      const response = await fastify.inject({ method: 'POST', url: `/api/v1/invites/${inviteId}/revoke` });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { invite: InviteBody; refunded: boolean };
      expect(body.invite.status).toBe('revoked');
      expect(body.refunded).toBe(true);
      expect(await budgetOf(teacher.id)).toBe(1);

      const again = await fastify.inject({ method: 'POST', url: `/api/v1/invites/${inviteId}/revoke` });
      await fastify.close();
      expect(again.statusCode).toBe(409);
      expect(await budgetOf(teacher.id)).toBe(1);

      const audit = await pool.query('select 1 from audit_log where target = $1 and action = $2', [
        inviteId,
        'invite.revoked',
      ]);
      expect(audit.rowCount).toBe(1);
    });

    it('refuses a teacher revoking someone else’s invite, and allows an admin', async () => {
      const issued = await issueAs(otherTeacher, { kind: 'platform', email: `${next()}@example.test` });
      const inviteId = (JSON.parse(issued.payload) as IssuedBody).invite.id;

      const asTeacher = await buildServer({ actor: teacher });
      const denied = await asTeacher.inject({ method: 'POST', url: `/api/v1/invites/${inviteId}/revoke` });
      await asTeacher.close();
      expect(denied.statusCode).toBe(409);

      const asAdmin = await buildServer({ actor: admin });
      const allowed = await asAdmin.inject({ method: 'POST', url: `/api/v1/invites/${inviteId}/revoke` });
      await asAdmin.close();
      expect(allowed.statusCode).toBe(200);
    });
  });

  describe('the accept flow', () => {
    async function issueCourseInvite(): Promise<IssuedBody> {
      await setBudget(teacher.id, 1);
      const issued = await issueAs(teacher, {
        kind: 'course',
        courseSlug: OWNED_SLUG,
        email: `${next()}@example.test`,
      });
      expect(issued.statusCode).toBe(201);
      return JSON.parse(issued.payload) as IssuedBody;
    }

    it('previews a link without a session, and 410s a revoked one', async () => {
      const issued = await issueCourseInvite();

      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });
      // The token travels in a HEADER, not the query string: Fastify logs
      // `req.url`, so `?token=` put a live invite token into the container
      // log in plaintext (api/src/log-redaction.ts).
      const preview = await anonymous.inject({
        method: 'GET',
        url: '/api/v1/invites/lookup',
        headers: { 'x-invite-token': issued.token },
      });
      expect(preview.statusCode).toBe(200);
      const body = JSON.parse(preview.payload) as { courseSlug: string; needsAccount: boolean; email: string };
      expect(body.courseSlug).toBe(OWNED_SLUG);
      expect(body.needsAccount).toBe(true);
      expect(body.email).toBe(issued.invite.email);

      await pool.query('update invites set revoked_at = now() where id = $1', [issued.invite.id]);
      const gone = await anonymous.inject({
        method: 'GET',
        url: '/api/v1/invites/lookup',
        headers: { 'x-invite-token': issued.token },
      });
      await anonymous.close();
      expect(gone.statusCode).toBe(410);
    });


    it('refuses a lookup with no X-Invite-Token header', async () => {
      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });
      const response = await anonymous.inject({ method: 'GET', url: '/api/v1/invites/lookup' });
      await anonymous.close();
      expect(response.statusCode).toBe(400);
    });

    it('IGNORES a token in the query string — the old spelling must not still work', async () => {
      // The whole point of the move is that a token never appears in a URL.
      // If the query parameter kept working, every existing caller would keep
      // leaking it into the log and nothing would have been fixed.
      const issued = await issueCourseInvite();
      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });
      const response = await anonymous.inject({
        method: 'GET',
        url: `/api/v1/invites/lookup?token=${encodeURIComponent(issued.token)}`,
      });
      await anonymous.close();
      expect(response.statusCode).toBe(400);
    });

    it('cannot be smuggled a valid token by REPEATING the header', async () => {
      // Node joins a repeated header into "a,b" rather than handing over an
      // array, so the value hashes to nothing and dies as an unusable token.
      // Asserted because the alternative — a parser that picked the first
      // value — would make the header a place to hide one.
      const issued = await issueCourseInvite();
      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });
      const response = await anonymous.inject({
        method: 'GET',
        url: '/api/v1/invites/lookup',
        headers: { 'x-invite-token': [issued.token, 'decoy'] as unknown as string },
      });
      await anonymous.close();
      expect(response.statusCode).toBe(410);
    });

    it('REGISTERS AND ENROLS IN ONE STEP, then refuses the spent link', async () => {
      const issued = await issueCourseInvite();
      const handle = next();

      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });
      const accepted = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: {
          token: issued.token,
          handle,
          password: 'a-perfectly-fine-password',
          displayName: 'Invited Learner',
        },
      });
      expect(accepted.statusCode).toBe(201);
      const body = JSON.parse(accepted.payload) as {
        user: { id: string; email: string; handle: string; roles: string[] };
        courseSlug: string;
        enrolled: boolean;
      };
      expect(body.user.email).toBe(issued.invite.email);
      expect(body.user.roles).toEqual(['student']);
      expect(body.courseSlug).toBe(OWNED_SLUG);
      expect(body.enrolled).toBe(true);

      const enrolment = await pool.query<{ status: string }>(
        `select e.status from enrollments e join courses c on c.id = e.course_id
          where e.user_id = $1 and c.slug = $2`,
        [body.user.id, OWNED_SLUG],
      );
      expect(enrolment.rows[0]!.status).toBe('active');

      // The account can actually sign in: the real Argon2id hasher is wired
      // into this route, not left as a seam that stores NULL.
      const login = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: issued.invite.email, password: 'a-perfectly-fine-password' },
      });
      expect(login.statusCode).toBe(200);

      const replay = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: issued.token, handle: next(), password: 'a-perfectly-fine-password' },
      });
      await anonymous.close();
      expect(replay.statusCode).toBe(410);
    });

    it('refuses a bad body without consuming the invite', async () => {
      const issued = await issueCourseInvite();
      const anonymous = await buildServer({ actor: ANONYMOUS_ACTOR });

      const short = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: issued.token, handle: next(), password: 'short' },
      });
      expect(short.statusCode).toBe(400);

      const reserved = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: issued.token, handle: 'admin', password: 'a-perfectly-fine-password' },
      });
      expect(reserved.statusCode).toBe(400);

      const missing = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: issued.token, handle: next() },
      });
      expect(missing.statusCode).toBe(400);

      const wrongToken = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: 'nope', handle: next(), password: 'a-perfectly-fine-password' },
      });
      expect(wrongToken.statusCode).toBe(410);

      // Still usable.
      const ok = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token: issued.token, handle: next(), password: 'a-perfectly-fine-password' },
      });
      await anonymous.close();
      expect(ok.statusCode).toBe(201);
    });

    it('enrols an EXISTING account only when signed in as it', async () => {
      const issued = await issueAs(teacher, { kind: 'course', courseSlug: OWNED_SLUG, email: student.email });
      expect(issued.statusCode).toBe(201);
      const token = (JSON.parse(issued.payload) as IssuedBody).token;

      const asStranger = await buildServer({ actor: otherTeacher });
      const refused = await asStranger.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        payload: { token },
      });
      await asStranger.close();
      expect(refused.statusCode).toBe(409);

      const asInvitee = await buildServer({ actor: student });
      const accepted = await asInvitee.inject({ method: 'POST', url: '/api/v1/invites/accept', payload: { token } });
      await asInvitee.close();
      expect(accepted.statusCode).toBe(201);
      const body = JSON.parse(accepted.payload) as { user: { id: string }; enrolled: boolean };
      expect(body.user.id).toBe(student.id);
      expect(body.enrolled).toBe(true);
    });
  });
});
