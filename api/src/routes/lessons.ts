import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan, DEV_ACTOR } from '../policy/can.ts';

export interface LessonRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2). Defaults to the real
  // `can`; tests override it to exercise the 403 path and to spy on calls
  // without needing `can()` to ever actually return false in Phase 1.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface LessonRow {
  slug: string;
  title: string;
  blocks: unknown;
}

/** Registers `GET /api/v1/lessons/:slug` on `fastify`. */
export function registerLessonRoutes(fastify: FastifyInstance, deps: LessonRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;
  const actor = deps.actor ?? DEV_ACTOR;

  fastify.get<{ Params: { slug: string } }>('/api/v1/lessons/:slug', async (request, reply) => {
    const { slug } = request.params;

    const result = await getPool().query<LessonRow>('select slug, title, blocks from lessons where slug = $1', [
      slug,
    ]);
    const row = result.rows[0];

    if (!row) {
      return reply.code(404).send({ message: `Lesson not found: ${slug}` });
    }

    const lesson = { slug: row.slug, title: row.title, blocks: row.blocks };

    // The seam: resolve actor, then ask before returning content. Phase 1
    // `can()` always returns true; the check still runs on every request so
    // Phase 6 can tighten the rule without touching this handler.
    if (!can(actor, 'lesson:read', lesson)) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    return reply.code(200).send(lesson);
  });
}
