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

**Security Note**: This application has no authentication yet (see [docs/plans/2026-08-15-learning-platform-plan.md](./docs/plans/2026-08-15-learning-platform-plan.md) Phase 6). Do not expose publicly — use only in private networks or behind trusted access controls until authentication is implemented.
