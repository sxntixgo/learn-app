import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../time/timezone.ts';
import { computeStreaks } from '../activity/streaks.ts';
import type { StreakEvent } from '../activity/streaks.ts';
import { buildHeatmapDays, clampWeeks } from '../activity/heatmap.ts';
import { localDateKey } from '../activity/streaks.ts';

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
  timezone: string | null;
}

interface MeResponse {
  id: string;
  displayName: string | null;
  timezone: string;
  timezoneSource: TimezoneSource;
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
  const result = await getPool().query<UserRow>('select id, display_name, timezone from users where id = $1', [
    actorId,
  ]);
  return result.rows[0] ?? null;
}

/** Shapes a users row into the public Me response (design §15's UTC fallback). */
function toMeResponse(row: UserRow): MeResponse {
  return {
    id: row.id,
    displayName: row.display_name,
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
    timezoneSource: row.timezone ? 'set' : 'default',
  };
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
    if (!can(actor, 'me:read', { id: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const userRow = await findUser(actor.id);
    if (!userRow) {
      return reply.code(404).send({ message: `User not found: ${actor.id}` });
    }

    return reply.code(200).send(toMeResponse(userRow));
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

    if (!can(actor, 'me:update', { timezone })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const result = await getPool().query<UserRow>(
      'update users set timezone = $2 where id = $1 returning id, display_name, timezone',
      [actor.id, timezone],
    );
    const userRow = result.rows[0];
    if (!userRow) {
      return reply.code(404).send({ message: `User not found: ${actor.id}` });
    }

    return reply.code(200).send(toMeResponse(userRow));
  });

  fastify.get<{ Querystring: { limit?: string } }>('/api/v1/me/activity', async (request, reply) => {
    // Resolved per request from the access-token cookie (auth/actor.ts):
    // the anonymous actor when there is no valid session, never a bypass.
    const actor = actorFor(request, deps);

    if (!can(actor, 'me:activity:read')) {
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

    if (!can(actor, 'me:heatmap:read')) {
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
    const allEventsResult = await getPool().query<{ occurred_at: Date }>(
      'select occurred_at from activity_events where user_id = $1 order by occurred_at asc',
      [actor.id],
    );
    const streakEvents: StreakEvent[] = allEventsResult.rows.map((r) => ({ occurredAt: r.occurred_at }));
    const { current, longest } = computeStreaks(streakEvents, timezone, now);

    return reply.code(200).send({
      timezone,
      timezoneSource,
      days,
      maxCount,
      currentStreak: current,
      longestStreak: longest,
    });
  });
}
