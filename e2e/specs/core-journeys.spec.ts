import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

// Phase 15 task 2: the core journeys named in the plan — register via
// invite, browse the catalog, enrol, read a lesson, mark it complete, see
// the event in the feed. Written as ONE spec rather than several, because
// the chain is inherently sequential and stateful (each step needs the
// session/enrolment the previous step produced): splitting it into
// independently-runnable tests would mean either re-registering a fresh
// account per test (burning the one seeded invite, since a platform invite
// is single-use and tools/src/e2e-seed.ts only issues one per seed run) or
// smuggling session state between tests, which is worse than one spec that
// tells the same story a real visitor lives through. `test.step` keeps each
// stage separately reported so a break is still easy to localise.
//
// Every assertion below is on what the page actually shows — headings,
// button labels, body text — never on the database or an API response
// body, per Phase 15 task 2's acceptance criterion.

const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

test('register via invite, browse, enrol, read a lesson, complete it, and see it in the feed', async ({ page }) => {
  await test.step('register via invite', async () => {
    await page.goto(fixtures.invite.acceptPath);

    await expect(page.getByRole('heading', { name: 'You are invited' })).toBeVisible();
    await expect(page.getByText(fixtures.invite.email)).toBeVisible();

    await page.getByLabel('Handle').fill('e2e-student');
    await page.getByLabel('Password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'Create account' }).click();

    // No course is attached to the seeded platform invite, so acceptance
    // lands the newly-registered, now-signed-in visitor on their own Home
    // rather than a course page.
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  });

  await test.step('browse the catalog', async () => {
    // SCOPED TO THE NAV, and it has to be. Home carries a "Browse catalog"
    // link of its own since the design import merged the dashboard into it
    // (docs/design/2026-09-02-artboard-spec.md §2), and Playwright's
    // accessible-name matching is a substring match — so the unscoped
    // locator resolved to three links and this step is about the
    // DESTINATION, not about whichever route to the catalog is nearest.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Catalog' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'E2E Course' })).toBeVisible();

    await page.getByRole('heading', { name: 'E2E Course' }).click();
    await expect(page).toHaveURL(new RegExp(`/courses/${fixtures.courseSlug}$`));
    await expect(page.getByRole('heading', { name: 'E2E Course', level: 1 })).toBeVisible();
  });

  await test.step('enrol', async () => {
    await expect(page.getByRole('button', { name: 'Enrol' })).toBeVisible();
    await page.getByRole('button', { name: 'Enrol' }).click();

    await expect(page.getByRole('button', { name: 'Leave course' })).toBeVisible();
  });

  await test.step('read the lesson', async () => {
    await page.getByRole('link', { name: /Getting started/ }).click();

    await expect(page).toHaveURL(new RegExp(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}$`));
    await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
    await expect(page.getByText('hello, e2e')).toBeVisible();
    await expect(page.getByText(/closing paragraph/)).toBeVisible();
  });

  await test.step('mark the lesson complete', async () => {
    await page.getByRole('button', { name: 'Mark complete' }).click();

    await expect(page.getByText('Completed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark complete' })).not.toBeVisible();
  });

  await test.step('see the event in the feed', async () => {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Home' }).click();

    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await expect(page.getByText('Completed “Getting started” in E2E Course')).toBeVisible();
  });
});
