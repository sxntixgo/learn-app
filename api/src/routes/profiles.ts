import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan, isAnonymous } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';
import type { RateLimitOptions } from '../auth/rate-limit.ts';
import { findProfileSubject, loadProfileModel, loadVisibility } from '../profile/load.ts';
import { avatarSeed, serializeProfile } from '../profile/serialize.ts';
import type { ProfileAvatar } from '../profile/serialize.ts';
import type { ProfileSection, SectionVisibility, ViewerRelation, VisibilityMap } from '../profile/visibility.ts';
import { isProfileSection, isSectionVisibility, visibleSectionsFor } from '../profile/visibility.ts';

// =============================================================================
// THE PROFILE ROUTES (design §11).
//
// GET /api/v1/profiles/:handle  — the page behind /u/:handle. Reachable
//   without a session, which is why everything else in this module exists.
// GET/PATCH /api/v1/me/profile  — the account holder's own settings.
//
// THE VIEWER IS DECIDED HERE, ONCE, FROM THE SESSION. Never from a query
// parameter, a header, or anything else the caller controls:
//
//   owner       can(actor, 'profile:read', { userId: subject.id }) — the
//               self-scoped §5 cell that already existed
//   signed_in   any other authenticated actor
//   anonymous   everybody else
//
// and profile/serialize.ts then routes the anonymous case through a separate
// allowlist serializer. The route never deletes fields from a payload.
//
// AVATAR UPLOADS ARE NOT IMPLEMENTED. §11.1 permits them ("always re-encode,
// never serve the bytes you were given"), and that re-encode needs `sharp`,
// which currently ships unpatched libvips CVEs; the fixed line requires Next
// 16, an upgrade this project has deferred. So `users.avatar_kind` stays
// 'identicon' for every account and there is no upload endpoint. Adding one
// before that upgrade would be shipping the vulnerability, not the feature.
// =============================================================================

/**
 * §11: "The unauthenticated route is rate-limited."
 *
 * THE PHASE 6 LIMITER, REUSED — not a second one. It counts events per key
 * and locks the key with doubling backoff once they pass a threshold; a
 * "failure" there is simply "one more event on this key", which is exactly
 * what a request to a public page is. What differs is the tuning: a person
 * reading profiles makes tens of requests, a scraper enumerating handles
 * makes thousands.
 *
 * Keyed by IP only. There is no account to key on — that is the whole point
 * of the endpoint — and keying on the handle would let one attacker lock
 * every visitor out of a popular profile.
 *
 * THE LOCKOUT AND THE FORGET WINDOW ARE THE SAME LENGTH, DELIBERATELY. The
 * login route resets a key on a successful sign-in; a page view has no such
 * moment, so nothing here ever calls `reset()` and the counter only clears by
 * ageing out (`#forgetAfterMs`, which is `max(windowMs, maxLockoutMs)`).
 * With a lockout SHORTER than that window, each request that got through
 * after the threshold would double the next lockout — an address that once
 * burst would stay throttled for as long as it kept browsing, which for one
 * office behind one NAT is a self-inflicted outage. Making the two equal
 * means the lockout expires at the same moment the count does: sixty views a
 * minute, then a minute's pause, then a clean slate.
 */
export const DEFAULT_PROFILE_RATE_LIMIT: Omit<RateLimitOptions, 'now'> = {
  maxAttempts: 60,
  windowMs: 60_000,
  baseLockoutMs: 60_000,
  maxLockoutMs: 60_000,
};

export interface ProfileRouteDeps {
  /** Injectable policy function (CLAUDE.md rule 2), same seam as the other route modules. */
  can?: typeof defaultCan;
  actor?: Actor;
  /** Test seam. Production gets one limiter for the process, like the login route. */
  profileRateLimiter?: LoginRateLimiter;
}

/** Migration 0005's `users_handle_url_safe`, in the route, so a junk path never reaches SQL. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}$/;

/** Migration 0014's `users_bio_length`. Checked here as well as in the database. */
const MAX_BIO_LENGTH = 2000;

/**
 * One refusal for "no such handle", "not a handle at all", and "that account
 * has no learner profile". A different message for the last one would turn
 * this endpoint into an oracle for which handles are taken and what kind of
 * account holds them.
 */
const NO_PROFILE = 'No such profile.';

interface ProfileSettingsBody {
  bio?: unknown;
  noindex?: unknown;
  visibility?: unknown;
}

interface SettingsRow {
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  profile_noindex: boolean;
}

interface ProfileSettings {
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  noindex: boolean;
  /** The same identicon the public page shows, so the two never disagree. */
  avatar: ProfileAvatar;
  visibility: VisibilityMap;
}

/** What a validated PATCH body asks for. Absent keys mean "leave it alone". */
interface SettingsUpdate {
  bio?: string | null;
  noindex?: boolean;
  visibility: Map<ProfileSection, SectionVisibility>;
}

/**
 * Parses the PATCH body, or returns the message to refuse it with.
 *
 * An unknown section name is a 400, NOT a silently-ignored key: a settings
 * screen that appears to save a toggle it did not save is worse than one that
 * fails loudly, and a typo'd section must never become a sixth section.
 */
function parseSettingsUpdate(body: ProfileSettingsBody): { update: SettingsUpdate } | { error: string } {
  const update: SettingsUpdate = { visibility: new Map() };

  if ('bio' in body && body.bio !== undefined) {
    if (body.bio === null) {
      update.bio = null;
    } else if (typeof body.bio !== 'string') {
      return { error: 'bio must be a string or null.' };
    } else if (body.bio.length > MAX_BIO_LENGTH) {
      return { error: `bio must be at most ${MAX_BIO_LENGTH} characters.` };
    } else {
      // An empty bio is ABSENT, not a blank string (migration 0014's header).
      const trimmed = body.bio.trim();
      update.bio = trimmed === '' ? null : trimmed;
    }
  }

  if ('noindex' in body && body.noindex !== undefined) {
    if (typeof body.noindex !== 'boolean') return { error: 'noindex must be a boolean.' };
    update.noindex = body.noindex;
  }

  if ('visibility' in body && body.visibility !== undefined) {
    const visibility = body.visibility;
    if (typeof visibility !== 'object' || visibility === null || Array.isArray(visibility)) {
      return { error: 'visibility must be an object of section → visibility.' };
    }
    for (const [section, value] of Object.entries(visibility)) {
      if (!isProfileSection(section)) {
        return { error: `Unknown profile section: ${JSON.stringify(section)}.` };
      }
      if (!isSectionVisibility(value)) {
        return { error: `Unknown visibility for ${section}: ${JSON.stringify(value)}.` };
      }
      update.visibility.set(section, value);
    }
  }

  return { update };
}

/** The actor's own settings row plus their visibility map. */
async function readSettings(userId: string): Promise<ProfileSettings | null> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<SettingsRow>(
      'select handle, display_name, bio, profile_noindex from users where id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio,
      noindex: row.profile_noindex,
      avatar: { kind: 'identicon', seed: avatarSeed(userId) },
      visibility: await loadVisibility(client, userId),
    };
  } finally {
    client.release();
  }
}

/** Registers the §11 profile routes on `fastify`. */
export function registerProfileRoutes(fastify: FastifyInstance, deps: ProfileRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;
  const rateLimiter = deps.profileRateLimiter ?? new LoginRateLimiter(DEFAULT_PROFILE_RATE_LIMIT);

  fastify.get<{ Params: { handle: string } }>('/api/v1/profiles/:handle', async (request, reply) => {
    const actor = actorFor(request, deps);

    // The chokepoint first, as everywhere else. This action is one of the
    // three in PUBLIC_ACTIONS, so an anonymous request passes it — reaching
    // the endpoint is not the same as being shown anything, and what comes
    // back is decided by the visibility map below.
    if (!can(actor, 'profile:public:read')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Counted BEFORE the lookup, so a scanner cannot use the endpoint as a
    // free database probe, and counted for 404s too (below) so enumerating
    // handles costs the same as reading real ones.
    const keys = [`profile-ip:${request.ip}`];
    const decision = rateLimiter.check(keys);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      return reply.code(429).send({ message: 'Too many profile requests. Try again later.' });
    }
    rateLimiter.recordFailure(keys);

    // The JSON itself is never something to index, whatever the subject's
    // own `noindex` setting says; the page's robots meta is the web app's
    // job and reads `noindex` from the payload.
    reply.header('X-Robots-Tag', 'noindex');
    // The body depends on the session cookie, so a shared cache must never
    // hand one viewer's payload to another.
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Cookie');

    const handle = String(request.params.handle ?? '').toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      return reply.code(404).send({ message: NO_PROFILE });
    }

    const client = await getPool().connect();
    try {
      const subject = await findProfileSubject(client, handle);
      // §5.1: an operator account has no public profile, and §5's profile row
      // is a student power — so a teacher-only account has none either.
      if (!subject || !subject.isStudent) {
        return reply.code(404).send({ message: NO_PROFILE });
      }

      const viewer: ViewerRelation = can(actor, 'profile:read', { userId: subject.id })
        ? 'owner'
        : isAnonymous(actor)
          ? 'anonymous'
          : 'signed_in';

      const visibility = await loadVisibility(client, subject.id);
      const sections = visibleSectionsFor(visibility, viewer);
      const model = await loadProfileModel(client, subject, visibility, sections);

      return reply.code(200).send(serializeProfile(model, viewer));
    } finally {
      client.release();
    }
  });

  fastify.get('/api/v1/me/profile', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'profile:read', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const settings = await readSettings(actor.id);
    if (!settings) return reply.code(404).send({ message: `User not found: ${actor.id}` });

    return reply.code(200).send(settings);
  });

  fastify.patch<{ Body: ProfileSettingsBody }>('/api/v1/me/profile', async (request, reply) => {
    const actor = actorFor(request, deps);

    // Shape first, exactly as routes/me.ts validates the timezone first: a
    // value the database would refuse must never reach it, and the answer
    // must not depend on who asked.
    const parsed = parseSettingsUpdate(request.body ?? {});
    if ('error' in parsed) return reply.code(400).send({ message: parsed.error });

    if (!can(actor, 'profile:update', { userId: actor.id })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { update } = parsed;
    const client = await getPool().connect();
    try {
      await client.query('begin');

      if ('bio' in update || update.noindex !== undefined) {
        // coalesce($n, column): one statement, whichever half was sent.
        const { rowCount } = await client.query(
          `update users
              set bio             = case when $2::boolean then $3::text else bio end,
                  profile_noindex = coalesce($4::boolean, profile_noindex)
            where id = $1`,
          [actor.id, 'bio' in update, update.bio ?? null, update.noindex ?? null],
        );
        if (rowCount === 0) {
          await client.query('rollback');
          return reply.code(404).send({ message: `User not found: ${actor.id}` });
        }
      }

      for (const [section, visibility] of update.visibility) {
        await client.query(
          `insert into profile_section_visibility (user_id, section, visibility)
           values ($1, $2, $3)
           on conflict (user_id, section)
           do update set visibility = excluded.visibility, updated_at = now()`,
          [actor.id, section, visibility],
        );
      }

      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }

    const settings = await readSettings(actor.id);
    if (!settings) return reply.code(404).send({ message: `User not found: ${actor.id}` });

    return reply.code(200).send(settings);
  });
}
