import { test, expect } from '@playwright/test';

// Phase 15 task 1's proof-of-life spec.
//
// This exists to prove the harness works, not to cover a user journey —
// Phase 15 task 2 writes the real ones (register via invite, browse the
// catalog, enrol, read a lesson, mark it complete). Kept deliberately small
// and honest: one navigation, one assertion on something a real visitor
// would actually see.
//
// An anonymous visit to `/` is the smallest true end-to-end check available.
// The catalog page's own server-side render calls the real API
// (`fetchCourses`, web/app/page.tsx) with no session — `course:list`
// (api/src/policy/can.ts) has no anonymous case at all — so the API refuses
// it and web/src/lib/require-auth.ts redirects to `/login`. That round trip
// only completes if the built web app, the real API server, and the seeded
// Postgres database (playwright.config.ts's webServer entries) are all
// actually up and wired together; nothing here is mocked or stubbed.
test('an anonymous visit to the catalog redirects to sign in', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
