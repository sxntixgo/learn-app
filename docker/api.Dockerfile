# Multi-stage build for the API and tools (migrations, seeds)
FROM node:22-slim AS builder

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace packages
COPY api/package.json api/
COPY tools/package.json tools/
COPY db/ db/

# schemas/*.json ARE READ AT RUNTIME, from disk, by
# api/src/content/validate.ts — they live at the repo root deliberately, so a
# future non-Node importer can read them without depending on this package
# (design §6.2). They were missing from this image, which would have taken
# the API down with ENOENT the first time anything imported content. Docker
# is not available in the dev container (CLAUDE.md), so nothing ever ran it.
COPY schemas/ schemas/

# Install dependencies (including both api and tools workspaces)
RUN npm ci --workspace=api --workspace=tools --omit=dev

# Copy source code
COPY api/src ./api/src
COPY tools/src ./tools/src
COPY tsconfig.base.json tsconfig.json ./
COPY api/tsconfig.json api/
COPY tools/tsconfig.json tools/

# Runtime stage
FROM node:22-slim

# git, because api/src/content/clone.ts SPAWNS IT at runtime to import a
# course from a git URL (design §5, the admin import screen). node:22-slim
# does not ship it, so that whole feature would have failed with ENOENT on
# first use — a runtime hole no amount of reading the Dockerfile reveals,
# since nothing in this file mentions git at all.
#
# ca-certificates so an https:// clone can verify anything.
#
# Deliberately NOT postgresql-client: tools/src/backup.ts spawns `pg_dump`,
# and pg_dump refuses to dump a server newer than itself, so this image would
# have to track the database's major version forever. The postgres:17 image
# already has matching tools — take backups from THERE:
#   docker compose exec learn-db pg_dump -U learn -Fc learn > learn.dump
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The node images already ship a non-root `node` user at UID 1000, so
# `useradd -m -u 1000 app` fails outright with "UID 1000 is not unique" — the
# build could never have reached this line. Use the user the base image gives
# us rather than minting a second one at the same id.
RUN chown -R node:node /app

# Copy from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/api ./api
COPY --from=builder --chown=node:node /app/tools ./tools
COPY --from=builder --chown=node:node /app/db ./db
COPY --from=builder --chown=node:node /app/schemas ./schemas
COPY --from=builder --chown=node:node /app/tsconfig*.json ./

USER node

# EXEC FORM, pointing at a committed script — no shell, no quoting, nothing
# for a copy-paste to mangle. The previous inline probe lost 29 characters
# somewhere between a compose file and a running container and failed with a
# SyntaxError eighteen times in a row while the API was healthy.
#
# It also targeted `localhost`, which can resolve to ::1 while this server
# listens on IPv4 only, and attached no error handler, so a refused
# connection during start-up was an uncaught exception rather than "not
# ready yet". api/src/healthcheck.ts handles both, and is tested.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "api/src/healthcheck.ts"]

# Default to running the API
CMD ["node", "api/src/index.ts"]
