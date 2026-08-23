import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * Two failures found by running the app behind Caddy for the first time.
 * Both are about what happens AFTER a successful login, which is why a suite
 * that always signed in as the right role for the page it was testing never
 * saw either.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string, password: string, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login\?).*$/);
}

test('an admin landing on the catalog is told why, not bounced between two pages', async ({ page }) => {
  // THE BUG: `course:list` is student-only (§5.1 — operator accounts have no
  // learner surface), so the catalog 403s for an admin. The web client mapped
  // 401 and 403 to the same outcome, so it redirected to /login; /login found
  // a valid session and redirected back. Firefox reported "the page isn't
  // redirecting properly".
  const redirects: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) redirects.push(new URL(frame.url()).pathname);
  });

  await signIn(page, fixtures.adminUser.email, fixtures.adminUser.password, '/');

  await expect(page).toHaveURL(/\/no-access/);
  await expect(page.getByRole('heading', { name: 'Not available to this account' })).toBeVisible();
  // It must say the thing the loop could not: you are already signed in.
  await expect(page.getByText(/Signing in again will not change that/)).toBeVisible();

  // And it must actually terminate. Anything above a handful of navigations
  // is the loop coming back in a new form.
  expect(redirects.filter((p) => p === '/login').length, redirects.join(' -> ')).toBeLessThan(3);
});

test('the no-access page offers somewhere the account can actually go', async ({ page }) => {
  await signIn(page, fixtures.adminUser.email, fixtures.adminUser.password, '/');
  await expect(page).toHaveURL(/\/no-access/);

  // Derived from capability probes, not roles — /api/v1/me carries none, and
  // the endpoint that does is itself student-only.
  const admin = page.getByRole('link', { name: 'Administration' });
  await expect(admin).toBeVisible();
  await admin.click();
  await expect(page).toHaveURL(/\/admin\/people$/);
  // The link has to lead somewhere that works, not back here.
  await expect(page).not.toHaveURL(/no-access/);
});

test('a student is unaffected — the catalog still opens', async ({ page }) => {
  // The split must not turn a working page into a refusal.
  await signIn(page, fixtures.viewportUser.email, fixtures.viewportUser.password, '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page).not.toHaveURL(/no-access|login/);
});

test('an expired access token is refreshed instead of ending the session', async ({ page, context }) => {
  // THE BUG: the API has issued rotating refresh tokens since Phase 6 and the
  // web app never spent one. After fifteen minutes the access cookie expired
  // and the session was simply over.
  //
  // Simulated by deleting the access cookie, which is exactly what the
  // browser does at its maxAge — the refresh cookie outlives it by design.
  // A DEDICATED ACCOUNT. `login` revokes the same device's previous session
  // (api/src/routes/auth.ts's revokeDeviceSessions), and six other specs sign
  // in as viewportUser — any of them running concurrently revokes the family
  // this test is about, and the refresh then correctly 401s. Verified: this
  // passed alone and failed in the full suite until the account was split out.
  await signIn(page, fixtures.sessionUser.email, fixtures.sessionUser.password, '/');

  const before = await context.cookies();
  expect(before.map((c) => c.name), 'login should set both cookies').toEqual(
    expect.arrayContaining(['learn_at', 'learn_rt']),
  );

  // The refresh cookie has to be reachable on this origin, or nothing can
  // ever spend it. The API scopes it to /api/v1/auth, which does not exist here.
  const refresh = before.find((c) => c.name === 'learn_rt');
  expect(refresh?.path, 'the refresh cookie is scoped to a path the browser will never request').toBe('/');

  await context.clearCookies({ name: 'learn_at' });
  expect((await context.cookies()).map((c) => c.name)).not.toContain('learn_at');

  await page.goto('/');

  // Still signed in, and holding a NEW access token.
  await expect(page).not.toHaveURL(/login/);
  const after = await context.cookies();
  expect(after.map((c) => c.name)).toContain('learn_at');
  // Rotation: the refresh token is single-use, so it must have changed too.
  expect(after.find((c) => c.name === 'learn_rt')?.value).not.toBe(refresh?.value);
});

test('a signed-out visitor still goes to sign in, not to no-access', async ({ page }) => {
  // The correction to the first attempt at this fix. The API answers 403 for
  // an anonymous caller too, so keying the remedy off the status alone sent
  // signed-out visitors to a page that told them they were signed in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page).not.toHaveURL(/no-access/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
