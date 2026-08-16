import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { CourseRouteDeps } from './routes/courses.ts';
import { registerCourseRoutes } from './routes/courses.ts';
import type { ProgressRouteDeps } from './routes/progress.ts';
import { registerProgressRoutes } from './routes/progress.ts';
import type { MeRouteDeps } from './routes/me.ts';
import { registerMeRoutes } from './routes/me.ts';
import type { AdminRouteDeps } from './routes/admin.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import type { SetupRouteDeps } from './routes/setup.ts';
import { registerSetupRoutes } from './routes/setup.ts';
import { getPool } from './db.ts';
import { ensureSetupToken } from './auth/setup-token.ts';

// CourseRouteDeps, ProgressRouteDeps, MeRouteDeps, and AdminRouteDeps are
// structurally identical ({can?, actor?}) but declared separately in each
// route module (CLAUDE.md style: small modules, no speculative shared
// abstraction). One options bag satisfies all four. SetupRouteDeps adds the
// password-hashing seam, and deliberately has no `actor` — see routes/setup.ts.
export type BuildServerOptions = CourseRouteDeps &
  ProgressRouteDeps &
  MeRouteDeps &
  AdminRouteDeps &
  SetupRouteDeps;

export async function buildServer(options: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: true,
  });

  fastify.get('/api/v1/health', async () => {
    return { status: 'ok' };
  });

  registerCourseRoutes(fastify, options);
  registerProgressRoutes(fastify, options);
  registerMeRoutes(fastify, options);
  registerAdminRoutes(fastify, options);
  registerSetupRoutes(fastify, options);

  return fastify;
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const port = Number(process.env.API_PORT ?? 3001);
  const fastify = await buildServer();

  // Design §5.2: on first boot the app generates a one-time setup token and
  // prints it to the container logs. Printed with console.log rather than the
  // Fastify logger so it lands as a readable banner in `docker compose logs`
  // instead of one field of a JSON line.
  //
  // A failure here (database not up yet, migrations not run) must not stop the
  // API from listening: the health endpoint is what an operator needs in order
  // to diagnose it, and restarting the container reprints the token anyway.
  try {
    await ensureSetupToken(getPool());
  } catch (err) {
    fastify.log.error({ err }, 'could not issue the first-run setup token');
  }

  await fastify.listen({ port, host: '0.0.0.0' });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
