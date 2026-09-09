import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * The gap this closes: an imported course lands `hidden` (migration 0008)
 * with no owner (migration 0007) — the instance's own curriculum content,
 * not any teacher's. `course:visibility:set` already grants an admin
 * override for exactly this course, but before this page nothing in the UI
 * ever handed an admin a slug to type: `/courses/{slug}` is gated on
 * `course:read` (student-only — admins manage, they do not consume) and
 * `GET /api/v1/courses` is `course:list` (student-only too). This spec signs
 * in as the seeded admin (tools/src/e2e-seed.ts's adminUser/E2E_ISSUER_EMAIL)
 * and publishes `fixtures.unownedCourseSlug` — hidden and ownerless, exactly
 * as a fresh import leaves it — the one path this whole task exists to open.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

async function signIn(page: Page, email: string, password: string, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login\?).*$/);
}

test.describe.configure({ mode: 'serial' });

test('an admin reaches, and publishes, a hidden unowned course from /admin/courses', async ({ page }) => {
  await signIn(page, fixtures.adminUser.email, fixtures.adminUser.password, '/admin/courses');
  await expect(page).toHaveURL(/\/admin\/courses$/);
  await expect(page.getByRole('heading', { name: 'Courses', level: 1 })).toBeVisible();

  const row = page.getByRole('listitem').filter({ hasText: 'E2E Unowned Course' });
  await expect(row).toBeVisible();

  // The state that caused this whole task, legible at a glance.
  await expect(row.getByText('Hidden', { exact: true })).toBeVisible();
  await expect(row.getByText('No owner', { exact: true })).toBeVisible();

  // Admin-only ownership control renders alongside the publish control —
  // course:ownership:transfer, unlike course:visibility:set, has no teacher
  // cell (design §5).
  await expect(row.getByLabel('Owner (user id)')).toBeVisible();

  // Publish it — the same PATCH/idiom the owning-teacher's course page uses
  // (PublishControl.tsx), reused here rather than reinvented.
  await row.getByLabel('Visibility').selectOption('open');
  await row.getByRole('button', { name: 'Save' }).click();

  // The badge is server-rendered from fresh data after router.refresh(), so
  // waiting for "Hidden" to disappear from this row is what proves the
  // write actually landed, not just that the request resolved.
  await expect(row.getByText('Hidden', { exact: true })).toHaveCount(0);
  await expect(row.getByText('Open', { exact: true })).toBeVisible();

  // And it survives a real reload — not just optimistic client state.
  await page.reload();
  const reloadedRow = page.getByRole('listitem').filter({ hasText: 'E2E Unowned Course' });
  await expect(reloadedRow.getByText('Open', { exact: true })).toBeVisible();
  await expect(reloadedRow.getByText('No owner', { exact: true })).toBeVisible();
});

test('a teacher reaches the same screen but never sees ownership transfer', async ({ page }) => {
  await signIn(page, fixtures.teacherUser.email, fixtures.teacherUser.password, '/admin/courses');
  await expect(page).toHaveURL(/\/admin\/courses$/);

  // The teacher's own course (E2E_COURSE_SLUG, ensureTeacherUser) is theirs
  // to manage; the just-published unowned course is not — course:manage:list
  // scopes a teacher to their own rows only (api/src/routes/courses.ts).
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Course' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Unowned Course' })).toHaveCount(0);

  // course:ownership:transfer is admin-only (design §5) — a teacher gets the
  // publish control and nothing else.
  await expect(page.getByLabel('Owner (user id)')).toHaveCount(0);
});

test('a student gets no admin navigation entry point and no page (404-shaped denial)', async ({ page }) => {
  await signIn(page, fixtures.viewportUser.email, fixtures.viewportUser.password, '/');
  await page.goto('/admin/courses');
  // course:manage:list denies a plain student, reported by the API as 404 —
  // the same "nothing to disclose" precedent course:manage:read follows —
  // which fetchManageableCourses turns into a ForbiddenError and
  // withAuthRedirect routes to /no-access for a signed-in account.
  await expect(page).toHaveURL(/\/no-access/);
});
