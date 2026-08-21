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

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 app && chown -R app:app /app

# Copy from builder
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/api ./api
COPY --from=builder --chown=app:app /app/tools ./tools
COPY --from=builder --chown=app:app /app/db ./db
COPY --from=builder --chown=app:app /app/schemas ./schemas
COPY --from=builder --chown=app:app /app/tsconfig*.json ./

USER app

# Health check
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD node -e "require('http').get('http://localhost:3001/api/v1/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Default to running the API
CMD ["node", "api/src/index.ts"]
