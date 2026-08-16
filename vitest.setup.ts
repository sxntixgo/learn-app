import { existsSync } from 'node:fs';

// Tiny env loader: no dotenv dependency. Node's built-in loadEnvFile does the parsing.
// Guarded because CI / containers may already inject env vars without a .env file.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
