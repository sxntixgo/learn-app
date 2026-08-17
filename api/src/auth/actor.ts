import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../policy/can.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import { verifyAccessToken } from './access-token.ts';
import type { SigningKeys } from './keys.ts';
import { getSigningKeys } from './keys.ts';
import { ACCESS_COOKIE } from './cookies.ts';

// Populating `actor` (CLAUDE.md rule 2, design §5.2).
//
// Phases 1–5 registered routes with a hardcoded DEV_ACTOR. This hook is what
// replaces it: one onRequest hook, running before every handler, that turns
// the access-token cookie into an `Actor` and attaches it to the request.
//
// THE IMPORTANT PART: a request with no token, an expired token, or a forged
// one gets the ANONYMOUS actor — never a bypass, and never a null that a
// handler has to remember to check. `can()` then decides, in the one module
// that is tested against the design's permission matrix. That is why no
// route in this codebase contains an `if (!signedIn) return 401`: adding one
// would move an authorization decision out of the policy module, which is
// exactly the rot design §5.2 says the seam exists to prevent.

/** Where the resolved actor is really stored; `request.actor` is its accessor. */
const RESOLVED = Symbol.for('learn-app.actor');

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved by the hook below. Never undefined, never null; anonymous when unauthenticated. */
    actor: Actor;
    [RESOLVED]: Actor | null;
  }
}

export interface ActorHookOptions {
  /** Test/dev seam for the signing keys. Production resolves them from env. */
  signingKeys?: SigningKeys;
}

/** Resolves the actor for one request. Exported for direct testing. */
export async function resolveActor(request: FastifyRequest, options: ActorHookOptions = {}): Promise<Actor> {
  const token = request.cookies?.[ACCESS_COOKIE];
  if (typeof token !== 'string' || token === '') return ANONYMOUS_ACTOR;

  const claims = await verifyAccessToken(token, options.signingKeys ?? getSigningKeys());
  if (!claims) return ANONYMOUS_ACTOR;

  return { id: claims.userId, roles: claims.roles };
}

/** Installs the onRequest hook that populates `request.actor`. */
export function registerActorHook(fastify: FastifyInstance, options: ActorHookOptions = {}): void {
  // Declared up front so every request carries the property in its shape.
  // Fastify 5 refuses a shared object as a decorator value (every request
  // would alias the same instance), so the default is null and the getter
  // below turns that into the anonymous actor: if this hook were ever
  // skipped for a route, the fallback is "nobody", not "undefined behaviour
  // further down".
  fastify.decorateRequest(RESOLVED, null);
  fastify.decorateRequest('actor', {
    getter(this: FastifyRequest): Actor {
      return this[RESOLVED] ?? ANONYMOUS_ACTOR;
    },
    setter(this: FastifyRequest, actor: Actor): void {
      this[RESOLVED] = actor;
    },
  });

  fastify.addHook('onRequest', async (request) => {
    request.actor = await resolveActor(request, options);
  });
}

/**
 * The actor a route handler should use.
 *
 * `deps.actor` is a TEST seam and nothing else — no production wiring passes
 * it (see api/src/index.ts). It comes first so a route test can exercise its
 * own behaviour with a chosen actor instead of minting a real token; every
 * real request falls through to the hook's answer, and to ANONYMOUS_ACTOR
 * when there is no valid session.
 */
export function actorFor(request: FastifyRequest, deps: { actor?: Actor } = {}): Actor {
  return deps.actor ?? request.actor ?? ANONYMOUS_ACTOR;
}
