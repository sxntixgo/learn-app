import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  throw new Error('TEST_DATABASE_URL is not set — required to run admin-people.test.ts');
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
const PREFIX = `adminpeople${RUN_ID}`;

let counter = 0;
function next(): string {
  counter += 1;
  return `${PREFIX}${counter}`;
}

async function makePerson(role: 'student' | 'teacher' | 'admin' | null): Promise<Actor> {
  const suffix = next();
  const { rows } = await pool.query<{ id: string }>(
    'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
    [`Admin People ${suffix}`, `${suffix}@example.test`, suffix],
  );
  const id = rows[0]!.id;
  if (role) await pool.query('insert into user_roles (user_id, role) values ($1, $2)', [id, role]);
  return { id, roles: role ? [role] : [] };
}

interface AdminUserBody {
  id: string;
  handle: string | null;
  roles: string[];
  inviteBudget: number;
}

interface AuditBody {
  action: string;
  actorId: string | null;
  actorHandle: string | null;
  target: string | null;
  meta: Record<string, unknown>;
}

let admin: Actor;
let teacher: Actor;
let student: Actor;
let subject: Actor;

async function as(actor: Actor, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  const fastify = await buildServer({ actor });
  const response = await fastify.inject(payload === undefined ? { method, url } : { method, url, payload });
  await fastify.close();
  return response;
}

describe('administration routes (design §5, §5.1, §12)', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);
    admin = await makePerson('admin');
    teacher = await makePerson('teacher');
    student = await makePerson('student');
    subject = await makePerson(null);
  });

  afterAll(async () => {
    await pool.query('delete from user_roles where user_id in (select id from users where handle like $1)', [
      `${PREFIX}%`,
    ]);
    await pool.query('delete from users where handle like $1', [`${PREFIX}%`]);
    await closePool();
  });

  describe('GET /api/v1/admin/users', () => {
    it('lists accounts with their roles and budgets for an admin only', async () => {
      const response = await as(admin, 'GET', '/api/v1/admin/users?limit=200');
      expect(response.statusCode).toBe(200);
      const users = JSON.parse(response.payload) as AdminUserBody[];
      const found = users.find((u) => u.id === teacher.id)!;
      expect(found.roles).toEqual(['teacher']);
      expect(found.inviteBudget).toBe(0);

      for (const actor of [teacher, student, ANONYMOUS_ACTOR]) {
        expect((await as(actor, 'GET', '/api/v1/admin/users')).statusCode).toBe(403);
      }
    });
  });

  describe('POST /api/v1/admin/users/:id/roles', () => {
    it('grants and revokes a role, and writes role.assigned to the audit log', async () => {
      const granted = await as(admin, 'POST', `/api/v1/admin/users/${subject.id}/roles`, {
        role: 'teacher',
        granted: true,
      });
      expect(granted.statusCode).toBe(200);
      expect((JSON.parse(granted.payload) as AdminUserBody).roles).toEqual(['teacher']);

      const revoked = await as(admin, 'POST', `/api/v1/admin/users/${subject.id}/roles`, {
        role: 'teacher',
        granted: false,
      });
      expect(revoked.statusCode).toBe(200);
      expect((JSON.parse(revoked.payload) as AdminUserBody).roles).toEqual([]);

      const { rows } = await pool.query<{ action: string; meta: Record<string, unknown> }>(
        'select action, meta from audit_log where target = $1 and action = $2 order by occurred_at',
        [subject.id, 'role.assigned'],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.meta).toMatchObject({ role: 'teacher', granted: true });
      expect(rows[1]!.meta).toMatchObject({ role: 'teacher', granted: false });
    });

    it('refuses to make one account both an operator and a learner (§5.1)', async () => {
      const response = await as(admin, 'POST', `/api/v1/admin/users/${student.id}/roles`, {
        role: 'admin',
        granted: true,
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.payload).message).toContain('exclusive');

      const { rows } = await pool.query<{ role: string }>('select role from user_roles where user_id = $1', [
        student.id,
      ]);
      expect(rows.map((r) => r.role)).toEqual(['student']);
    });

    it('validates the body and the target, and refuses everyone but an admin', async () => {
      expect(
        (await as(admin, 'POST', `/api/v1/admin/users/${subject.id}/roles`, { role: 'wizard', granted: true }))
          .statusCode,
      ).toBe(400);
      expect(
        (await as(admin, 'POST', `/api/v1/admin/users/${subject.id}/roles`, { role: 'teacher' })).statusCode,
      ).toBe(400);
      expect(
        (
          await as(admin, 'POST', '/api/v1/admin/users/00000000-0000-0000-0000-0000000000ff/roles', {
            role: 'teacher',
            granted: true,
          })
        ).statusCode,
      ).toBe(404);

      for (const actor of [teacher, student, ANONYMOUS_ACTOR]) {
        const response = await as(actor, 'POST', `/api/v1/admin/users/${subject.id}/roles`, {
          role: 'admin',
          granted: true,
        });
        expect(response.statusCode).toBe(403);
      }
      const { rowCount } = await pool.query('select 1 from user_roles where user_id = $1', [subject.id]);
      expect(rowCount).toBe(0);
    });
  });

  describe('POST /api/v1/admin/users/:id/invite-budget', () => {
    it('sets an absolute budget and records the previous one', async () => {
      const first = await as(admin, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: 5 });
      expect(first.statusCode).toBe(200);
      expect((JSON.parse(first.payload) as AdminUserBody).inviteBudget).toBe(5);

      const second = await as(admin, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: 2 });
      expect((JSON.parse(second.payload) as AdminUserBody).inviteBudget).toBe(2);

      const { rows } = await pool.query<{ meta: Record<string, unknown> }>(
        'select meta from audit_log where target = $1 and action = $2 order by occurred_at',
        [teacher.id, 'invite.budget_granted'],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.meta).toMatchObject({ previousBudget: 0, budget: 5 });
      expect(rows[1]!.meta).toMatchObject({ previousBudget: 5, budget: 2 });
    });

    it('refuses a nonsense budget and every non-admin', async () => {
      expect(
        (await as(admin, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: -1 })).statusCode,
      ).toBe(400);
      expect(
        (await as(admin, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: 1.5 })).statusCode,
      ).toBe(400);
      expect(
        (await as(admin, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: 100000 })).statusCode,
      ).toBe(400);

      for (const actor of [teacher, student, ANONYMOUS_ACTOR]) {
        expect(
          (await as(actor, 'POST', `/api/v1/admin/users/${teacher.id}/invite-budget`, { budget: 99 })).statusCode,
        ).toBe(403);
      }
      const { rows } = await pool.query<{ platform_invite_budget: number }>(
        'select platform_invite_budget from users where id = $1',
        [teacher.id],
      );
      expect(rows[0]!.platform_invite_budget).toBe(2);
    });
  });

  describe('GET /api/v1/admin/audit', () => {
    it('shows privileged actions to an admin and to nobody else', async () => {
      const response = await as(admin, 'GET', '/api/v1/admin/audit?limit=200');
      expect(response.statusCode).toBe(200);
      const entries = JSON.parse(response.payload) as AuditBody[];
      const mine = entries.filter((e) => e.target === teacher.id || e.target === subject.id);
      expect(mine.map((e) => e.action)).toEqual(
        expect.arrayContaining(['role.assigned', 'invite.budget_granted']),
      );
      expect(mine[0]!.actorHandle).not.toBeNull();

      for (const actor of [teacher, student, ANONYMOUS_ACTOR]) {
        expect((await as(actor, 'GET', '/api/v1/admin/audit')).statusCode).toBe(403);
      }
    });

    it('filters by action', async () => {
      const response = await as(admin, 'GET', '/api/v1/admin/audit?action=invite.budget_granted&limit=200');
      const entries = JSON.parse(response.payload) as AuditBody[];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.action === 'invite.budget_granted')).toBe(true);
    });

    it('cannot be edited or erased — the table is append-only by trigger', async () => {
      await expect(pool.query('update audit_log set action = $1 where target = $2', ['tampered', teacher.id])).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query('delete from audit_log where target = $1', [teacher.id])).rejects.toThrow(/append-only/);
    });
  });
});
