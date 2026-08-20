import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

// Web UI for account data export and account deletion (plan: "Account
// deletion and data export"). Same shape as search.spec.ts: `mode: 'serial'`,
// sign in once per role in `beforeAll` for the read-only checks, hand every
// test a fresh context seeded from the captured storageState — never a
// per-test login (each is a real Argon2id hash, deliberately expensive,
// design §13). The one genuinely destructive test signs in on its own,
// separately, into `fixtures.deletableUser` — a disposable account seeded
// (tools/src/e2e-seed.ts) with no other spec depending on it, so deleting it
// here never breaks viewport.spec.ts / a11y.spec.ts, which both depend on
// `viewportUser` staying alive across the whole suite.
const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

test.describe.configure({ mode: 'serial' });

let studentState: Awaited<ReturnType<BrowserContext['storageState']>>;
let teacherState: Awaited<ReturnType<BrowserContext['storageState']>>;
let adminState: Awaited<ReturnType<BrowserContext['storageState']>>;

async function signIn(browser: Browser, baseURL: string | undefined, email: string, password: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ browser, baseURL }) => {
  studentState = await signIn(browser, baseURL, fixtures.viewportUser.email, fixtures.viewportUser.password);
  teacherState = await signIn(browser, baseURL, fixtures.teacherUser.email, fixtures.teacherUser.password);
  adminState = await signIn(browser, baseURL, fixtures.adminUser.email, fixtures.adminUser.password);
});

async function withPage<T>(
  browser: Browser,
  baseURL: string | undefined,
  state: Awaited<ReturnType<BrowserContext['storageState']>> | null,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: state ?? undefined });
  try {
    const page = await context.newPage();
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe('the entry point is reachable from each eligible role, from its own settings home', () => {
  test('a student reaches it from /settings/profile', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto('/settings/profile');
      const link = page.getByRole('link', { name: 'Export my data or delete my account' });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/settings\/account$/);
      await expect(page.getByRole('link', { name: 'Download my data' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Permanently delete my account' })).toBeVisible();
    });
  });

  test('a teacher-only account reaches it from /grading — /me and /settings/profile 403 for it', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, teacherState, async (page) => {
      await page.goto('/grading');
      const link = page.getByRole('link', { name: 'Export my data or delete my account' });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/settings\/account$/);
      await expect(page.getByRole('link', { name: 'Download my data' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Permanently delete my account' })).toBeVisible();
    });
  });
});

test.describe('the destructive control is not reachable by an account that cannot use it', () => {
  test('an admin account gets a plain sentence, not the export/delete controls', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, adminState, async (page) => {
      await page.goto('/settings/account');
      await expect(page).toHaveURL(/\/settings\/account$/);
      await expect(page.getByText(/aren.t available for an admin account/i)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Download my data' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Permanently delete my account' })).toHaveCount(0);
    });
  });

  test('an admin account does not see the entry point on its own pages', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, adminState, async (page) => {
      await page.goto('/admin/imports');
      await expect(page.getByRole('link', { name: 'Export my data or delete my account' })).toHaveCount(0);
    });
  });

  test('an anonymous visitor is sent to sign in, exactly like every other settings page', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, null, async (page) => {
      await page.goto('/settings/account');
      await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Faccount/);
    });
  });
});

test.describe('downloading the export', () => {
  test('the download link hands back a JSON attachment named learn-app-export.json', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto('/settings/account');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: 'Download my data' }).click(),
      ]);
      expect(download.suggestedFilename()).toBe('learn-app-export.json');
    });
  });
});

test.describe('the confirmation actually gates the destructive action', () => {
  test('the wrong handle refuses with a real message and leaves the account alone; the right handle deletes it', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();

      // Sign in as the disposable fixture account — never viewportUser/
      // teacherUser, which other specs depend on staying alive.
      await page.goto(`/login?next=${encodeURIComponent('/settings/account')}`);
      await page.getByLabel('Email').fill(fixtures.deletableUser.email);
      await page.getByLabel('Password').fill(fixtures.deletableUser.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/settings\/account$/);

      // Wrong handle: the API's own 400 message, shown as a real sentence —
      // not a silent failure, and definitely not a deletion.
      //
      // Not `getByRole('alert')` on its own: Next's own route announcer
      // (`#__next-route-announcer__`, present on every page) also carries
      // `role="alert"`, so that locator resolves to two elements here — the
      // form's error paragraph AND the announcer. Matching on the message
      // text is unambiguous.
      await page.getByLabel('Type your account handle to confirm').fill('not-the-real-handle');
      await page.getByRole('button', { name: 'Permanently delete my account' }).click();
      const error = page.getByText(/confirmHandle must match/i);
      await expect(error).toBeVisible();
      // Still on the same page, still signed in — nothing was deleted.
      await expect(page).toHaveURL(/\/settings\/account$/);

      // The right handle: gate opens, account is gone, session cleared.
      await page.getByLabel('Type your account handle to confirm').fill(fixtures.deletableUser.handle);
      await page.getByRole('button', { name: 'Permanently delete my account' }).click();
      await page.waitForURL(/\/login\?deleted=1$/);
      await expect(page.getByText(/your account has been permanently deleted/i)).toBeVisible();

      // Proof it is really gone, not just signed out: the same credentials
      // no longer sign in.
      await page.goto('/login');
      await page.getByLabel('Email').fill(fixtures.deletableUser.email);
      await page.getByLabel('Password').fill(fixtures.deletableUser.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByText(/invalid email or password/i)).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  });
});
