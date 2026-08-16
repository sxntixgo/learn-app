import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { LessonRouteDeps } from './routes/lessons.ts';
import { registerLessonRoutes } from './routes/lessons.ts';

export type BuildServerOptions = LessonRouteDeps;

export async function buildServer(options: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: true,
  });

  fastify.get('/api/v1/health', async () => {
    return { status: 'ok' };
  });

  registerLessonRoutes(fastify, options);

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
