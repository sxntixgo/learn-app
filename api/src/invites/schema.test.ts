import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run schema.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Each DB-touching test file owns its migration bootstrap — see
// api/src/auth/identity-schema.test.ts, which this mirrors.
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
const PREFIX = `inviteschema${RUN_ID}`;

let counter = 0;

async function makeUser(): Promise<string> {
  counter += 1;
  const suffix = `${PREFIX}${counter}`;
  const { rows } = await pool.query<{ id: string }>(
    'insert into users (display_name, email, handle) values ($1, $2, $3) returning id',
    [`Invite Schema Test ${suffix}`, `${suffix}@example.test`, suffix],
  );
  return rows[0]!.id;
}

async function expectPgError(fn: () => Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await fn();
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error('expected the database to reject this statement, but it succeeded');
}

async function insertInvite(
  issuedBy: string,
  overrides: {
    budgetConsumed?: boolean;
    acceptedAt?: Date | null;
    revokedAt?: Date | null;
    createsAccount?: boolean;
  } = {},
): Promise<string> {
  counter += 1;
  const budgetConsumed = overrides.budgetConsumed ?? false;
  // `invites_budget_only_for_new_accounts` enforces that budget is only ever
  // spent on an invite that creates an account, so a fixture consuming budget
  // must say so. Defaulting this to `budgetConsumed` keeps every existing call
  // site honest without letting a test construct a state the schema forbids.
  const createsAccount = overrides.createsAccount ?? budgetConsumed;
  const { rows } = await pool.query<{ id: string }>(
    `insert into invites (kind, issued_by, email, token_hash, expires_at, budget_consumed, accepted_at, revoked_at, creates_account)
     values ('platform', $1, $2, $3, now() + interval '7 days', $4, $5, $6, $7)
     returning id`,
    [
      issuedBy,
      `${PREFIX}${counter}@example.test`,
      `${PREFIX}-hash-${counter}`,
      budgetConsumed,
      overrides.acceptedAt ?? null,
      overrides.revokedAt ?? null,
      createsAccount,
    ],
  );
  return rows[0]!.id;
}

describe('invite budget schema (migration 0015)', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await pool.query('delete from invites where email like $1', [`${PREFIX}%`]);
    await pool.query('delete from users where handle like $1', [`${PREFIX}%`]);
    await pool.end();
  });

  it('gives every new account a platform-invite budget of 0 (§12: granted deliberately, not assumed)', async () => {
    const id = await makeUser();
    const { rows } = await pool.query<{ platform_invite_budget: number }>(
      'select platform_invite_budget from users where id = $1',
      [id],
    );
    expect(rows[0]!.platform_invite_budget).toBe(0);
  });

  it('refuses a negative budget in the database, not merely in the decrementing UPDATE', async () => {
    const id = await makeUser();
    const err = await expectPgError(() =>
      pool.query('update users set platform_invite_budget = -1 where id = $1', [id]),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('users_platform_invite_budget_non_negative');
  });

  it('refuses an invite that is both accepted and revoked — one terminal state, ever', async () => {
    const issuer = await makeUser();
    const err = await expectPgError(() =>
      insertInvite(issuer, { acceptedAt: new Date(), revokedAt: new Date() }),
    );
    expect(err.constraint).toBe('invites_one_terminal_state');
  });

  it('refuses a refund on an invite that never consumed budget', async () => {
    const issuer = await makeUser();
    const id = await insertInvite(issuer, { budgetConsumed: false });
    const err = await expectPgError(() => pool.query('update invites set refunded_at = now() where id = $1', [id]));
    expect(err.constraint).toBe('invites_refund_requires_consumption');
  });

  it('refuses a refund on an ACCEPTED invite — the unit bought an account', async () => {
    const issuer = await makeUser();
    const id = await insertInvite(issuer, { budgetConsumed: true, acceptedAt: new Date() });
    const err = await expectPgError(() => pool.query('update invites set refunded_at = now() where id = $1', [id]));
    expect(err.constraint).toBe('invites_refund_requires_consumption');
  });

  it('allows a refund on a revoked invite that did consume budget', async () => {
    const issuer = await makeUser();
    const id = await insertInvite(issuer, { budgetConsumed: true, revokedAt: new Date() });
    const updated = await pool.query('update invites set refunded_at = now() where id = $1', [id]);
    expect(updated.rowCount).toBe(1);
  });
});
