import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { clearSessionCookies } from '../auth/cookies.ts';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../time/timezone.ts';
import { buildHeatmapDays, clampWeeks } from '../activity/heatmap.ts';
import { localDateKey } from '../activity/streaks.ts';
import { loadStreaks } from '../activity/day-keys.ts';
import { listBadgeProgress, listDegreeProgress } from '../progression/views.ts';
import { remainingBudget } from '../invites/issue.ts';
import { exportAccount } from '../me/export.ts';
import { deleteAccount } from '../me/delete-account.ts';

export interface MeRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as
  // courses.ts/progress.ts.
  can?: typeof defaultCan;
  actor?: Actor;
}

type TimezoneSource = 'set' | 'default';

interface UserRow {
  id: string;
  display_name: string | null;
  handle: string | null;
  timezone: string | null;
}

interface MeResponse {
  id: string;
  displayName: string | null;
  handle: string | null;
  /** Whether `/api/v1/profiles/{handle}` will serve this account — false for operators (§5.1). */
  hasProfile: boolean;
  timezone: string;
  timezoneSource: TimezoneSource;
  /** Design §12's platform-invite budget, 0 for everyone it was never granted to. */
  inviteBudget: number;
}

interface MeUpdateBody {
  timezone?: unknown;
}

interface ActivityEventRow {
  type: string;
  occurred_at: Date;
  course_slug: string | null;
  course_title: string | null;
  lesson_slug: string | null;
  lesson_title: string | null;
}

const DEFAULT_ACTIVITY_LIMIT = 20;
const MIN_ACTIVITY_LIMIT = 1;
const MAX_ACTIVITY_LIMIT = 100;

/** Loads the users row backing `actor`, or null if somehow absent. */
async function findUser(actorId: string): Promise<UserRow | null> {
  const result = await getPool().query<UserRow>('select id, display_name, handle, timezone from users where id = $1', [
    actorId,
  ]);
  return result.rows[0] ?? null;
}

/** Shapes a users row into the public Me response (design §15's UTC fallback). */
/**
 * `hasProfile` mirrors what `/api/v1/profiles/:handle` will actually serve:
 * `findProfileSubject` requires the student role, because §5.1 gives operator
 * accounts "no enrollments, no progress, no badges, and no public profile".
 *
 * It exists so the shell can decide whether the account holder's own name is
 * a link WITHOUT guessing. Without it the header either links everyone —
 * sending admins to a 404 — or links nobody, which is what it did: the
 * profile was reachable only from the dashboard.
 *
 * The API reports the two facts (who you are, whether you have a profile);
 * it deliberately does not report a URL. `/u/:handle` is web's routing, not
 * the API's, and the two are kept apart everywhere else here too.
 */
function toMeResponse(row: UserRow, inviteBudget: number, isStudent: boolean): MeResponse {
  return {
    id: row.id,
    displayName: row.display_name,
    handle: row.handle,
    hasProfile: isStudent && row.handle !== null,
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
    timezoneSource: row.timezone ? 'set' : 'default',
    inviteBudget,
  };
}

/**
 * The actor's spendable invite budget (design §12).
 *
 * `remainingBudget` sweeps expired invitations before reading, which is how
 * "refunded on expiry" happens at all: §4 keeps Postgres as the only
 * stateful service, so there is no cron and no worker to do it, and a
 * read is the moment the number has to be right. The sweep's UPDATE is
 * guarded by `refunded_at is null` and served by a partial index over the
 * few refundable rows, so for the overwhelming majority of readers — who
 * have never issued an invitation — it matches nothing.
 */
async function inviteBudgetFor(actorId: string): Promise<number> {
  return remainingBudget(getPool(), actorId);
}

/** Parses and clamps the `?limit=` query param for the activity feed. */
function clampActivityLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(MAX_ACTIVITY_LIMIT, Math.max(MIN_ACTIVITY_LIMIT, Math.floor(n)));
}

/** Registers the /api/v1/me* routes (design §10, §15) on `fastify`. */
export function registerMeRoutes(fastify: FastifyInstance, deps: MeRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.get('/api/v1/me', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    // The policy question is asked BEFORE the lookup, unlike the other
    // routes here, because on this one the resource IS the actor. With the
    // lookup first, an unauthenticated request fell through to "user not
    // found" for the anonymous actor's nil uuid — a 404 that was really an
    // authorization outcome, decided by an accident of query results
    // instead of by can(). The row is not needed to answer "may you read
    // your own profile", so it is fetched only once that is settled.
    if (!can(actor, 'me:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const userRow = await findUser(actor.id);
    if (!userRow) {
      return reply.code(404).send({ message: `User not found: ${actor.id}` });
    }

    return reply.code(200).send(toMeResponse(userRow, await inviteBudgetFor(actor.id), actor.roles.includes('student')));
  });

  fastify.patch<{ Body: MeUpdateBody }>('/api/v1/me', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    const body = request.body ?? {};
    const timezone = body.timezone;

    // Validated BEFORE the policy check and BEFORE any write: an invalid
    // zone must never reach the database, since every heatmap/streak query
    // downstream keys off this column (design §15).
    if (!isValidTimeZone(timezone)) {
      return reply.code(400).send({
        message: `Invalid timezone: ${JSON.stringify(timezone)}. Must be a real IANA time zone name (e.g. "America/Denver").`,
      });
    }

    if (!can(actor, 'me:update', { userId: actor.id, timezone })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const result = await getPool().query<UserRow>(
      'update users set timezone = $2 where id = $1 returning id, display_name, handle, timezone',
      [actor.id, timezone],
    );
    const userRow = result.rows[0];
    if (!userRow) {
      return reply.code(404).send({ message: `User not found: ${actor.id}` });
    }

    return reply.code(200).send(toMeResponse(userRow, await inviteBudgetFor(actor.id), actor.roles.includes('student')));
  });

  fastify.get<{ Querystring: { limit?: string } }>('/api/v1/me/activity', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    // Named subject on every user-scoped action (policy/can.ts): the feed
    // below is filtered to `actor.id`, and saying so is what lets can()
    // refuse a future caller that reads somebody else's.
    if (!can(actor, 'me:activity:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const limit = clampActivityLimit(request.query.limit);

    const result = await getPool().query<ActivityEventRow>(
      `select
         ae.type,
         ae.occurred_at,
         c.slug as course_slug, c.title as course_title,
         l.slug as lesson_slug, l.title as lesson_title
       from activity_events ae
       left join courses c on c.id = ae.course_id
       left join lessons l on l.id = ae.lesson_id
       where ae.user_id = $1
       order by ae.occurred_at desc
       limit $2`,
      [actor.id, limit],
    );

    const events = result.rows.map((row) => ({
      type: row.type,
      occurredAt: row.occurred_at,
      course: row.course_slug !== null ? { slug: row.course_slug, title: row.course_title } : null,
      lesson: row.lesson_slug !== null ? { slug: row.lesson_slug, title: row.lesson_title } : null,
    }));

    return reply.code(200).send(events);
  });

  fastify.get<{ Querystring: { weeks?: string } }>('/api/v1/me/heatmap', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:heatmap:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const userRow = await findUser(actor.id);
    const timezone = userRow?.timezone ?? DEFAULT_TIMEZONE;
    const timezoneSource: TimezoneSource = userRow?.timezone ? 'set' : 'default';

    const weeks = clampWeeks(request.query.weeks);
    const now = new Date();
    const todayKey = localDateKey(now, timezone);
    const windowStartKey = localDateKey(new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000), timezone);

    // Governing rule (design §15): bucketing happens in Postgres via
    // `occurred_at AT TIME ZONE $tz`, not by pulling every row into
    // JavaScript and formatting it there. The lower bound converts the
    // local calendar date `windowStartKey` back to a UTC instant (midnight
    // of that day, in `timezone`) so the index on (user_id, occurred_at)
    // can be used — the WHERE clause is an optimization; correctness comes
    // entirely from the GROUP BY.
    const countsResult = await getPool().query<{ local_date: string; cnt: string }>(
      `select
         (occurred_at at time zone $2)::date::text as local_date,
         count(*)::int as cnt
       from activity_events
       where user_id = $1
         and occurred_at >= ($3::date)::timestamp at time zone $2
       group by local_date`,
      [actor.id, timezone, windowStartKey],
    );
    const counts = new Map(countsResult.rows.map((r) => [r.local_date, Number(r.cnt)]));

    const days = buildHeatmapDays(counts, weeks, todayKey);
    const maxCount = days.reduce((max, d) => Math.max(max, d.count), 0);

    // Streaks, derived not stored (design §10): computed fresh from the
    // actor's FULL activity_events history, not just the requested
    // heatmap window — a streak that started before the window is still a
    // real streak. Deliberately not reusing `counts`/`days` above, which
    // are truncated to the window.
    // One row per active day, not per event — activity/day-keys.ts explains
    // why that distinction is worth a shared module.
    const { current, longest } = await loadStreaks(getPool(), actor.id, timezone, now);

    return reply.code(200).send({
      timezone,
      timezoneSource,
      days,
      maxCount,
      currentStreak: current,
      longestStreak: longest,
    });
  });

  // ---------------------------------------------------------------------------
  // Design §9.3 / §9.2: the learner's badges and degrees, earned AND locked.
  //
  // Both take a client out of the pool rather than querying it directly:
  // progression/facts.ts loads several bundles in sequence and they must all
  // see the same snapshot of the world, which a pool cannot promise (each
  // query could land on a different connection, mid-write). The award path
  // gets that for free by running inside the write's transaction; a read has
  // to ask for it.
  // ---------------------------------------------------------------------------

  fastify.get('/api/v1/me/badges', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:badges:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const client = await getPool().connect();
    try {
      return reply.code(200).send(await listBadgeProgress(client, actor.id));
    } finally {
      client.release();
    }
  });

  fastify.get('/api/v1/me/degrees', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:degrees:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const client = await getPool().connect();
    try {
      return reply.code(200).send(await listDegreeProgress(client, actor.id));
    } finally {
      client.release();
    }
  });

  // Data portability. Scoped to the actor by construction: there is no
  // userId parameter here to point somewhere else, so the only export anyone
  // can ask for is their own. Returns the email, which Gate 12 permits —
  // that gate is about emails reaching UNAUTHENTICATED callers, and this is
  // your own record returned to you.
  fastify.get('/api/v1/me/export', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:export', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const result = await exportAccount(getPool(), actor.id);
    if (!result) {
      // A valid session whose user row is gone. Treat it as unauthorised
      // rather than 404: the account does not exist, so neither does the
      // permission to read it.
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Named so a browser saves it as a file rather than rendering it.
    reply.header('content-disposition', 'attachment; filename="learn-app-export.json"');
    return reply.code(200).send(result);
  });

  fastify.delete('/api/v1/me/account', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:delete', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Typed confirmation, checked server-side. A destructive, irreversible
    // action should not be reachable by a stray DELETE — a CSRF attempt, a
    // mis-wired client, a curl with the wrong path — and the client cannot be
    // the only thing standing between a session and permanent erasure.
    const body = request.body as { confirmHandle?: unknown } | undefined;
    const confirmHandle = typeof body?.confirmHandle === 'string' ? body.confirmHandle.trim() : '';

    const owner = await getPool().query<{ handle: string | null }>(`select handle from users where id = $1`, [
      actor.id,
    ]);
    const handle = owner.rows[0]?.handle ?? null;

    if (!handle || confirmHandle !== handle) {
      return reply.code(400).send({ message: 'confirmHandle must match your own handle' });
    }

    await deleteAccount(getPool(), actor.id);

    // The session outlives the row it points at unless it is cleared here.
    // refresh_tokens cascade with the account, but the access-token cookie is
    // stateless and would keep resolving to a deleted id until it expired.
    //
    // `clearSessionCookies` (auth/cookies.ts), not a hand-rolled
    // `reply.clearCookie('access_token', ...)`: the real cookies are named
    // `learn_at`/`learn_rt` (ACCESS_COOKIE/REFRESH_COOKIE) and the refresh
    // one is scoped to `REFRESH_COOKIE_PATH` ('/api/v1/auth'), not '/' — a
    // `clearCookie` call with the wrong name/path sets a cookie that was
    // never there and leaves the real session cookies live, so the browser
    // keeps authenticating as the just-deleted account until the token's
    // natural TTL expiry. Caught by web/settings/account e2e coverage: the
    // page immediately after deletion (/login?deleted=1) called `GET
    // /api/v1/me` with the still-live access cookie and got a 404 ("valid
    // token, no such user") instead of the anonymous 403 a cleared session
    // would produce. `routes/auth.ts`'s logout/refresh-reuse paths already
    // use this same helper; this route just needed to match them.
    clearSessionCookies(reply);
    return reply.code(204).send();
  });
}
