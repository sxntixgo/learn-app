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

  test('the sidebar never covers the top bar when scrolled', async ({ browser }) => {
    // The bug: the sidebar kept the mobile rule's z-index 40 against the
    // banner's 30, and did not actually stick (align-self: stretch left it no
    // room), so it scrolled up behind the banner and painted over it.
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    try {
      const page = await context.newPage();
      await signIn(page);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(300);

      const { bannerBottom, navTop, bannerZ, navZ } = await page.evaluate(() => {
        const banner = document.querySelector('header')!;
        const nav = document.querySelector('nav')!;
        return {
          bannerBottom: Math.round(banner.getBoundingClientRect().bottom),
          navTop: Math.round(nav.getBoundingClientRect().top),
          bannerZ: Number(getComputedStyle(banner).zIndex),
          navZ: Number(getComputedStyle(nav).zIndex),
        };
      });

      // Geometry: the sidebar starts at or below the banner, so they cannot
      // occupy the same pixels at all.
      expect(navTop, 'the sidebar is overlapping the banner').toBeGreaterThanOrEqual(bannerBottom);
      // And stacking, so that even a future geometry change cannot put the
      // sidebar in front.
      expect(navZ).toBeLessThan(bannerZ);
    } finally {
      await context.close();
    }
  });

  test('the sidebar stays on screen while scrolling, rather than scrolling away', async ({ browser }) => {
    // `position: sticky` was in the stylesheet and inert. Asserted as
    // behaviour so it cannot silently stop working again.
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    try {
      const page = await context.newPage();
      await signIn(page);
      await page.evaluate(() => window.scrollTo(0, 800));
      await page.waitForTimeout(300);

      const nav = await page.locator('nav').boundingBox();
      expect(nav!.y, 'the sidebar scrolled off the top').toBeGreaterThanOrEqual(0);
      await expect(page.getByRole('link', { name: 'Catalog' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
