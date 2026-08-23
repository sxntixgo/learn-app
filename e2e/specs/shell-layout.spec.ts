import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * Layout properties of the shell that only a browser can check, each one
 * added after it was reported broken in a real deployment.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

async function signIn(page: Page) {
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

test.describe('the app shell', () => {
  for (const width of [375, 834, 1440]) {
    test(`${width}px: the footer reaches the bottom of the document`, async ({ browser }) => {
      // The bug: `.root[data-nav-visible='true']` reserved 72px of clearance
      // for the fixed mobile tab bar, and the desktop rule meant to cancel it
      // was `.root` — (0,1,0) against (0,2,0), so it never won. Measured 72px
      // of dead space below the footer at 1440 as well as at 375.
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await signIn(page);
        await page.waitForTimeout(300);

        const gap = await page.evaluate(() => {
          const footer = document.querySelector('footer')!.getBoundingClientRect();
          return Math.round(document.documentElement.scrollHeight - (footer.bottom + window.scrollY));
        });

        if (width < 768) {
          // Below 768 the tab bar is a fixed overlay, and the reservation is
          // deliberate — the footer must clear it rather than sit under it.
          expect(gap, 'the mobile tab bar needs its clearance').toBeGreaterThan(40);
        } else {
          // Above it the nav is an in-flow sidebar and nothing overlays.
          expect(gap, 'dead space below the footer').toBeLessThanOrEqual(1);
        }
      } finally {
        await context.close();
      }
    });
  }

  test('the sidebar never paints over the top bar when scrolled', async ({ browser }) => {
    // The bug: the sidebar kept the mobile rule's z-index 40 against the
    // banner's 30, and did not actually stick (align-self: stretch left it no
    // room), so it scrolled up behind the banner and painted over it.
    //
    // ASSERTED BY HIT-TESTING, NOT BY GEOMETRY. The first version of this
    // compared bounding boxes — nav.top >= banner.bottom — which passed
    // locally and failed in CI, where the seeded catalog is shorter. On a
    // short page the sidebar's flex container ends within the scroll, so the
    // sidebar correctly slides up with it and the boxes DO overlap. That is
    // sticky working, not the bug. What must never happen is the sidebar
    // being the thing you see there, and elementFromPoint answers exactly
    // that question.
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    try {
      const page = await context.newPage();
      await signIn(page);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(300);

      const result = await page.evaluate(() => {
        const banner = document.querySelector('header')!;
        const nav = document.querySelector('nav')!;
        const box = banner.getBoundingClientRect();
        // Well inside the banner, and horizontally over the sidebar's column.
        const hit = document.elementFromPoint(40, Math.round(box.top + box.height / 2));
        return {
          topmostIsBanner: hit === banner || banner.contains(hit),
          topmostIsNav: hit === nav || nav.contains(hit),
          hitTag: hit?.tagName ?? 'none',
          bannerZ: Number(getComputedStyle(banner).zIndex),
          navZ: Number(getComputedStyle(nav).zIndex),
        };
      });

      expect(result.topmostIsNav, 'the sidebar is painting over the banner').toBe(false);
      expect(result.topmostIsBanner, `expected the banner on top, got ${result.hitTag}`).toBe(true);
      // And the stacking order behind it, so a geometry change cannot undo it.
      expect(result.navZ).toBeLessThan(result.bannerZ);
    } finally {
      await context.close();
    }
  });

  test('the sidebar stays reachable while scrolling', async ({ browser }) => {
    // `position: sticky` was in the stylesheet and inert — with
    // `align-self: stretch` it filled its container and had nothing to stick
    // within. Asserted as behaviour rather than as a computed style so it
    // cannot silently stop working again.
    //
    // Tolerant of a short page on purpose: if there is nothing to scroll the
    // sidebar is trivially still there, and CI's catalog is shorter than a
    // developer's.
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    try {
      const page = await context.newPage();
      await signIn(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);

      const visible = await page.evaluate(() => {
        const rect = document.querySelector('nav')!.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });
      expect(visible, 'the sidebar scrolled entirely out of view').toBe(true);
      await expect(page.getByRole('link', { name: 'Catalog' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
