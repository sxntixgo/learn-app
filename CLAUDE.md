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
   Until Phase 6 `actor` is a hardcoded dev user and `can()` returns true. A handler that
   skips this is a bug, not a shortcut — it is what lets auth be deferred safely.
3. **`openapi/openapi.yaml` is the contract.** Client types are generated from it, never
   hand-written.
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
- Start the cluster if it is down: `sudo -n bash -c "su - postgres -c 'pg_ctl -D /var/lib/postgresql/17/main start'"`
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
