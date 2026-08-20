# learn-app — conventions

A self-hosted learning platform. Read `docs/plans/2026-08-15-learning-platform-design.md`
for the design and `docs/plans/2026-08-15-learning-platform-plan.md` for the phased plan.
**Build only the phase you were asked for.**

## Stack (fixed — do not substitute)

| Concern | Choice |
|---|---|
| Runtime | Node 22, **ESM** (`"type": "module"`) everywhere |
| Language | TypeScript, `strict: true` |
| Repo | npm workspaces: `api/`, `web/`, `tools/` |
| API | Fastify 5 |
| Web | Next.js 15, App Router |
| DB | Postgres 17 via `pg` (node-postgres) |
| Migrations | **Plain SQL** in `db/migrations/NNNN_name.sql`, applied by our own runner. Never an ORM's migration tooling |
| Markdown | `unified` + `remark` + `rehype` |
| Highlighting | `shiki`, **at render time only** |
| Tests | `vitest` |
| Lint/format | `eslint` (flat config) + `prettier` |

## Architectural rules (from the design — violating these is a bug)

1. **`web` never receives `DATABASE_URL`.** It talks to the API over HTTP only.
2. **Every API handler takes an `actor` and calls `can(actor, action, resource)`.**
   As of Phase 6 both halves are real: `actor` comes from the access-token cookie (anonymous
   when there is none), and `can()` is the whole §5 matrix. A handler that skips this is a
   bug, not a shortcut. Three rules follow from it:
   - **Never write `if (!request.user) return 401` in a route.** Refusing an unauthenticated
     request is `can()`'s job; a local check moves the decision out of the tested module.
   - **The action vocabulary is closed** (`Action` in `api/src/policy/can.ts`). A new action
     needs a row in `MATRIX` and a case in the matrix test, or it is denied for everyone.
   - **Course- and user-scoped actions need context**: pass `{ course: { ownerId } }` (from
     `courses.owner_id`) and/or `{ userId }`. Omitting it denies — that is deliberate.
3. **`openapi/openapi.yaml` is the contract.** Client types are generated from it, never
   hand-written.
   - **Declare the path BEFORE implementing the route, not after.** This has drifted three
     times — `annotations` on `CodeBlock` (live since Phase 2, undeclared), the four
     `/auth/*` endpoints (live since Phase 6, so the contract claimed this API had no
     authentication), and the submission routes. Each time the web side worked around it
     with a local type, which is the symptom to watch for: if you are hand-writing a
     response type, the contract is wrong.
   - `gen:api:check` catches a *stale generated file*, not a *missing path*. Nothing
     automatically detects a route that was never declared, so it is on you.
4. **Syntax highlighting happens at render time**, never at import time.
5. **Content is stored as a typed block array**, not as HTML or a rehype AST.
6. Postgres is the only stateful service.

## Conventions learned in Phase 1 (follow these)

- **Relative imports use `.ts` extensions**, not `.js`. `tsconfig.base.json` sets
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (TS 5.7+). This is what
  lets `node api/src/index.ts` run sources directly. Writing `./foo.js` will pass the test
  suite — vitest silently resolves it — and then fail at runtime. Do not reintroduce it.
- **Verify by running the real thing, not just the tests.** Two Phase 1 defects passed a
  green suite: an unbootable server, and a staleness check that could only ever pass.
- **`gen:api:check` requires `web/src/lib/api-types.ts` to be tracked by git.** It fails
  loudly if not, because `git diff` against an untracked file is silently vacuous.
- **Vitest runs with `fileParallelism: false`** — the DB-touching test files share one test
  database and race otherwise.
- Test databases: apply migrations first, and clean up rows you create.
- **`npm run typecheck` does NOT cover `web/`.** Next generates its own tsconfig outside the
  root project's references, so `next build` is the only thing that type-checks the web app.
  CI runs it (added Phase 9, after nine phases in which web type errors could reach `main`
  undetected). When verifying web work, run `cd web && npx next build` — a clean
  `npm run typecheck` says nothing about it.

## Public repository

This repo is public.

- No secrets in tracked files. `.env` is gitignored; `.env.example` holds placeholders only.
- No personal email addresses anywhere.
- No committed database dumps or fixtures containing real accounts.
- Never default a secret in code (no `SECRET = "changeme"` fallback).

## Local development environment

Docker is **not** available in this dev container. Postgres runs natively.

- Databases: `learn_dev`, `learn_test`; role `learn`
- Connection string lives in `.env` (gitignored)
- Start the cluster if it is down:

  ```bash
  # A container restart leaves a STALE postmaster.pid behind, and pg_ctl then
  # refuses with "another server might be running". Check the pid is really
  # dead (`kill -0 <pid>`) before removing it.
  sudo -n rm -f /var/lib/postgresql/17/main/postmaster.pid
  sudo -n bash -c "su - postgres -c '/usr/lib/postgresql/17/bin/pg_ctl \
    -D /var/lib/postgresql/17/main \
    -o \"-c config_file=/etc/postgresql/17/main/postgresql.conf\" \
    -l /var/lib/postgresql/pg.log start'"
  ```

  Three things the obvious command gets wrong: `pg_ctl` is not on the
  `postgres` login shell's PATH, the data directory has no `postgresql.conf`
  (it lives at the Debian path, hence `-o config_file`), and the stale pidfile
  above. Without the cluster, every DB-touching test fails for reasons that
  look nothing like "the database is down".
- `docker/` files are authored here but verified on the WSL host

## Commands

```
npm test              # vitest, all workspaces
npm run lint
npm run typecheck
npm run gen:api       # regenerate client types from openapi/openapi.yaml
```

## Style

- Test-first: a failing test before the code that satisfies it
- Small modules, explicit names, no speculative abstraction (YAGNI)
- Match surrounding code; do not introduce a second way of doing something
