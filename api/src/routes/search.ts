import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { searchLessons } from '../search/query.ts';

export interface SearchRouteDeps {
  // Same injectable seam as every other route module (CLAUDE.md rule 2).
  can?: typeof defaultCan;
  actor?: Actor;
}

/** Matches the contract's `maxLength: 200` on `q`. */
const MAX_QUERY_LENGTH = 200;

export function registerSearchRoutes(fastify: FastifyInstance, deps: SearchRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.get('/api/v1/search', async (request, reply) => {
    const actor = actorFor(request, deps);

    // The floor check, exactly as `course:list` does it: search spans courses,
    // so there is no single resource to scope this to. Per-result visibility
    // is enforced inside searchLessons, against the same rule `lesson:read`
    // uses — see the module comment there for why that is a real risk and
    // what holds the two together.
    if (!can(actor, 'search:query')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const query = request.query as { q?: unknown; limit?: unknown };

    // A missing `q` is the same as an empty one. The contract marks it
    // required, but a search box that 400s while the user is still deciding
    // what to type is worse than one that returns nothing.
    const q = typeof query.q === 'string' ? query.q.slice(0, MAX_QUERY_LENGTH) : '';

    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;

    const results = await searchLessons(getPool(), actor, { q, limit });
    return reply.send(results);
  });
}
