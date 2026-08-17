# Learn App

A self-hosted learning platform. See [docs/plans/](./docs/plans/) for design and phased implementation plan.

## Directory Layout

```
.
├── api/              # Fastify API server
├── web/              # Next.js frontend
├── tools/            # Utility scripts and helpers
├── docs/             # Documentation and plans
└── package.json      # Root workspaces configuration
```

## Commands

```bash
# Install dependencies
npm install

# Run tests (api, tools)
npm test

# Type checking
npm run typecheck

# Linting
npm run lint

# Formatting
npm run format
```

## Development

Each workspace has its own `package.json`. The root coordinates builds and testing via npm workspaces.

- **API**: `cd api && npm run dev` (or `npm run build` for production)
- **Web**: `cd web && npm run dev` (or `npm run build` for production)

## Running with Docker

To run the full stack with Docker Compose:

1. Copy `.env.example` to `.env` and adjust values if needed:
   ```bash
   cp .env.example .env
   ```

2. Start the stack:
   ```bash
   docker compose -f docker/docker-compose.yml up
   ```

   This starts:
   - PostgreSQL 17 database
   - Database migrations (one-shot, runs on startup)
   - API server (http://localhost:3001)
   - Web frontend (http://localhost:3000)

3. To expose the application via reverse proxy, add the Caddy snippet to your Caddyfile:
   ```bash
   cat docker/Caddyfile.example
   ```

## Backups

Postgres is the only stateful service (`CLAUDE.md`). Content, progress, avatars,
credentials — everything the app knows lives in the database, so a `pg_dump` of it
is genuinely a backup of the whole instance, not just "the data we remembered to
include." There is no separate file store to back up alongside it.

**Taking a backup:**

```bash
npm run backup                        # writes to ./backups/, keeps the newest 7
npm run backup -- --out /mnt/backups --keep 30
```

This runs `pg_dump -Fc` (Postgres's custom format — compressed, and restorable
selectively with `pg_restore`, unlike a plain `.sql` dump) against `DATABASE_URL`
and writes a timestamped file: `backups/learn-app-YYYYMMDD-HHMMSS.dump`. After
writing the new dump it prunes `--out` down to the newest `--keep` files (default
7) — and only ever deletes files matching its own `learn-app-<timestamp>.dump`
naming pattern, never anything else that happens to be in that directory.

**Restoring — READ THIS FIRST: restore is destructive and irreversible.**
`pg_restore` overwrites whatever is in the target database. Point it at the wrong
`DATABASE_URL` and you have destroyed real data, not a copy of it.

```bash
npm run restore -- ./backups/learn-app-20260815-030000.dump --into <database-url>
```

By default, restore **refuses to run against a database that already has any
tables** — that guard is the point, not a formality, and it exists specifically so
a mistyped connection string fails loudly instead of quietly clobbering live data.
To intentionally overwrite an existing database (disaster recovery, rebuilding a
scratch environment from a production dump), pass `--force` explicitly:

```bash
npm run restore -- ./backups/learn-app-20260815-030000.dump --into <database-url> --force
```

`tools/src/restore.test.ts` is the proof this loop actually works, not just that
the scripts run without error: it populates a scratch database across `users`,
`courses`, `modules`, `lessons`, `lesson_progress`, `activity_events`,
`enrollments`, and `user_roles`, backs it up, restores the dump into a second
fresh database, and asserts row counts *and* a content checksum match per table.
It also confirms the restore doesn't just copy rows but preserves real schema
behavior — `activity_events`'s append-only trigger and `user_roles`'s
admin-exclusivity constraint both still reject the operations they're supposed to
reject after a round trip through backup and restore.

An untested restore is not a backup, it's a hope — restore this into a scratch
database occasionally and confirm the app actually comes up against it, not just
that `pg_restore` exited zero.
