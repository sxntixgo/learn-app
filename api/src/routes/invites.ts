import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan, isAnonymous } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { actorWithFreshRoles } from '../auth/roles.ts';
import { hashPassword as defaultHashPassword } from '../auth/password.ts';
import type { HashPassword } from '../auth/bootstrap.ts';
import { EMAIL_PATTERN, MAX_DISPLAY_NAME_LENGTH, MAX_EMAIL_LENGTH, parseHandle, parsePassword } from '../auth/account-fields.ts';
import { isValidTimeZone } from '../time/timezone.ts';
import type { InviteKind } from '../invites/issue.ts';
import { issueInvite, refundExpiredInvites, remainingBudget, revokeInvite } from '../invites/issue.ts';
import { acceptInvite } from '../invites/accept.ts';
import {
  CLAIM_TOKEN_TTL_MINUTES,
  DEFAULT_INVITE_TTL_DAYS,
  MAX_INVITE_TTL_DAYS,
  MIN_INVITE_TTL_DAYS,
  generateClaimToken,
  hashClaimToken,
  hashInviteToken,
} from '../invites/token.ts';

// =============================================================================
// INVITATIONS (design §12, §13).
//
// |                  | Admin     | Teacher          |
// |------------------|-----------|------------------|
// | Platform invite  | unlimited | from a budget    |
// | Course invite    | —         | own courses only |
//
// THE BUDGET IS ABOUT CREATING ACCOUNTS, NOT ABOUT WHICH SCREEN YOU USED.
// §12 budgets the platform invite because it "creates an account". A course
// invite to an address with no account yet creates one too — that is the
// whole point of "one action issues one link that both registers the person
// and enrolls them in the course" — so this route asks
// `invite:platform:create` for it as well. Otherwise a teacher with a budget
// of 0 could mint unlimited accounts through the course screen, and the
// budget would be decoration.
//
// EVERY MUTATION HERE RE-READS ROLES FROM THE DATABASE (design §13:
// "privileged mutations re-check the database"), because a teacher demoted a
// minute ago must not get one more account created on a still-valid
// 15-minute access token.
//
// The two unauthenticated routes (lookup, accept) are gated by the token
// itself, exactly as the first-run bootstrap is gated by the setup token —
// see policy/can.ts's PUBLIC_ACTIONS.
// =============================================================================

export interface InviteRouteDeps {
  can?: typeof defaultCan;
  /** Test seam only — see auth/actor.ts. */
  actor?: Actor;
  /** The Argon2id seam, same as SetupRouteDeps. */
  hashPassword?: HashPassword;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** One answer for unknown, expired, revoked and already-accepted alike. */
const UNUSABLE = 'This invitation link is not valid. It may have expired, been revoked, or already been used.';

type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

interface InviteRow {
  id: string;
  kind: InviteKind;
  email: string;
  course_slug: string | null;
  course_title: string | null;
  issued_by: string | null;
  issuer_handle: string | null;
  issuer_display_name: string | null;
  budget_consumed: boolean;
  refunded_at: Date | null;
  creates_account: boolean;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

const INVITE_COLUMNS = `
  i.id, i.kind, i.email, i.issued_by, i.budget_consumed, i.refunded_at, i.creates_account,
  i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
  c.slug as course_slug, c.title as course_title,
  u.handle as issuer_handle, u.display_name as issuer_display_name
`;

const INVITE_FROM = `
  from invites i
  left join courses c on c.id = i.course_id
  left join users u on u.id = i.issued_by
`;

/**
 * The status a row adds up to. Derived rather than stored: three timestamps
 * already say it, and a fourth column would be a second source of truth that
 * could disagree with them.
 */
function statusOf(row: InviteRow): InviteStatus {
  if (row.accepted_at !== null) return 'accepted';
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function serializeInvite(row: InviteRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: statusOf(row),
    email: row.email,
    courseSlug: row.course_slug,
    courseTitle: row.course_title,
    issuedById: row.issued_by,
    issuedByHandle: row.issuer_handle,
    issuedByDisplayName: row.issuer_display_name,
    budgetConsumed: row.budget_consumed,
    refunded: row.refunded_at !== null,
    createsAccount: row.creates_account,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** True when this actor is an operator account (§5.1: admin is exclusive). */
function isAdmin(actor: Actor): boolean {
  return actor.roles.includes('admin');
}

interface CreateBody {
  kind?: unknown;
  email?: unknown;
  courseSlug?: unknown;
  expiresInDays?: unknown;
}

interface AcceptBody {
  token?: unknown;
  claimToken?: unknown;
  handle?: unknown;
  password?: unknown;
  displayName?: unknown;
  timezone?: unknown;
}


/**
 * One header value as a trimmed string.
 *
 * Node joins a repeated header into "a,b" rather than handing over an array,
 * so a duplicated header simply yields a value that hashes to nothing — it
 * cannot smuggle a real token past the lookup.
 */
function readHeader(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The columns both halves of the lookup return. */
interface InvitePreviewRow {
  kind: InviteKind;
  email: string;
  expires_at: Date;
  creates_account: boolean;
  course_id: string | null;
}

export function registerInviteRoutes(fastify: FastifyInstance, deps: InviteRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;
  const hashPassword = deps.hashPassword ?? defaultHashPassword;

  // ---------------------------------------------------------------------------
  // GET /api/v1/invites — the admin's whole-instance list, or a teacher's own
  // ---------------------------------------------------------------------------
  fastify.get<{ Querystring: { limit?: string } }>('/api/v1/invites', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'invite:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // §12's admin screen shows STATUS, and an expired invite's unit of
    // budget comes back lazily (invites/issue.ts). Sweeping first is what
    // keeps "expired" in the list and "budget restored" from being two
    // different moments.
    const scope = isAdmin(actor) ? null : actor.id;
    await refundExpiredInvites(getPool(), scope);

    const { rows } = await getPool().query<InviteRow>(
      `select ${INVITE_COLUMNS} ${INVITE_FROM}
        where ($2::uuid is null or i.issued_by = $2::uuid)
        order by i.created_at desc
        limit $1`,
      [clampLimit(request.query.limit), scope],
    );

    return reply.code(200).send(rows.map(serializeInvite));
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/invites — issue one
  // ---------------------------------------------------------------------------
  fastify.post<{ Body: CreateBody }>('/api/v1/invites', async (request, reply) => {
    const body = request.body ?? {};
    const actor = await actorWithFreshRoles(getPool(), actorFor(request, deps));

    const kind = body.kind;
    if (kind !== 'platform' && kind !== 'course') {
      return reply.code(400).send({ message: 'kind must be one of: platform, course.' });
    }

    const rawEmail = body.email;
    if (typeof rawEmail !== 'string') {
      return reply.code(400).send({ message: 'email is required.' });
    }
    const email = rawEmail.trim().toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return reply.code(400).send({ message: 'email is not a valid email address.' });
    }

    let ttlDays = DEFAULT_INVITE_TTL_DAYS;
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
      const n = typeof body.expiresInDays === 'number' ? body.expiresInDays : Number(body.expiresInDays);
      if (!Number.isInteger(n) || n < MIN_INVITE_TTL_DAYS || n > MAX_INVITE_TTL_DAYS) {
        return reply
          .code(400)
          .send({ message: `expiresInDays must be a whole number of days between ${MIN_INVITE_TTL_DAYS} and ${MAX_INVITE_TTL_DAYS}.` });
      }
      ttlDays = n;
    }

    let courseId: string | null = null;
    if (kind === 'course') {
      if (typeof body.courseSlug !== 'string' || body.courseSlug.trim() === '') {
        return reply.code(400).send({ message: 'courseSlug is required for a course invitation.' });
      }
      const found = await getPool().query<{ id: string; owner_id: string | null }>(
        'select id, owner_id from courses where slug = $1',
        [body.courseSlug],
      );
      const course = found.rows[0];
      if (!course) {
        return reply.code(404).send({ message: `Course not found: ${body.courseSlug}` });
      }
      // §5: "Invite to a course | own courses". A teacher inviting to a
      // course they do not own is refused HERE, by the policy, with the
      // course's real ownership — never by a role check written in this file.
      if (!can(actor, 'invite:course:create', { course: { ownerId: course.owner_id } })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      courseId = course.id;
    } else if (body.courseSlug !== undefined && body.courseSlug !== null) {
      return reply.code(400).send({ message: 'A platform invitation may not name a course.' });
    }

    const existing = await getPool().query('select 1 from users where email = $1', [email]);
    const createsAccount = existing.rowCount === 0;

    if (kind === 'platform' && !createsAccount) {
      return reply.code(409).send({ message: 'An account already exists for that address.' });
    }

    let consumesBudget = false;
    if (createsAccount) {
      // Any invite that would create an account goes through the platform
      // cell, whatever its kind — see this module's header.
      const budget = await remainingBudget(getPool(), actor.id);
      if (!can(actor, 'invite:platform:create', { budget: { remaining: budget } })) {
        return reply.code(403).send({
          message: isAdmin(actor)
            ? 'Forbidden'
            : 'Inviting someone who has no account yet spends a platform-invite budget, and yours is 0. Ask an admin for one.',
        });
      }
      consumesBudget = !isAdmin(actor);
    }

    const result = await issueInvite(getPool(), {
      issuerId: actor.id,
      kind,
      email,
      courseId,
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      createsAccount,
      consumesBudget,
    });

    if (!result.ok) {
      // The budget went to zero between the policy check and the decrement.
      // The decrement is the real gate; this is what it looks like from here.
      return reply.code(403).send({ message: 'Your platform-invite budget is exhausted.' });
    }

    const { rows } = await getPool().query<InviteRow>(`select ${INVITE_COLUMNS} ${INVITE_FROM} where i.id = $1`, [
      result.invite.id,
    ]);

    return reply.code(201).send({
      invite: serializeInvite(rows[0]!),
      // The plaintext, returned exactly once. It is never stored and never
      // appears in the list or the audit log.
      token: result.invite.token,
      acceptPath: `/invite/${result.invite.token}`,
      remainingBudget: await remainingBudget(getPool(), actor.id),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/invites/:inviteId/revoke
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: { inviteId: string } }>('/api/v1/invites/:inviteId/revoke', async (request, reply) => {
    const actor = await actorWithFreshRoles(getPool(), actorFor(request, deps));
    if (!can(actor, 'invite:revoke')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // A teacher may revoke only what they issued. The scoping is in the
    // UPDATE's WHERE (invites/issue.ts), not a read-then-check here, so
    // there is no window between the two.
    const result = await revokeInvite(getPool(), {
      inviteId: request.params.inviteId,
      actorId: actor.id,
      scopeToIssuer: !isAdmin(actor),
    });
    if (!result.ok) {
      return reply
        .code(409)
        .send({ message: 'That invitation cannot be revoked: it has already been accepted, revoked, or is not yours.' });
    }

    const { rows } = await getPool().query<InviteRow>(`select ${INVITE_COLUMNS} ${INVITE_FROM} where i.id = $1`, [
      request.params.inviteId,
    ]);

    return reply.code(200).send({ invite: serializeInvite(rows[0]!), refunded: result.refunded });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/invites/lookup?token=… — what a link is for (unauthenticated)
  // ---------------------------------------------------------------------------
  // THE TOKEN ARRIVES IN A HEADER, not a query parameter. Fastify logs
  // `req.url` on every request, so `?token=...` put a live invite token into
  // the container log in plaintext — and Caddy's access log records the URI
  // as well. Neither logs request headers. api/src/log-redaction.ts redacts
  // the query string too, belt and braces, for whatever gets added next.
  fastify.get('/api/v1/invites/lookup', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'invite:preview')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Fastify lowercases incoming header names. Node joins a REPEATED header
    // into one comma-separated string rather than an array (arrays are only
    // for set-cookie), so a duplicated header yields "a,b" — a value that
    // matches no stored hash and falls through to the same 410 as any other
    // bad token. Nothing to special-case: it cannot smuggle a valid token past
    // the lookup.
    const headerToken = readHeader(request.headers['x-invite-token']);
    const headerClaim = readHeader(request.headers['x-invite-claim']);
    if (headerToken === '' && headerClaim === '') {
      return reply.code(400).send({ message: 'The X-Invite-Token or X-Invite-Claim header is required.' });
    }

    // THE LINK IS SPENT BY BEING OPENED.
    //
    // Presenting the URL token consumes it — atomically, in one UPDATE, so
    // two concurrent opens cannot both succeed — and mints a claim token in
    // its place. The claim goes back in the response BODY and the web app
    // puts it in an httpOnly cookie, so it never enters a URL, a proxy access
    // log, browser history or a Referer. A URL token recovered from a log
    // afterwards matches nothing.
    //
    // Presenting the claim instead is a plain read: the page has to survive a
    // reload, and the "sign in as this address, then come back" path returns
    // here a second time.
    const issuedClaim = headerClaim === '' ? generateClaimToken() : null;

    const { rows } = issuedClaim !== null
      ? await getPool().query<InvitePreviewRow>(
          `update invites i
              set token_consumed_at = now(),
                  claim_token_hash = $2,
                  -- Never outliving the invite itself: a short continuation
                  -- window cannot extend a link past its own expiry.
                  claim_expires_at = least(now() + ($3 || ' minutes')::interval, i.expires_at)
            where i.token_hash = $1
              and i.token_consumed_at is null
              and i.accepted_at is null
              and i.revoked_at is null
              and i.expires_at > now()
            returning i.kind, i.email, i.expires_at, i.creates_account, i.course_id`,
          [hashInviteToken(headerToken), hashClaimToken(issuedClaim), String(CLAIM_TOKEN_TTL_MINUTES)],
        )
      : await getPool().query<InvitePreviewRow>(
          `select i.kind, i.email, i.expires_at, i.creates_account, i.course_id
             from invites i
            where i.claim_token_hash = $1
              and i.claim_expires_at > now()
              and i.accepted_at is null
              and i.revoked_at is null
              and i.expires_at > now()`,
          [hashClaimToken(headerClaim)],
        );

    const invite = rows[0];
    if (!invite) {
      // 410, and the same message for every way of being dead — unknown,
      // expired, revoked, already accepted, or a link that has already been
      // opened. A caller cannot learn which flavour of dead a token they do
      // not hold is.
      return reply.code(410).send({ message: UNUSABLE });
    }

    const course = invite.course_id === null
      ? { slug: null, title: null }
      : (
          await getPool().query<{ slug: string; title: string }>(
            'select slug, title from courses where id = $1',
            [invite.course_id],
          )
        ).rows[0] ?? { slug: null, title: null };

    // Re-checked at read time rather than trusted from `creates_account`
    // alone: the invite may have been issued before the address got an
    // account, and the form to show depends on the world as it is now. The
    // AUTHORIZATION still comes from `creates_account` — accept.ts refuses to
    // register on an invite that was never allowed to.
    const existing = await getPool().query('select 1 from users where email = $1', [invite.email]);

    return reply.code(200).send({
      kind: invite.kind,
      email: invite.email,
      courseSlug: course.slug,
      courseTitle: course.title,
      expiresAt: invite.expires_at,
      needsAccount: invite.creates_account && existing.rowCount === 0,
      // Present ONLY on the request that spent the link. The caller must
      // store it somewhere that is not a URL; web puts it in an httpOnly
      // cookie. Absent when the caller already presented a claim.
      claimToken: issuedClaim,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/invites/accept — register (and enrol) in one step
  // ---------------------------------------------------------------------------
  fastify.post<{ Body: AcceptBody }>('/api/v1/invites/accept', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'invite:accept')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const body = request.body ?? {};
    // Either credential is acceptable, and the claim wins when both arrive.
    // A browser flow always sends the claim: the link was spent when it was
    // opened, so its URL token is already consumed and would match nothing.
    // `token` remains for a direct API client that never opened a preview.
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const claimToken = typeof body.claimToken === 'string' ? body.claimToken.trim() : '';
    if (token === '' && claimToken === '') {
      return reply.code(400).send({ message: 'token or claimToken is required.' });
    }

    // Validated BEFORE anything touches the invite, so a bad handle cannot
    // even reach the claim — the same ordering the bootstrap uses.
    let handle: string | null = null;
    let password: string | null = null;
    if (body.handle !== undefined && body.handle !== null) {
      const parsed = parseHandle('account', body.handle);
      if (!parsed.ok) return reply.code(400).send({ message: parsed.message });
      handle = parsed.value;
    }
    if (body.password !== undefined && body.password !== null) {
      const parsed = parsePassword('account', body.password);
      if (!parsed.ok) return reply.code(400).send({ message: parsed.message });
      password = parsed.value;
    }
    if ((handle === null) !== (password === null)) {
      return reply.code(400).send({ message: 'A handle and a password are both required to register an account.' });
    }

    const rawDisplayName = body.displayName;
    if (rawDisplayName !== undefined && rawDisplayName !== null && typeof rawDisplayName !== 'string') {
      return reply.code(400).send({ message: 'displayName must be a string when provided.' });
    }
    const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim() : '';
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return reply.code(400).send({ message: `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.` });
    }

    const rawTimezone = body.timezone;
    if (rawTimezone !== undefined && rawTimezone !== null && !isValidTimeZone(rawTimezone)) {
      return reply.code(400).send({ message: `Invalid timezone: ${JSON.stringify(rawTimezone)}.` });
    }

    const result = await acceptInvite(
      getPool(),
      {
        token: token === '' ? null : token,
        claimToken: claimToken === '' ? null : claimToken,
        handle,
        password,
        displayName: displayName === '' ? null : displayName,
        timezone: isValidTimeZone(rawTimezone) ? rawTimezone : null,
        // An anonymous caller has no account to enrol; the nil-uuid actor
        // must never be mistaken for one.
        actorId: isAnonymous(actor) ? null : actor.id,
      },
      { hashPassword },
    );

    if (!result.ok) {
      const status =
        result.reason === 'unusable'
          ? 410
          : result.reason === 'registration_required'
            ? 400
            : 409;
      return reply.code(status).send({ message: result.message });
    }

    return reply.code(201).send({
      user: {
        id: result.user.id,
        email: result.user.email,
        handle: result.user.handle,
        displayName: result.user.displayName,
        roles: result.user.roles,
      },
      courseSlug: result.courseSlug,
      enrolled: result.enrolled,
    });
  });
}
