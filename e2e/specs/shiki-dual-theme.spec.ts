import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * SHIKI DUAL-THEME PARITY — explicit data-theme choice beats OS preference.
 *
 * Phase 3 task "Shiki dual-theme parity" (docs/plans/2026-09-02-design-import-plan.md,
 * Phase 3). The design did NOT move either code theme (artboard-spec §8: "Shiki-at-render-time"
 * is listed under "What did not change"), but nothing currently PROVES that an explicit
 * `data-theme` choice overrides the OS preference in code blocks.
 *
 * WHAT THIS SPEC TESTS. The `.shiki` rules in app/globals.css have three blocks:
 * 1. Default: `--shiki-light` and `--shiki-light-bg`
 * 2. `@media (prefers-color-scheme: dark)` guarded by `html:not([data-theme='light'])`: uses dark
 * 3. `html[data-theme='dark']`: uses dark unconditionally
 *
 * The bug this guards against: an explicit user choice losing to the OS setting when the
 * media-query guard is improper or specificity lands the wrong way.
 *
 * ACCEPTANCE. A spec sets `data-theme='dark'` under a light OS preference and asserts
 * the `.shiki` background is the dark token. The reverse pairing (colorScheme: 'dark' with
 * data-theme='light' giving light) is also tested, since a rule that ignores the OS in one
 * direction can still lose in the other.
 */

const fixtures: E2eFixtures = JSON.parse(
  readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'),
);

const LESSON = `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`;

// One sign-in for the file, reused via storageState.
let authState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent(LESSON)}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`${LESSON}$`));
  authState = await context.storageState();
  await context.close();
});

/**
 * Navigate to the lesson, set OS preference and explicit theme, and read the
 * computed background color of the first .shiki block.
 */
async function getShikiBackgroundColor(
  browser: Browser,
  baseURL: string | undefined,
  osPreference: 'light' | 'dark',
  explicitTheme: 'light' | 'dark',
): Promise<string> {
  const context = await browser.newContext({
    baseURL,
    storageState: authState,
    colorScheme: osPreference,
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await context.newPage();
    await page.goto(LESSON);

    // Set explicit theme choice
    await page.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
    }, explicitTheme);

    // Wait for fonts and code blocks to render
    await page.evaluate(() => document.fonts.ready);

    // AnnotatableCode renders spans with class="shiki", find the section that has them
    try {
      await page.locator('section:has(> div.shiki)').first().waitFor({ timeout: 5000 });
    } catch {
      // Fallback: just look for any div with class shiki
      try {
        await page.locator('div.shiki').first().waitFor({ timeout: 5000 });
      } catch {
        throw new Error('no annotatable code section found (timeout 5s)');
      }
    }

    // Extract the computed background color of the first span.shiki element
    // Note: the background color comes from the CSS rules in globals.css that use the --shiki-*-bg variables
    const bgColor = await page.evaluate(() => {
      const shikiSpan = document.querySelector('div.shiki');
      if (!shikiSpan) throw new Error('no div.shiki element found on the page');
      return window.getComputedStyle(shikiSpan).backgroundColor;
    });

    return bgColor;
  } finally {
    await context.close();
  }
}

/**
 * Extract the --shiki-* variables from a .shiki element to know what colors
 * we expect at each theme. Also compute their RGB values for comparison.
 */
async function getShikiTokens(browser: Browser, baseURL: string | undefined): Promise<{
  lightBgHex: string;
  darkBgHex: string;
  lightBgRgb: string;
  darkBgRgb: string;
}> {
  const context = await browser.newContext({
    baseURL,
    storageState: authState,
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await context.newPage();
    await page.goto(LESSON);

    // Get the CSS custom properties and their computed RGB values
    const tokens = await page.evaluate(() => {
      // AnnotatableCode renders the Shiki HTML by splitting it and rendering each line
      // with className="shiki" in a <section> that has the style with --shiki-* props.
      // We look for the section that has these custom properties set.
      const sections = document.querySelectorAll('section');
      let shikiSection: Element | null = null;

      for (const section of sections) {
        const style = section.getAttribute('style') || '';
        if (style.includes('--shiki-light-bg') && style.includes('--shiki-dark-bg')) {
          shikiSection = section;
          break;
        }
      }

      if (!shikiSection) {
        throw new Error('no section with --shiki-light-bg and --shiki-dark-bg found on the page');
      }

      // Read the inline style attributes that Shiki sets
      const style = shikiSection.getAttribute('style') || '';

      // Extract the --shiki-* values using regex
      const lightBgMatch = style.match(/--shiki-light-bg:\s*([^;]+)/);
      const darkBgMatch = style.match(/--shiki-dark-bg:\s*([^;]+)/);

      if (!lightBgMatch || !darkBgMatch) {
        throw new Error(
          `shiki tokens not found in style="${style}". Expected --shiki-light-bg and --shiki-dark-bg.`,
        );
      }

      const lightBgHex = (lightBgMatch[1] ?? '').trim();
      const darkBgHex = (darkBgMatch[1] ?? '').trim();

      // Convert hex to RGB for comparison (Playwright returns computed colors as rgb(...))
      const hexToRgb = (hex: string): string => {
        // Handle both #fff and #ffffff formats
        let normalized = hex.replace('#', '');
        if (normalized.length === 3) {
          normalized = normalized.split('').map((c) => c + c).join('');
        }
        const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
        const [, r, g, b] = result ?? [];
        if (r === undefined || g === undefined || b === undefined) {
          throw new Error(`Invalid hex color: ${hex}`);
        }
        return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
      };

      return {
        lightBgHex,
        darkBgHex,
        lightBgRgb: hexToRgb(lightBgHex),
        darkBgRgb: hexToRgb(darkBgHex),
      };
    });

    return tokens;
  } finally {
    await context.close();
  }
}

test.describe('Shiki dual-theme parity', () => {
  test('explicit dark theme overrides light OS preference', async ({ browser, baseURL }) => {
    const tokens = await getShikiTokens(browser, baseURL);

    // When OS prefers light but we explicitly set data-theme='dark',
    // the code block's background (computed from --shiki-dark-bg) should use the dark token value.
    const bgColor = await getShikiBackgroundColor(browser, baseURL, 'light', 'dark');

    // The computed background should match the dark theme color (compare as RGB)
    expect(bgColor).toBe(tokens.darkBgRgb);
  });

  test('explicit light theme overrides dark OS preference', async ({ browser, baseURL }) => {
    const tokens = await getShikiTokens(browser, baseURL);

    // When OS prefers dark but we explicitly set data-theme='light',
    // the code block's background (computed from --shiki-light-bg) should use the light token value.
    const bgColor = await getShikiBackgroundColor(browser, baseURL, 'dark', 'light');

    // The computed background should match the light theme color (compare as RGB)
    expect(bgColor).toBe(tokens.lightBgRgb);
  });
});
