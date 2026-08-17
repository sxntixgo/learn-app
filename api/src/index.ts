import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { registerSecurityHeaders } from './security-headers.ts';
import cookie from '@fastify/cookie';
import type { CourseRouteDeps } from './routes/courses.ts';
import { registerCourseRoutes } from './routes/courses.ts';
import type { ProgressRouteDeps } from './routes/progress.ts';
import { registerProgressRoutes } from './routes/progress.ts';
import type { QuizRouteDeps } from './routes/quiz.ts';
import { registerQuizRoutes } from './routes/quiz.ts';
import type { MeRouteDeps } from './routes/me.ts';
import { registerMeRoutes } from './routes/me.ts';
import type { AdminRouteDeps } from './routes/admin.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import type { SetupRouteDeps } from './routes/setup.ts';
import { registerSetupRoutes } from './routes/setup.ts';
import type { AuthRouteDeps } from './routes/auth.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerActorHook } from './auth/actor.ts';
import { getSigningKeys } from './auth/keys.ts';
import { hashPassword } from './auth/password.ts';
import { getPool } from './db.ts';
import { ensureSetupToken } from './auth/setup-token.ts';

// CourseRouteDeps, ProgressRouteDeps, MeRouteDeps, and AdminRouteDeps are
// structurally identical ({can?, actor?}) but declared separately in each
// route module (CLAUDE.md style: small modules, no speculative shared
// abstraction). One options bag satisfies all of them. SetupRouteDeps adds
// the password-hashing seam, and deliberately has no `actor` — see
// routes/setup.ts. AuthRouteDeps adds the rate limiter and signing keys.
export type BuildServerOptions = CourseRouteDeps &
  ProgressRouteDeps &
  QuizRouteDeps &
  MeRouteDeps &
  AdminRouteDeps &
  SetupRouteDeps &
  AuthRouteDeps & {
    /**
     * Whether to believe `X-Forwarded-For`. OFF unless explicitly enabled,
     * because a trusted-by-default proxy header lets any client forge the
     * address the login rate limiter counts against. Behind the design's
     * Caddy (§4) it must be on, or every request looks like it came from the
     * proxy and the per-IP limit collapses into a global one.
     */
    trustProxy?: boolean;
  };

export async function buildServer(options: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: true,
    trustProxy: options.trustProxy ?? process.env.API_TRUST_PROXY === 'true',
  });

  // Security response headers. Registered first so they apply to every
  // response, including ones short-circuited by a later hook or an error.
  registerSecurityHeaders(fastify);

  // Session cookies (design §13). Registered before the actor hook, which
  // reads request.cookies.
  await fastify.register(cookie);

  // CLAUDE.md rule 2, completed: `actor` is now resolved from the access
  // token on EVERY request — anonymous when there is no valid one — and
  // handlers keep asking can() exactly as they did in phase 1. No route
  // gained an authentication check of its own; that is the point.
  registerActorHook(fastify, { signingKeys: options.signingKeys });

  fastify.get('/api/v1/health', async () => {
    return { status: 'ok' };
  });

  registerCourseRoutes(fastify, options);
  registerProgressRoutes(fastify, options);
  registerQuizRoutes(fastify, options);
  registerMeRoutes(fastify, options);
  registerAdminRoutes(fastify, options);
  // The real Argon2id hasher fills the seam auth/bootstrap.ts left open, so
  // the first accounts are created with real credentials rather than the
  // NULL password_hash that means "cannot authenticate".
  registerSetupRoutes(fastify, { ...options, hashPassword: options.hashPassword ?? hashPassword });
  registerAuthRoutes(fastify, options);

  return fastify;
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const port = Number(process.env.API_PORT ?? 3001);
  const fastify = await buildServer();

  // Resolved at boot rather than on the first login, so a misconfigured or
  // unparseable signing key stops the process here — and so the ephemeral-key
  // warning is printed at startup where an operator will see it.
  getSigningKeys();

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
