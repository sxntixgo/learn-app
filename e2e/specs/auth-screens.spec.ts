import { test, expect, type Locator, type Page } from '@playwright/test';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

/*
 * SIGN IN (PL1/P1) AND NO ACCESS — Phase 5's last task.
 *
 * The two screens differ in kind. `/login` is one of only six routes with a
 * real artboard; `/no-access` is on the spec's "no artboard — out of scope,
 * left as they are" list and is restyled here only because the repo owner
 * chose to (plan, Phase 5 header). Either way the spec's §6 per-screen detail
 * covers only Home and the lesson reader, so neither has a structural
 * write-up to transcribe — the standard is the app's own system.
 *
 * ACCEPTANCE: "both centre correctly at four widths". `toBeVisible()` cannot
 * make that claim — a full-bleed box and an off-centre box are both visible —
 * so this measures the rendered box against the viewport and asserts the left
 * and right gutters match. That is what "centred" means and it is the only
 * form of it a browser can be asked about.
 */

const WIDTHS = [
  { name: 'iPhone', width: 375, height: 812 },
  { name: 'iPad portrait', width: 834, height: 1194 },
  { name: 'iPad landscape', width: 1194, height: 834 },
  { name: 'Desktop', width: 1440, height: 900 },
] as const;

function tierOf(width: number): 'narrow' | 'wide' {
  return width >= NAV_SIDEBAR_FROM_PX ? 'wide' : 'narrow';
}

async function expectCentred(page: Page, target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox();
  expect(box, `${label} rendered no box`).not.toBeNull();
  if (!box) return;
  expect(box.width, `${label} collapsed`).toBeGreaterThan(0);
  expect(box.height, `${label} collapsed`).toBeGreaterThan(0);

  const viewport = page.viewportSize();
  expect(viewport, 'no viewport').not.toBeNull();
  if (!viewport) return;

  const left = box.x;
  const right = viewport.width - (box.x + box.width);

  // Sub-pixel layout rounding is real; a genuine centring bug is not within
  // 2px of symmetric.
  expect(
    Math.abs(left - right),
    `${label} is not centred: ${left.toFixed(1)}px left vs ${right.toFixed(1)}px right`,
  ).toBeLessThanOrEqual(2);

  // No page-level horizontal scroll, the same guarantee the rest of Phase 5
  // asserts.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflows, `${label} caused horizontal page scroll`).toBe(false);
}

test.describe('sign in and no-access centre at four widths', () => {
  for (const { name, width, height } of WIDTHS) {
    const tier = tierOf(width);

    test(`/login centres at ${width} (${name}, ${tier} tier)`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto('/login');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // `main` is `.page` — max-width 420px, margin 0 auto — which is the
        // element the centring actually lives on. The sign-in fields are a
        // client component nested inside it, so targeting the form would test
        // hydration timing rather than layout.
        await expectCentred(page, page.locator('main').first(), `/login main at ${width}`);
      } finally {
        await context.close();
      }
    });

    test(`/no-access centres at ${width} (${name}, ${tier} tier)`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto('/no-access');
        const heading = page.getByRole('heading', { level: 1 });
        await expect(heading).toBeVisible();
        await expectCentred(page, page.locator('main').first(), `/no-access main at ${width}`);
      } finally {
        await context.close();
      }
    });
  }
});
