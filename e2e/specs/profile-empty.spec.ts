import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * An account with nothing yet should not be shown a column of headings
 * apologising for it.
 *
 * The owner's own view is the strongest case to test: §11 shows an owner
 * EVERY section regardless of its visibility setting, so this is the one
 * viewer for whom all five are present, and therefore the one who saw the
 * full run of empty boxes.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));


async function signIn(page: Page, email: string, password: string, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login\?).*$/);
}

test('a profile with nothing in it shows no empty sections', async ({ page }) => {
  // avatarUser has no badges, no degrees, no enrolments and no activity.
  const profile = `/u/${fixtures.avatarUser.handle}`;
  await signIn(page, fixtures.avatarUser.email, fixtures.avatarUser.password, profile);
  await expect(page).toHaveURL(new RegExp(`${profile}$`));

  // The header is still there — the page is about a person, not their stats.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // `exact: true` is load-bearing. Without it this also matches Next's route
  // announcer — a live region holding the page title, "E2E Avatar
  // (@e2e-avatar) — Learn App" — which is populated transiently after a
  // client-side navigation and cleared again. Two matches is a strict-mode
  // violation, so the test failed on roughly one run in three depending on
  // whether the announcer still had text when the assertion ran.
  await expect(page.getByText(`@${fixtures.avatarUser.handle}`, { exact: true })).toBeVisible();

  for (const heading of ['Badges', 'Degrees', 'Recent activity']) {
    await expect(page.getByRole('heading', { name: heading, exact: true }), heading).toHaveCount(0);
  }
  // And none of the apologies that used to fill them.
  for (const line of ['No badges yet.', 'No degrees defined yet.', 'Nothing recent.']) {
    await expect(page.getByText(line, { exact: true }), line).toHaveCount(0);
  }
});

test('the heatmap stays, because a blank year says it for itself', async ({ page }) => {
  // Deliberately unlike the others: a heatmap with no activity is still a
  // year of rendered days, and the grid reads as "nothing yet" without a line
  // of text saying so.
  const profile = `/u/${fixtures.avatarUser.handle}`;
  await signIn(page, fixtures.avatarUser.email, fixtures.avatarUser.password, profile);

  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: /Activity heatmap/ })).toBeVisible();
});

test('a section that HAS content still renders', async ({ page }) => {
  // The other half of the rule, and the heatmap is the deterministic way to
  // check it here. Every account that can see its own profile has one, and
  // it is the section the collapse rule deliberately exempts — so if the
  // gating were inverted or applied too broadly, this is where it shows.
  //
  // The per-section logic itself is covered exhaustively and without fixture
  // dependencies in web/src/lib/profile-sections.test.ts, including "one
  // item makes it render" for each of badges, degrees, activity and both
  // course lists. Reproducing that here would mean a sixth seeded account
  // whose only job is to own a badge — and every fixture this suite shares
  // between specs has eventually had to be split back out.
  const profile = `/u/${fixtures.avatarUser.handle}`;
  await signIn(page, fixtures.avatarUser.email, fixtures.avatarUser.password, profile);

  const heatmap = page.getByRole('grid', { name: /Activity heatmap/ });
  await expect(heatmap).toBeVisible();
  await expect(heatmap.locator('td').first()).toBeVisible();
});
