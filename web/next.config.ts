import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { NextConfig } from 'next';

// The shared .env lives at the workspace root (one level up from `web/`).
// Next only auto-loads .env files from its own project directory, so pull
// in just the one variable this app needs. Deliberately NOT a generic env
// loader: web must never read DATABASE_URL (see CLAUDE.md architectural
// rules), so we parse this single key by name rather than importing the
// whole file into process.env.
const ROOT_ENV_PATH = path.resolve(import.meta.dirname, '..', '.env');

if (!process.env.NEXT_PUBLIC_API_BASE_URL && existsSync(ROOT_ENV_PATH)) {
  const match = readFileSync(ROOT_ENV_PATH, 'utf-8').match(/^NEXT_PUBLIC_API_BASE_URL=(.*)$/m);
  if (match?.[1] !== undefined) {
    process.env.NEXT_PUBLIC_API_BASE_URL = match[1].trim();
  }
}

const config: NextConfig = {
  output: 'standalone',
};

export default config;
