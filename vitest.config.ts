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
  },
});
