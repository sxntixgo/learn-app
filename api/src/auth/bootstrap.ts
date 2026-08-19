import type pg from 'pg';
import { isValidTimeZone } from '../time/timezone.ts';
import { hashSetupToken } from './setup-token.ts';
import {
  EMAIL_PATTERN,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  parseHandle,
  parsePassword,
} from './account-fields.ts';

// First-run bootstrap (design §5.2).
//
// "The first account created on the instance becomes the admin. No admin
// credentials in env, no seeded account." Two properties make that safe, and
// both live in this file:
//
//   1. The claim is ATOMIC. A single UPDATE of the one instance_state row
//      `where bootstrapped_at is null`, inside the same transaction that
//      creates the accounts. Only the transaction whose UPDATE actually
//      matched a row may create the admin; every other caller loses.
//   2. The claim is GATED by the setup token, so an instance that is briefly
//      reachable is not claimable by whoever finds the URL first.
//
// And design §5.1's consequence: because admin is exclusive, a lone first
// account would be an operator who cannot learn anything. So the bootstrap
// creates a LINKED PAIR — the operator account and a student account, in one
// transaction, with `users.operator_for` joining them.

/** Roles are a set (design §5); the bootstrap grants exactly these. */
const ADMIN_ROLE = 'admin';
const STUDENT_ROLE = 'student';

// The field rules live in auth/account-fields.ts: the bootstrap and an
// invited registration (invites/accept.ts) hold a new account to exactly the
// same shape, and a second copy of these constants would be the way that
// stops being true.

/** Hashes a password for storage. Argon2id (design §13) is wired in separately. */
export type HashPassword = (plaintext: string) => Promise<string>;

export interface BootstrapDeps {
  /**
   * The Argon2id seam. When absent, accounts are created with
   * `password_hash = NULL`, which means "no credential" — nothing can
   * authenticate as them. Password hashing and login are a separate Phase 6
   * task; this bootstrap deliberately does not invent its own scheme in the
   * meantime, because a placeholder hash is far more dangerous than a null.
   */
  hashPassword?: HashPassword;
}

export interface AccountInput {
  email: string;
  handle: string;
  password: string;
  displayName: string | null;
}

export interface BootstrapRequest {
  setupToken: string;
  admin: AccountInput;
  student: AccountInput;
  timezone: string | null;
}

export interface CreatedAccount {
  id: string;
  email: string;
  handle: string;
  displayName: string | null;
  roles: string[];
}

export type BootstrapFailureReason =
  /** 400 — the request never got as far as the claim. */
  | 'invalid'
  /** 401 — wrong or absent setup token. The claim is NOT consumed. */
  | 'unauthorized'
  /** 409 — the instance was unclaimed when this request arrived, and someone else won the race. */
  | 'conflict'
  /** 410 — the instance was already claimed before this request arrived. Permanent. */
  | 'gone';

export type BootstrapResult =
  | { ok: true; admin: CreatedAccount; student: CreatedAccount }
  | { ok: false; reason: BootstrapFailureReason; message: string };

type ParseResult = { ok: true; value: BootstrapRequest } | { ok: false; message: string };

function invalid(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function parseAccount(raw: unknown, label: string): { ok: true; value: AccountInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid(`${label} is required and must be an object with email, handle and password.`);
  }
  const account = raw as Record<string, unknown>;

  const rawEmail = account.email;
  if (typeof rawEmail !== 'string') return invalid(`${label}.email is required.`);
  const email = rawEmail.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return invalid(`${label}.email is not a valid email address.`);
  }

  // Normalized, then validated against the same shape the database enforces
  // (db/migrations/0005: users_handle_url_safe).
  const parsedHandle = parseHandle(label, account.handle);
  if (!parsedHandle.ok) return invalid(parsedHandle.message);
  const handle = parsedHandle.value;

  const parsedPassword = parsePassword(label, account.password);
  if (!parsedPassword.ok) return invalid(parsedPassword.message);
  const password = parsedPassword.value;

  const rawDisplayName = account.displayName;
  if (rawDisplayName !== undefined && rawDisplayName !== null && typeof rawDisplayName !== 'string') {
    return invalid(`${label}.displayName must be a string when provided.`);
  }
  const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim() : '';
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return invalid(`${label}.displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }

  return { ok: true, value: { email, handle, password, displayName: displayName === '' ? null : displayName } };
}

/**
 * Validates and normalizes a setup request body.
 *
 * Everything here happens BEFORE the claim: a malformed wizard submission
 * must not consume the one-time claim on the instance.
 */
export function parseBootstrapRequest(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('A JSON object body is required.');
  }
  const raw = body as Record<string, unknown>;

  const setupToken = raw.setupToken;
  if (typeof setupToken !== 'string' || setupToken.trim() === '') {
    return invalid('setupToken is required.');
  }

  const admin = parseAccount(raw.admin, 'admin');
  if (!admin.ok) return admin;
  const student = parseAccount(raw.student, 'student');
  if (!student.ok) return student;

  if (admin.value.email === student.value.email) {
    return invalid('The operator and student accounts must use different email addresses.');
  }
  if (admin.value.handle === student.value.handle) {
    return invalid('The operator and student accounts must use different handles.');
  }

  const rawTimezone = raw.timezone;
  if (rawTimezone !== undefined && rawTimezone !== null && !isValidTimeZone(rawTimezone)) {
    return invalid(
      `Invalid timezone: ${JSON.stringify(rawTimezone)}. Must be a real IANA time zone name (e.g. "America/Denver").`,
    );
  }

  return {
    ok: true,
    value: {
      setupToken: setupToken.trim(),
      admin: admin.value,
      student: student.value,
      timezone: isValidTimeZone(rawTimezone) ? rawTimezone : null,
    },
  };
}

interface InsertedUser {
  id: string;
  email: string;
  handle: string;
  display_name: string | null;
}

async function insertUser(
  client: pg.PoolClient,
  account: AccountInput,
  passwordHash: string | null,
  timezone: string | null,
  operatorFor: string | null,
): Promise<InsertedUser> {
  const { rows } = await client.query<InsertedUser>(
    `insert into users (email, handle, password_hash, display_name, timezone, operator_for)
     values ($1, $2, $3, $4, $5, $6)
     returning id, email, handle, display_name`,
    [account.email, account.handle, passwordHash, account.displayName, timezone, operatorFor],
  );
  return rows[0]!;
}

/**
 * Claims the instance and creates the operator + student pair, atomically.
 *
 * The whole thing is one transaction. Either the instance is marked
 * bootstrapped AND both accounts exist with their roles and their link, or
 * nothing happened at all — in particular a failure partway through releases
 * the claim rather than burning it, so a fumbled wizard submission does not
 * permanently brick a fresh instance.
 */
export async function bootstrapInstance(
  pool: pg.Pool,
  request: BootstrapRequest,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  // Hashing happens before the transaction opens: it is the slowest step by
  // far (Argon2id is meant to be), and doing it while holding the
  // instance_state row lock would make every concurrent claimant wait on it.
  const passwords = deps.hashPassword
    ? {
        admin: await deps.hashPassword(request.admin.password),
        student: await deps.hashPassword(request.student.password),
      }
    : { admin: null, student: null };

  const client = await pool.connect();
  try {
    await client.query('begin');

    // Read the flag BEFORE attempting the claim. This is what separates "you
    // arrived at a closed instance" (410, permanent) from "you were racing
    // and lost" (409) — after the claim, both look identical in the database.
    const before = await client.query<{ bootstrapped_at: Date | null }>(
      'select bootstrapped_at from instance_state where id = 1',
    );
    const state = before.rows[0];
    if (!state) {
      throw new Error('instance_state has no row — run migrations before serving requests');
    }
    if (state.bootstrapped_at !== null) {
      await client.query('rollback');
      return { ok: false, reason: 'gone', message: 'This instance has already been set up.' };
    }

    // THE CLAIM. Two concurrent callers both reach this statement; the second
    // blocks on the first's row lock and, when it is released, re-evaluates
    // the WHERE against the committed row — where bootstrapped_at is no
    // longer null. Exactly one UPDATE can ever match.
    //
    // The token hash is part of the predicate rather than a separate check, so
    // there is no window between "the token is right" and "the claim is mine".
    // Comparing digests with `=` is not constant-time, but the compared value
    // is a SHA-256 of a 256-bit random token: there is no low-entropy secret
    // to recover a byte at a time, and an attacker cannot choose an input that
    // hashes to a chosen prefix.
    const claim = await client.query(
      `update instance_state
          set bootstrapped_at = now(), setup_token_hash = null
        where id = 1
          and bootstrapped_at is null
          and setup_token_hash is not null
          and setup_token_hash = $1
        returning bootstrapped_at`,
      [hashSetupToken(request.setupToken)],
    );

    if (claim.rowCount === 0) {
      // Either the token was wrong (the row is still there, unclaimed) or
      // somebody else claimed it while this request was in flight.
      const after = await client.query<{ bootstrapped_at: Date | null }>(
        'select bootstrapped_at from instance_state where id = 1',
      );
      await client.query('rollback');
      if (after.rows[0]?.bootstrapped_at != null) {
        return { ok: false, reason: 'conflict', message: 'Another request claimed this instance first.' };
      }
      return { ok: false, reason: 'unauthorized', message: 'Invalid setup token.' };
    }

    // The student account first: the operator account points at it (design
    // §5.1 account linking), not the other way round.
    const student = await insertUser(client, request.student, passwords.student, request.timezone, null);
    const admin = await insertUser(client, request.admin, passwords.admin, request.timezone, student.id);

    // Design §5: admin is exclusive, so the operator account gets `admin` and
    // nothing else, and the student account gets `student`. The database
    // enforces the exclusivity (user_roles_admin_is_exclusive) — this is the
    // shape that satisfies it, not the thing that guarantees it.
    await client.query('insert into user_roles (user_id, role) values ($1, $2), ($3, $4)', [
      admin.id,
      ADMIN_ROLE,
      student.id,
      STUDENT_ROLE,
    ]);

    await client.query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'instance.bootstrapped', 'instance', $2::jsonb)`,
      [
        admin.id,
        JSON.stringify({
          adminHandle: admin.handle,
          studentId: student.id,
          studentHandle: student.handle,
        }),
      ],
    );

    await client.query('commit');

    return {
      ok: true,
      admin: {
        id: admin.id,
        email: admin.email,
        handle: admin.handle,
        displayName: admin.display_name,
        roles: [ADMIN_ROLE],
      },
      student: {
        id: student.id,
        email: student.email,
        handle: student.handle,
        displayName: student.display_name,
        roles: [STUDENT_ROLE],
      },
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    // A unique violation here means the email or handle is already taken by
    // an account that predates the bootstrap. The claim rolled back with the
    // rest of the transaction, so the wizard can be resubmitted.
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, reason: 'invalid', message: 'That email address or handle is already taken.' };
    }
    throw err;
  } finally {
    client.release();
  }
}
