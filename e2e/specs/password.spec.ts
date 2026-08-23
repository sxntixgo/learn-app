import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * Changing your own password, through the screen.
 *
 * The API is covered by api/src/routes/password.test.ts. What only a browser
 * shows is that the form is REACHABLE by the account that needs it — the bug
 * as reported was "administrators cannot change their own password", and the
 * cause was the account screen returning early for admins with a single
 * sentence, so the only page that could host the form refused to render
 * anything else for them.
 *
 * Serial, and against dedicated accounts: this spec changes passwords, and
 * pointing it at a shared fixture would leave the rest of the suite unable to
 * sign in.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string, password: string, next = '/settings/account') {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login\?).*$/);
}

async function fillForm(page: Page, current: string, next: string, confirm = next) {
  await page.getByLabel('Current password').fill(current);
  await page.getByLabel('New password', { exact: true }).fill(next);
  await page.getByLabel('Confirm new password').fill(confirm);
  await page.getByRole('button', { name: 'Change password' }).click();
}

async function withPage<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

test('an admin can reach the form and change their password', async ({ browser }) => {
  // The reported bug, end to end. `me:password:update` grants to every role,
  // unlike me:export/me:delete — an admin cannot leave the instance but can
  // certainly be compromised, and there is no reset flow to fall back on.
  const changed = 'admin-changed-password-1';

  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordAdmin.email, fixtures.passwordAdmin.password);
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    await fillForm(page, fixtures.passwordAdmin.password, changed);
    await expect(page.getByText(/Your password has been changed/)).toBeVisible();

    // The rest of the screen still refuses, correctly — an admin account is
    // instance infrastructure and cannot export or delete itself.
    await expect(page.getByText(/aren’t available for an admin account/)).toBeVisible();
  });

  // And the new password is the one that works now.
  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordAdmin.email, changed, '/admin/people');
    await expect(page).not.toHaveURL(/login/);
  });
});

test('a student can change their password, and the old one stops working', async ({ browser }) => {
  const changed = 'student-changed-password-1';

  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, fixtures.passwordUser.password);
    await fillForm(page, fixtures.passwordUser.password, changed);
    await expect(page.getByText(/Your password has been changed/)).toBeVisible();

    // Still signed in here: the API issues a fresh pair for this device, and
    // the web client relays them. Forgetting that relay is how a password
    // change signs you out a quarter of an hour later.
    await page.goto('/settings/account');
    await expect(page).not.toHaveURL(/login/);
  });

  await withPage(browser, async (page) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(fixtures.passwordUser.email);
    await page.getByLabel('Password').fill(fixtures.passwordUser.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The API's own wording, checked rather than guessed: `INVALID_CREDENTIALS`
    // in api/src/routes/auth.ts. It is deliberately the same message for an
    // unknown address and a wrong password — there is no account oracle here.
    await expect(page.getByText('Invalid email or password.')).toBeVisible();
    await expect(page).toHaveURL(/login/);
  });

  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, changed, '/');
    await expect(page).not.toHaveURL(/login/);
  });
});

test('a wrong current password is refused, and nothing changes', async ({ browser }) => {
  const current = 'student-changed-password-1';

  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, current);
    await fillForm(page, 'not-the-current-one', 'another-new-password');

    await expect(page.getByText(/Incorrect password/i)).toBeVisible();
    await expect(page.getByText(/Your password has been changed/)).toHaveCount(0);
  });

  // Still the password from the previous test.
  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, current, '/');
    await expect(page).not.toHaveURL(/login/);
  });
});

test('a mismatched confirmation is caught without touching the API', async ({ browser }) => {
  // The confirmation never reaches the request body — a password typed twice
  // is a typing aid, not something the API needs, and every extra field is
  // another place a secret could be logged.
  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, 'student-changed-password-1');
    await fillForm(page, 'student-changed-password-1', 'a-valid-new-password', 'a-different-one');

    await expect(page.getByText(/do not match/i)).toBeVisible();
  });
});

test('the menu leads here, so the entry point is not a promise the page breaks', async ({ browser }) => {
  await withPage(browser, async (page) => {
    await signIn(page, fixtures.passwordUser.email, 'student-changed-password-1', '/');
    await page.locator('details').first().locator('summary').click();
    await page.getByRole('link', { name: 'Account & password' }).click();

    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  });
});
