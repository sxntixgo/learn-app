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

# Health check
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD node -e "require('http').get('http://localhost:3001/api/v1/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Default to running the API
CMD ["node", "api/src/index.ts"]
