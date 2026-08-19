import type pg from 'pg';
import type { HashPassword } from '../auth/bootstrap.ts';
import { hashInviteToken } from './token.ts';

// Accepting an invite (design §12, §13).
//
// §12: "One action issues one link that both registers the person and
// enrolls them in the course." That is this module: one call, one
// transaction, and at the end of it either an account exists AND is enrolled
// AND the invite is spent, or none of those things happened.
//
// THE CLAIM IS THE SAME TECHNIQUE AS THE BOOTSTRAP'S (auth/bootstrap.ts,
// design §5.2). Not "read the invite, check it is unspent, then write" — two
// simultaneous acceptances of one link both pass that read and both create
// an account. Instead:
//
//   update invites set accepted_at = now()
//    where token_hash = $1 and accepted_at is null and revoked_at is null
//      and expires_at > now()
//
// inside the registration transaction. The second caller blocks on the row
// lock, re-evaluates the WHERE against the committed row, matches nothing,
// and rolls back with the account it was about to create. Exactly one
// account can ever come out of one token — proven in accept.test.ts with
// genuinely parallel calls.
//
// A FAILURE AFTER THE CLAIM RELEASES IT. A taken handle, a duplicate email,
// a wrong signed-in account: all roll back, and the invite is usable again.
// Burning a single-use link on a typo would leave the invitee with no way in
// short of asking for another, which is exactly the trap §5.2's bootstrap
// comment describes.
//
// TWO SHAPES OF ACCEPTANCE, one gate:
//
//   creates_account = true   the invited address had no account when the
//                            invite was issued, and the issuer paid for it
//                            (or was an admin). Registration proceeds.
//   creates_account = false  the invited address already had an account.
//                            Then this invite grants COURSE ACCESS ONLY, and
//                            the caller must be signed in as that account —
//                            a link found in a mailbox may not be turned
//                            into someone else's enrolment, and it may
//                            certainly not mint an account the budget never
//                            paid for.

export interface AcceptInviteRequest {
  token: string;
  /** Required for the registration shape; null when accepting as a signed-in account. */
  handle: string | null;
  password: string | null;
  displayName: string | null;
  timezone: string | null;
  /** The signed-in actor's user id, or null for an anonymous caller. */
  actorId: string | null;
}

export interface AcceptedAccount {
  id: string;
  email: string;
  handle: string | null;
  displayName: string | null;
  roles: string[];
}

export type AcceptFailureReason =
  /** 410 — unknown, expired, revoked, or already accepted. Nothing was consumed. */
  | 'unusable'
  /** 400 — this invite registers an account and the body carried no credentials. */
  | 'registration_required'
  /** 409 — this address already has an account; sign in as it to accept. */
  | 'sign_in_required'
  /** 409 — the requested handle (or email) is already taken. The claim is released. */
  | 'taken';

export type AcceptInviteResult =
  | { ok: true; user: AcceptedAccount; courseSlug: string | null; enrolled: boolean }
  | { ok: false; reason: AcceptFailureReason; message: string };

export interface AcceptInviteDeps {
  /** The Argon2id seam, exactly as auth/bootstrap.ts uses it. */
  hashPassword?: HashPassword;
}

interface ClaimedInvite {
  id: string;
  kind: 'platform' | 'course';
  email: string;
  course_id: string | null;
  creates_account: boolean;
  issued_by: string | null;
}

const STUDENT_ROLE = 'student';

function refuse(reason: AcceptFailureReason, message: string): AcceptInviteResult {
  return { ok: false, reason, message };
}

/** The one message every unusable token gets: no oracle for which flavour of dead it is. */
const UNUSABLE = 'This invitation link is not valid. It may have expired, been revoked, or already been used.';

/**
 * Claims an invite and, in the same transaction, registers or enrols the
 * invitee.
 *
 * `deps.hashPassword` is the Argon2id seam. Without it an account is created
 * with `password_hash = NULL`, which means "no credential" — nothing can
 * authenticate as it. The route always passes the real hasher.
 */
export async function acceptInvite(
  pool: pg.Pool,
  request: AcceptInviteRequest,
  deps: AcceptInviteDeps = {},
): Promise<AcceptInviteResult> {
  // Hashed before the transaction opens: Argon2id is deliberately slow, and
  // holding the invite's row lock across it would make a racing acceptance
  // wait for work that is about to be thrown away.
  const passwordHash =
    request.password !== null && deps.hashPassword ? await deps.hashPassword(request.password) : null;

  const client = await pool.connect();
  try {
    await client.query('begin');

    // THE CLAIM. Every terminal condition is in the WHERE, so there is no
    // window between "this invite is usable" and "this invite is mine".
    const claim = await client.query<ClaimedInvite>(
      `update invites
          set accepted_at = now()
        where token_hash = $1
          and accepted_at is null
          and revoked_at is null
          and expires_at > now()
        returning id, kind, email, course_id, creates_account, issued_by`,
      [hashInviteToken(request.token)],
    );
    const invite = claim.rows[0];
    if (!invite) {
      await client.query('rollback');
      return refuse('unusable', UNUSABLE);
    }

    const existing = await client.query<{ id: string }>('select id from users where email = $1', [invite.email]);
    const existingUserId = existing.rows[0]?.id ?? null;

    let userId: string;
    let account: AcceptedAccount;

    if (invite.creates_account && existingUserId === null) {
      if (request.handle === null || request.password === null) {
        await client.query('rollback');
        return refuse('registration_required', 'Choose a handle and a password to accept this invitation.');
      }

      const inserted = await client.query<{ id: string; email: string; handle: string; display_name: string | null }>(
        `insert into users (email, handle, password_hash, display_name, timezone)
         values ($1, $2, $3, $4, $5)
         returning id, email, handle, display_name`,
        [invite.email, request.handle, passwordHash, request.displayName, request.timezone],
      );
      const row = inserted.rows[0]!;
      userId = row.id;

      // §5: roles are a set, and an invited account is a STUDENT. Nothing
      // here can grant `teacher` or `admin` — those are `role:assign`, an
      // admin action with its own route and its own audit entry.
      await client.query('insert into user_roles (user_id, role) values ($1, $2)', [userId, STUDENT_ROLE]);

      account = {
        id: row.id,
        email: row.email,
        handle: row.handle,
        displayName: row.display_name,
        roles: [STUDENT_ROLE],
      };
    } else {
      // The address already has an account (or this invite was never allowed
      // to create one). Only that account may accept, and only while signed
      // in as it.
      if (existingUserId === null || request.actorId !== existingUserId) {
        await client.query('rollback');
        return refuse(
          'sign_in_required',
          `This invitation is for ${invite.email}, which already has an account. Sign in as that account to accept it.`,
        );
      }
      userId = existingUserId;
      const found = await client.query<{
        id: string;
        email: string;
        handle: string | null;
        display_name: string | null;
      }>('select id, email, handle, display_name from users where id = $1', [userId]);
      const row = found.rows[0]!;
      const roles = await client.query<{ role: string }>('select role from user_roles where user_id = $1 order by role', [
        userId,
      ]);
      account = {
        id: row.id,
        email: row.email,
        handle: row.handle,
        displayName: row.display_name,
        roles: roles.rows.map((r) => r.role),
      };
    }

    // The enrolment half of "one link registers AND enrols". `on conflict`
    // rather than a plain insert because a withdrawn enrolment must come
    // back as the same row (migration 0009: one relationship per pair, ever).
    let courseSlug: string | null = null;
    let enrolled = false;
    if (invite.course_id !== null) {
      await client.query(
        `insert into enrollments (user_id, course_id, status)
         values ($1, $2, 'active')
         on conflict (user_id, course_id) do update set status = 'active', updated_at = now()`,
        [userId, invite.course_id],
      );
      const course = await client.query<{ slug: string }>('select slug from courses where id = $1', [invite.course_id]);
      courseSlug = course.rows[0]?.slug ?? null;
      enrolled = true;
    }

    // §12: every privileged action is in the audit log. The actor is the
    // account that came out of the acceptance, and the issuer is recorded
    // alongside so an admin reading the log can see who let them in.
    await client.query(
      `insert into audit_log (actor_id, action, target, meta)
       values ($1, 'invite.accepted', $2, $3::jsonb)`,
      [
        userId,
        invite.id,
        JSON.stringify({
          kind: invite.kind,
          email: invite.email,
          issuedBy: invite.issued_by,
          courseSlug,
          createdAccount: invite.creates_account && existingUserId === null,
        }),
      ],
    );

    await client.query('commit');
    return { ok: true, user: account, courseSlug, enrolled };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    // The handle (or the email, if an account appeared underneath us) is
    // taken. The claim rolled back with everything else, so the invitee can
    // try again with another handle.
    if ((err as { code?: string }).code === '23505') {
      return refuse('taken', 'That handle is already taken.');
    }
    throw err;
  } finally {
    client.release();
  }
}
