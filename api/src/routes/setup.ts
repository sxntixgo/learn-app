import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import type { BootstrapDeps, BootstrapFailureReason } from '../auth/bootstrap.ts';
import { bootstrapInstance, parseBootstrapRequest } from '../auth/bootstrap.ts';

// =============================================================================
// THE ONE UNAUTHENTICATED WRITE ENDPOINT (design §5.2, §13).
//
// Design §13: "registration only via invite token, with exactly one exception:
// the first-run bootstrap, which is gated by a log-printed setup token."
//
// So this route has no session and no actor to resolve — it is the route that
// CREATES the first identity. It still goes through the policy seam
// (CLAUDE.md rule 2) with an explicitly anonymous actor, because 'anonymous
// may bootstrap an unclaimed instance' is a real authorization rule that
// belongs in the policy module, not an absence of one. The authorization that
// actually matters is enforced in the database: the setup token hash and the
// single-row claim (api/src/auth/bootstrap.ts).
// =============================================================================

// Not a user, and never a users row: the nil UUID cannot collide with a
// gen_random_uuid() id. Deliberately NOT deps.actor — the caller of this
// route is by definition not signed in, so taking the injected actor (which
// is DEV_ACTOR today) would quietly assert the opposite.
const ANONYMOUS_ACTOR: Actor = { id: '00000000-0000-0000-0000-000000000000', roles: [] };

export interface SetupRouteDeps extends BootstrapDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as every other
  // route module.
  can?: typeof defaultCan;
}

const STATUS_BY_REASON: Record<BootstrapFailureReason, number> = {
  invalid: 400,
  unauthorized: 401,
  conflict: 409,
  gone: 410,
};

/** Registers the first-run bootstrap routes (design §5.2). */
export function registerSetupRoutes(fastify: FastifyInstance, deps: SetupRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  // Lets the wizard know whether to show itself at all. Reveals one bit —
  // whether the instance is claimed — which anyone can already infer from the
  // 410 below; it exists so the UI does not have to POST to find out.
  fastify.get('/api/v1/setup', async (_request, reply) => {
    if (!can(ANONYMOUS_ACTOR, 'instance:setup:status')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { rows } = await getPool().query<{ bootstrapped_at: Date | null }>(
      'select bootstrapped_at from instance_state where id = 1',
    );
    return reply.code(200).send({ bootstrapped: rows[0]?.bootstrapped_at != null });
  });

  fastify.post('/api/v1/setup', async (request, reply) => {
    if (!can(ANONYMOUS_ACTOR, 'instance:bootstrap')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Parsed and normalized before anything touches the database, so a
    // malformed submission cannot consume the one-time claim.
    const parsed = parseBootstrapRequest(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ message: parsed.message });
    }

    const result = await bootstrapInstance(getPool(), parsed.value, { hashPassword: deps.hashPassword });
    if (!result.ok) {
      // Never echo back which half was wrong beyond these fixed messages: a
      // 401 here says "that token is not the token", nothing more.
      return reply.code(STATUS_BY_REASON[result.reason]).send({ message: result.message });
    }

    if (!deps.hashPassword) {
      // Loud, because a silently password-less pair is a trap. Nothing can
      // authenticate yet either way (there is no login route until the
      // password/JWT task lands), so this is a seam marker, not a live hole.
      request.log.warn(
        'Bootstrap created accounts with password_hash = NULL: no password hasher is wired in yet (design §13, Argon2id).',
      );
    }

    return reply.code(201).send({ admin: result.admin, student: result.student });
  });
}
