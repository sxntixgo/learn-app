/**
 * Screenshot Capture for Design Verification (Phase 6)
 *
 * This spec captures every route at 4 widths × 2 themes into docs/design/screenshots/
 * for comparison against the artboards.
 *
 * DESIGN DECISION: Runs on-demand only (not part of npx playwright test)
 * because capture adds minutes and repository weight. The script is self-contained,
 * deterministic, and idempotent — always safe to re-run to refresh screenshots.
 * Use: npx playwright test --project=chromium capture-screenshots
 *
 * Routes:
 * - With artboards (full 4×2): /, /login, /search, /settings/profile, /settings/account, /u/[handle]
 * - Without artboards (sample only): /me, /grading, /admin/imports
 * - Explicitly excluded: /invite/[token] (burns token on first visit), others noted below
 */

import { test, Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2E_VIEWPORT_EMAIL,
  E2E_VIEWPORT_HANDLE,
  E2E_VIEWPORT_PASSWORD,
} from '../../tools/src/e2e-seed.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '../../docs/design/screenshots');

// Viewport sizes: 375 (phone), 834 (tablet portrait), 1194 (iPad landscape), 1440 (desktop)
const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '834', width: 834, height: 1194 },
  { name: '1194', width: 1194, height: 834 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const THEMES = ['light', 'dark'] as const;

// Routes with artboards (full 4×2 coverage)
const ARTBOARD_ROUTES = [
  { name: 'home', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'search', path: '/search' },
  { name: 'settings-profile', path: '/settings/profile' },
  { name: 'settings-account', path: '/settings/account' },
  { name: 'profile', path: `/u/${E2E_VIEWPORT_HANDLE}` },
];

// Routes without artboards (sample only for record-keeping)
const SAMPLE_ROUTES = [
  { name: 'me', path: '/me' },
  { name: 'grading', path: '/grading' },
  { name: 'admin-imports', path: '/admin/imports' },
];

/**
 * Set the data-theme attribute to control light/dark appearance.
 * Note: This overrides prefers-color-scheme preference.
 */
async function setTheme(page: Page, theme: string) {
  await page.evaluate((t: string) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

test.describe('capture-screenshots', () => {
  test.beforeAll(async () => {
    // Ensure output directory exists
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  });

  // Run on-demand only: npx playwright test --project=chromium capture-screenshots
  // Rationale: ~120s runtime + 60 PNG files (>50MB) adds too much to every run.
  // Idempotent and deterministic, so safe to refresh anytime before Gate 6.
  test.skip('capture all artboard routes at 4 widths × 2 themes', async ({
    browser,
    baseURL,
  }, testInfo) => {
    // Increase timeout: 6 routes × 4 widths × 2 themes = 48 screenshots
    // ~1s per screenshot + navigation overhead ≈ 60-90s needed
    testInfo.setTimeout(120000);
    // Create authenticated context (all routes work while signed in)
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // Sign in
    await page.goto('/login');
    await page.getByLabel('Email').fill(E2E_VIEWPORT_EMAIL);
    await page.getByLabel('Password').fill(E2E_VIEWPORT_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('/');

    // Capture each artboard route
    for (const route of ARTBOARD_ROUTES) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.goto(route.path);
          await setTheme(page, theme);

          // Wait for page to stabilize
          await page.waitForLoadState('networkidle');

          const filename = `${route.name}-${viewport.name}-${theme}.png`;
          const filepath = path.join(SCREENSHOTS_DIR, filename);
          await page.screenshot({ path: filepath });
          console.log(`✓ ${filename}`);
        }
      }
    }

    await context.close();
  });

  test.skip('capture sample routes (no artboards) at 2 widths × 2 themes', async ({
    browser,
    baseURL,
  }, testInfo) => {
    testInfo.setTimeout(120000);

    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // Sign in
    await page.goto('/login');
    await page.getByLabel('Email').fill(E2E_VIEWPORT_EMAIL);
    await page.getByLabel('Password').fill(E2E_VIEWPORT_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('/');

    // Capture sample routes for record (no artboards, but good for regression checking)
    // Use 375/1440 widths only (narrow/wide tiers) to keep total count manageable
    const sampleViewports = [VIEWPORTS[0], VIEWPORTS[3]];

    console.log('\nCapturing sample routes (no artboards)...');
    for (const route of SAMPLE_ROUTES) {
      for (const viewport of sampleViewports) {
        for (const theme of THEMES) {
          try {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto(route.path);
            await setTheme(page, theme);
            await page.waitForLoadState('networkidle');

            const filename = `${route.name}-${viewport.name}-${theme}.png`;
            const filepath = path.join(SCREENSHOTS_DIR, filename);
            await page.screenshot({ path: filepath });
            console.log(`✓ ${filename}`);
          } catch (e) {
            console.log(`⚠ ${route.name}-${viewport.name}-${theme}: ${e}`);
          }
        }
      }
    }

    await context.close();
  });
});
