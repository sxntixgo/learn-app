# Multi-stage build for the Next.js web app
FROM node:22-slim AS builder

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy web workspace
COPY web/package.json web/
COPY web/next.config.ts web/
COPY .env.example .env.example

# Install dependencies for web workspace
RUN npm ci --workspace=web --omit=dev

# Copy source code
COPY web/src ./web/src
COPY web/public ./web/public
COPY web/tsconfig.json web/
COPY tsconfig.base.json ./

# Build Next.js (output will be in web/.next with standalone mode)
WORKDIR /app/web
RUN npm run build

# Runtime stage
FROM node:22-slim

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 app && chown -R app:app /app

# Copy Next.js standalone output from builder
COPY --from=builder /app/web/.next/standalone /app
COPY --from=builder /app/web/public ./web/public
COPY --from=builder /app/web/.next/static ./web/.next/static

USER app

EXPOSE 3000

# Note: NEXT_PUBLIC_API_BASE_URL is set via docker-compose environment variables
# The web service intentionally does NOT receive DATABASE_URL (see docker-compose.yml)
# `web/server.js`, not `server.js`. This is a workspace build, so Next's
# standalone output preserves the workspace layout and puts the entry point at
# `.next/standalone/web/server.js` — which is also why the two COPY lines above
# target `./web/public` and `./web/.next/static`. Verified against a real
# `next build` here; `web/public/` did not exist as a tracked directory until
# Phase 14 added the PWA icons, so this path had never actually been exercised.
CMD ["node", "web/server.js"]
