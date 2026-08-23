import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * The account menu behind the name in the banner.
 *
 * Built on <details>/<summary>, so most of what a menu needs — keyboard
 * operation, expanded state, focus order — comes from the element rather than
 * from code. These tests check the parts that do NOT come free: what is in
 * it, who sees which entries, and that it dismisses.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

async function asStudent<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, fixtures.viewportUser.email, fixtures.viewportUser.password);
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe('the account menu', () => {
  test('starts closed, and the name opens it', async ({ browser }) => {
    await asStudent(browser, async (page) => {
      const menu = page.locator('details').first();

      // Closed on load: the panel must not be covering the page before
      // anyone asks for it.
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();

      await menu.locator('summary').click();
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
    });
  });

  test('offers profile, settings, theme and sign out', async ({ browser }) => {
    await asStudent(browser, async (page) => {
      await page.locator('details').first().locator('summary').click();

      await expect(page.getByRole('link', { name: 'Your profile' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Profile & visibility' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Account & password' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      // The theme control moved in here from the banner.
      await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
    });
  });

  test('“Your profile” goes to the public page, not the settings screen', async ({ browser }) => {
    // The reported gap: the profile existed but was reachable only from the
    // dashboard.
    await asStudent(browser, async (page) => {
      await page.locator('details').first().locator('summary').click();
      await page.getByRole('link', { name: 'Your profile' }).click();
      await expect(page).toHaveURL(/\/u\/[a-z0-9-]+$/);
      await expect(page).not.toHaveURL(/no-access|login/);
    });
  });

  test('closes on Escape, and returns focus to the control', async ({ browser }) => {
    await asStudent(browser, async (page) => {
      const menu = page.locator('details').first();
      await menu.locator('summary').click();
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

      await page.keyboard.press('Escape');
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
      // A keyboard user must not be dumped at the top of the document.
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('SUMMARY');
    });
  });

  test('closes when you click away from it', async ({ browser }) => {
    await asStudent(browser, async (page) => {
      const menu = page.locator('details').first();
      await menu.locator('summary').click();
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

      await page.locator('h1').first().click();
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
    });
  });

  test('is operable by keyboard alone', async ({ browser }) => {
    // The whole reason for <details>: none of this is implemented here.
    await asStudent(browser, async (page) => {
      const menu = page.locator('details').first();
      await menu.locator('summary').focus();
      await page.keyboard.press('Enter');
      expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      expect(focused.length, 'Tab should land on the first item in the panel').toBeGreaterThan(0);
    });
  });

  test('hides the learner entries from an operator account', async ({ browser }) => {
    // §5.1: operator accounts have no public profile, and /settings/profile is
    // student-only. Offering either would send an admin to /no-access.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page, fixtures.adminUser.email, fixtures.adminUser.password);
      await page.locator('details').first().locator('summary').click();

      await expect(page.getByRole('link', { name: 'Your profile' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Profile & visibility' })).toHaveCount(0);
      // But the entries that work for everyone are still there.
      await expect(page.getByRole('link', { name: 'Account & password' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('signing out still works from inside the menu', async ({ browser }) => {
    await asStudent(browser, async (page) => {
      await page.locator('details').first().locator('summary').click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/login/);
    });
  });
});
