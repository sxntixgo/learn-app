import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AxeResults, Result as AxeViolation } from 'axe-core';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { E2E_VIEWPORT_HANDLE } from '../../tools/src/e2e-seed.ts';

// Phase 15 task 4: the accessibility pass — axe against every route, plus
// keyboard-only traversal of the heatmap and the annotatable code block
// (plan, Phase 15's fourth bullet). Tasks 1–3 (harness, core journeys,
// viewport specs) are done; this file is additive, same as viewport.spec.ts
// was to core-journeys.spec.ts.
//
// THE ACCEPTANCE BAR IS "NO CRITICAL VIOLATIONS", NOT "NO VIOLATIONS". Every
// route below is scanned with axe-core's full, undisabled rule set (no
// `withTags`, no `disableRules`) — narrowing the rule set to make a route
// "pass" would hide exactly the kind of finding this task exists to surface.
// serious/moderate/minor findings are logged (console.log, visible in the
// 'list' reporter's output — playwright.config.ts) but do not fail the
// build; only 'critical' does, per the plan's own acceptance line.
//
// AUTH — four sessions, one `beforeAll`, same reasoning as
// viewport.spec.ts's own "AUTH, two decisions" comment: this whole file is
// `mode: 'serial'` so its logins run one at a time (never concurrent with
// each other) and, being pinned to one worker, never pile ANOTHER concurrent
// Argon2id hash on top of whatever core-journeys.spec.ts or
// viewport.spec.ts are doing in their own workers at the same moment.
// viewportUser is task 3's existing fixture, reused rather than logged into
// twice. adminUser and teacherUser are new (tools/src/e2e-seed.ts) — the
// issuer account already existed as an admin for task 2's invite and now
// carries a password too, and the teacher is a fresh fixture that owns
// E2E_COURSE_SLUG so /grading and the teacher half of /invites are
// reachable. See e2e-seed.ts's own comments on each for why nothing this
// file touches invalidates task 2/3's use of the same course/lesson.
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

/** A fresh context/page carrying one captured session (or none, for `session: null`) — no per-test login. */
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

// ---------------------------------------------------------------------------
// Part A: axe against every route.
//
// The routes are web/app/**/page.tsx (~15 files, plan's Phase 15 task 4).
// Every one of them is reached below except the single one noted in the
// "NOT REACHED" comment further down — the rest needed real fixtures
// (tools/src/e2e-seed.ts: adminUser, teacherUser, a11yInvite,
// exerciseSubmission) rather than being skippable.
// ---------------------------------------------------------------------------

interface RouteCase {
  /** Human label — also what shows up in the test list on a failure. */
  name: string;
  path: string;
  /** null = no session (anonymous). */
  session: 'anon' | 'student' | 'teacher' | 'admin';
  /** The URL this route must actually resolve to — guards against silently axe-scanning a login redirect. */
  expectUrl: RegExp;
  /**
   * Text that must be on the page before axe runs.
   *
   * `expectUrl` alone stopped being enough for the invite route: an opened
   * link and a SPENT one both land on /invite, so a consumed fixture would
   * have axe-scanning the "this invitation is not valid" page while the URL
   * assertion still passed — a silently weaker test. This makes that loud.
   */
  expectVisible?: string;
}

const ROUTES: RouteCase[] = [
  // Anonymous — reachable while signed out by design (§13, §12).
  { name: 'sign in', path: '/login', session: 'anon', expectUrl: /\/login(\?|$)/ },
  {
    // The link SPENDS itself on open (db/migrations/0020): its route handler
    // exchanges the URL token for a claim cookie and redirects to /invite, so
    // the scanned URL is the clean one, not the token-bearing one.
    name: 'accept invitation',
    path: fixtures.a11yInvite.acceptPath,
    session: 'anon',
    expectUrl: /\/invite$/,
    expectVisible: 'You are invited',
  },
  { name: 'kitchen sink', path: '/kitchen-sink', session: 'anon', expectUrl: /\/kitchen-sink$/ },

  // Student (viewportUser) — everything behind plain auth.
  { name: 'catalog', path: '/', session: 'student', expectUrl: /\/$/ },
  // Phase 16: search results grouped by course, axe-scanned with a real
  // query so the results markup (not just the empty form) is covered.
  { name: 'search', path: `/search?q=seeded`, session: 'student', expectUrl: /\/search\?q=seeded$/ },
  {
    name: 'course detail',
    path: `/courses/${fixtures.courseSlug}`,
    session: 'student',
    expectUrl: new RegExp(`/courses/${fixtures.courseSlug}$`),
  },
  {
    name: 'lesson reader (annotatable code block)',
    path: `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`,
    session: 'student',
    expectUrl: new RegExp(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}$`),
  },
  { name: 'dashboard (activity feed)', path: '/me', session: 'student', expectUrl: /\/me$/ },
  { name: 'profile settings', path: '/settings/profile', session: 'student', expectUrl: /\/settings\/profile$/ },
  // Plan: "Account deletion and data export". Read-only for this pass — the
  // form is loaded and scanned, never submitted, so this never touches
  // `viewportUser`'s account (account-export-deletion.spec.ts's own
  // dedicated `deletableUser` fixture is what actually gets deleted).
  {
    name: 'account export & deletion',
    path: '/settings/account',
    session: 'student',
    expectUrl: /\/settings\/account$/,
  },
  {
    name: 'public profile',
    path: `/u/${E2E_VIEWPORT_HANDLE}`,
    session: 'student',
    expectUrl: new RegExp(`/u/${E2E_VIEWPORT_HANDLE}$`),
  },

  // Teacher (teacherUser, owns E2E_COURSE_SLUG).
  { name: 'grading queue', path: '/grading', session: 'teacher', expectUrl: /\/grading$/ },
  { name: 'invitations (teacher)', path: '/invites', session: 'teacher', expectUrl: /\/invites$/ },
  {
    name: 'grading view (AnnotatableCode grade mode)',
    path: `/courses/${fixtures.exerciseSubmission.courseSlug}/lessons/${fixtures.exerciseSubmission.lessonSlug}/submissions/${fixtures.exerciseSubmission.studentUserId}`,
    session: 'teacher',
    expectUrl: new RegExp(
      `/courses/${fixtures.exerciseSubmission.courseSlug}/lessons/${fixtures.exerciseSubmission.lessonSlug}/submissions/${fixtures.exerciseSubmission.studentUserId}$`,
    ),
  },

  // Admin (adminUser, task 2's invite issuer with a password added — see
  // e2e-seed.ts's ensureIssuer).
  { name: 'admin: audit log', path: '/admin/audit', session: 'admin', expectUrl: /\/admin\/audit$/ },
  { name: 'admin: import content', path: '/admin/imports', session: 'admin', expectUrl: /\/admin\/imports$/ },
  { name: 'admin: people', path: '/admin/people', session: 'admin', expectUrl: /\/admin\/people$/ },
  { name: 'invitations (admin)', path: '/invites', session: 'admin', expectUrl: /\/invites$/ },
  // The admin-only branch of the SAME route above — a plain sentence
  // instead of the export/delete controls (`me:export`/`me:delete` have no
  // admin cell), genuinely different markup worth its own scan.
  {
    name: 'account export & deletion (admin — not available)',
    path: '/settings/account',
    session: 'admin',
    expectUrl: /\/settings\/account$/,
  },
];

// NOT REACHED: none. Every web/app/**/page.tsx is exercised by ROUTES above
// (the submission grading view — the one route that looked likely to be
// skipped, since it needs an exercise lesson AND a real student submission
// to render anything but a 404 — is reached via
// `fixtures.exerciseSubmission`, seeded for exactly this purpose). If a
// future route is added under web/app and not added here, it is a silent
// gap; there is no automated check that ROUTES stays exhaustive.

function severityCounts(violations: AxeViolation[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
  for (const v of violations) {
    const key = v.impact ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function logViolations(routeName: string, results: AxeResults): void {
  const counts = severityCounts(results.violations);
  // Deliberate console output: the task asks the report to include
  // serious/moderate/minor findings, not only the critical ones the
  // assertion below enforces. This is that report.
  console.log(`[a11y] ${routeName}: ${JSON.stringify(counts)}`);
  for (const v of results.violations) {
    console.log(`[a11y]   ${v.impact ?? 'unknown'} — ${v.id}: ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`);
  }
}

for (const route of ROUTES) {
  test(`axe: ${route.name} (${route.path})`, async ({ browser, baseURL }) => {
    const state = route.session === 'anon' ? null : { student: studentState, teacher: teacherState, admin: adminState }[route.session];
    await withPage(browser, baseURL, state, async (page) => {
      await page.goto(route.path);
      await expect(page).toHaveURL(route.expectUrl);
      if (route.expectVisible) {
        await expect(page.getByText(route.expectVisible).first()).toBeVisible();
      }

      const results = await new AxeBuilder({ page }).analyze();
      logViolations(route.name, results);

      const critical = results.violations.filter((v) => v.impact === 'critical');
      expect(
        critical,
        `Critical accessibility violations on ${route.name}:\n${critical
          .map((v) => `- ${v.id}: ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`)
          .join('\n')}`,
      ).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Part B: keyboard-only traversal.
// ---------------------------------------------------------------------------

/** Tabs forward until `locator` has focus, or fails after `maxTabs` — a bounded trap detector, not a timeout. */
async function tabUntilFocused(page: Page, locator: ReturnType<Page['locator']>, maxTabs: number): Promise<boolean> {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const isFocused = await locator
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (isFocused) return true;
  }
  return false;
}

test.describe('keyboard-only traversal (plan, Phase 15 task 4: "the grid is reachable and escapable by keyboard")', () => {
  test('the heatmap grid is reachable and escapable by keyboard', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      // The grid is on the profile now — /me became the activity feed, and
      // the two pages had been rendering the same heatmap from the same data.
      await page.goto(`/u/${E2E_VIEWPORT_HANDLE}`);

      const grid = page.getByRole('grid', { name: /Activity heatmap/ });
      await expect(grid).toBeVisible();

      // Reachable: Tab from the top of the document until focus lands
      // somewhere inside the grid (Heatmap.tsx's roving-tabindex cell).
      let insideGrid = false;
      for (let i = 0; i < 60 && !insideGrid; i++) {
        await page.keyboard.press('Tab');
        insideGrid = await page.evaluate(() => {
          const active = document.activeElement;
          return active !== null && active.closest('[role="grid"]') !== null;
        });
      }
      expect(insideGrid, 'Tab never reached inside the heatmap grid within 60 presses').toBe(true);

      // Escapable: THE classic failure this criterion exists to catch is a
      // scrollable/roving-tabindex widget that swallows Tab and never lets
      // focus leave. One more Tab must move focus somewhere OUTSIDE the
      // grid entirely.
      await page.keyboard.press('Tab');
      const stillInsideGrid = await page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active.closest('[role="grid"]') !== null;
      });
      expect(stillInsideGrid, 'Tab after the grid did not move focus out of it — focus trap').toBe(false);
    });
  });

  test('the annotatable code block and its annotations are keyboard-reachable', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`);

      // The seeded lesson's one code line carries one author annotation
      // (tools/src/e2e-seed.ts's LESSON_MARKDOWN `[!note]` marker) —
      // describeLine (web/src/lib/annotations.ts) names both the line and
      // the annotation count in the control's own accessible name.
      const lineButton = page.getByRole('button', { name: 'Line 1 of 1, 1 annotation' });
      const reached = await tabUntilFocused(page, lineButton, 60);
      expect(reached, 'Tab never reached the annotatable code block\'s line control within 60 presses').toBe(true);

      // First activation selects the line (AnnotatableCode.tsx's `activate`:
      // "First activation selects"); a SECOND activation on an
      // already-selected line, in read mode, moves focus to that line's
      // first annotation card. Reaching the card this way — never clicking
      // it — is the proof that the annotation is keyboard-reachable, not
      // mouse-only (plan, Phase 15 task 4).
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');

      const card = page.getByRole('article', { name: /annotation on line 1/i });
      await expect(card).toBeFocused();
    });
  });
});
