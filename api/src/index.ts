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

// CourseRouteDeps, ProgressRouteDeps, and MeRouteDeps are structurally
// identical ({can?, actor?}) but declared separately in each route module
// (CLAUDE.md style: small modules, no speculative shared abstraction). One
// options bag satisfies all three.
export type BuildServerOptions = CourseRouteDeps & ProgressRouteDeps & MeRouteDeps;

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

  return fastify;
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const port = Number(process.env.API_PORT ?? 3001);
  const fastify = await buildServer();
  await fastify.listen({ port, host: '0.0.0.0' });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
