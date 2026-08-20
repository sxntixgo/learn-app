import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Phase 15 task 1: the Playwright harness — the foundation later tasks
// (core journeys, viewport specs, accessibility) build on. See CLAUDE.md and
// docs/plans/2026-08-15-learning-platform-plan.md's "Phase 15" section for
// what this is and isn't responsible for.
//
// Root-level `e2e/`, not a fourth npm workspace (CLAUDE.md: the workspace
// list — api/, web/, tools/ — is fixed). Specs are named `*.spec.ts`, never
// `*.test.ts`, so vitest.config.ts's explicit `include` list never collects
// them and this suite never collects vitest's.
//
// Same env-loading idiom as vitest.setup.ts: no dotenv dependency, guarded
// because CI sets these directly (job-level env in .github/workflows/ci.yml)
// and has no .env file to load.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. The Playwright harness runs the API and web app against a seeded ' +
      'TEST database, never against DATABASE_URL/dev data — set TEST_DATABASE_URL in .env (local) or ' +
      'the job env (CI).',
  );
}

// Dedicated, non-default ports so this never collides with a `next dev` /
// `api dev` instance a developer already has running on 3000/3001.
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // "No flake across three runs" (Phase 15's acceptance criterion) is a
  // property this harness has to earn by being deterministic, not a retry
  // budget that papers over the lack of one. One CI retry stays on as the
  // same kind of insurance any browser suite carries against a scheduler
  // hiccup that has nothing to do with the app; the three-runs check this
  // task was verified with counted a run as green only with retries off.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Chromium only — task 1's explicit decision. Firefox/WebKit are not
    // installed; installing three browser engines is out of scope here.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // The API: migrations, then fixture seeding, then listen. Both run
      // against TEST_DATABASE_URL only — tools/src/e2e-seed.ts's own safety
      // guard independently refuses to run against any database whose name
      // doesn't say "test", since it deletes rows to stay idempotent.
      command: 'npm run migrate && node tools/src/e2e-seed.ts && node api/src/index.ts',
      url: `${API_BASE_URL}/api/v1/health`,
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        API_PORT: String(API_PORT),
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The web app, rebuilt for this run rather than reusing whatever CI's
      // separate "Build web" step (ci.yml) produced.
      //
      // WHY REBUILD RATHER THAN JUST `next start` AGAINST AN EXISTING
      // `.next/`: `NEXT_PUBLIC_API_BASE_URL` is inlined into the bundle at
      // `next build` time — Next statically replaces every
      // `process.env.NEXT_PUBLIC_*` reference at build time, server code
      // included. Verified empirically while building this harness: booting
      // a prebuilt `.next` with a *different* `NEXT_PUBLIC_API_BASE_URL` at
      // `next start` keeps calling the build-time host and ignores the
      // runtime one entirely (a plain env override does nothing). CI's
      // "Build web" step exists only to type-check the app (CLAUDE.md:
      // `next build` is the only thing that type-checks web/) and never sets
      // this var, so its `.next` isn't reusable here — this config does its
      // own build, with the real API port above baked in.
      //
      // WHY `next start` AND NOT THE STANDALONE SERVER: `web/next.config.ts`
      // sets `output: 'standalone'`, and `.next/standalone/web/server.js` is
      // the runtime entry point Next's own docs call correct for it — but
      // standalone output ships without `public/` or `.next/static`, which
      // have to be located and copied alongside by hand (and, being a
      // workspace build, land nested under `standalone/web/`). `next start`
      // prints a warning that it "does not work with output: standalone" but
      // was confirmed, by hand and then by this harness's own runs, to serve
      // the app correctly anyway. For a harness whose only job is running
      // the already-built app, that warning isn't worth the extra
      // copy-and-relocate step it would take to silence.
      //
      // WHY `env -u DATABASE_URL`: CLAUDE.md rule 1 — web must NEVER receive
      // DATABASE_URL. This process's own env has it (ci.yml sets
      // DATABASE_URL at job level for `npm run migrate`; locally it comes
      // from `.env`), and Playwright's `webServer.env` only ADDS to a
      // command's inherited environment, it doesn't isolate it — so without
      // this, the web server would inherit DATABASE_URL from this config's
      // own process despite never being handed it directly. Explicitly
      // unsetting it here is what actually enforces the rule, not just
      // omitting it from `env` below.
      command: 'env -u DATABASE_URL npm run build --workspace web && env -u DATABASE_URL npm run start --workspace web',
      url: WEB_BASE_URL,
      env: {
        NEXT_PUBLIC_API_BASE_URL: API_BASE_URL,
        PORT: String(WEB_PORT),
      },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
