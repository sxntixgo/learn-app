import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['api/**/*.test.ts', 'tools/**/*.test.ts', 'web/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // DB-integration tests across api/ and tools/ all share one physical
    // TEST_DATABASE_URL and some (migrate/seed) DROP/CREATE the same tables.
    // Running test files in parallel races those against each other, so
    // files run one at a time; tests within a file are unaffected.
    fileParallelism: false,
    // Many tools tests spawn the real CLI as a subprocess — deliberately, so
    // they exercise the shipped binary rather than a reimplementation of it
    // (see tools/src/seed.test.ts, which once did the latter and would have
    // passed with seed.ts deleted). Each spawn pays Node start-up plus
    // TypeScript type-stripping, and as the codebase grew the 5s default
    // started failing them for timing rather than for behaviour.
    //
    // Raised deliberately rather than making those tests do less. A genuinely
    // hung test still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
