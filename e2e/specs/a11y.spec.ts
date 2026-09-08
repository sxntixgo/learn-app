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
// THE ACCEPTANCE BAR IS "NO CRITICAL VIOLATIONS", NOT "NO VIOLATIONS" for
// Part A's single-width/single-theme baseline below (axe-core's full,
// undisabled rule set — no `withTags`, no `disableRules` — because
// narrowing the rule set to make a route "pass" would hide exactly the kind
// of finding this task exists to surface; serious/moderate/minor are
// logged via console.log, visible in the 'list' reporter's output, but only
// 'critical' fails the baseline build). The MATRIX tests added below (Phase
// 6, "Re-run a11y.spec.ts across the matrix") hold every route to a
// stricter bar — zero violations of ANY impact — because that is the
// phase's literal acceptance line and, per Phase 6's own record, every
// route already reports true {critical:0,serious:0,moderate:0,minor:0}, so
// the stronger bar costs nothing today and catches a future regression the
// weaker one would let through silently.
//
// ---------------------------------------------------------------------------
// THE MATRIX (Phase 6, "Re-run a11y.spec.ts across the matrix") — and what
// it does and does not prove.
//
// Before this task the whole file ran at ONE width (1280px, Playwright's
// `devices['Desktop Chrome']` default — not one of the four artboard
// widths) and ONE theme (whatever `prefers-color-scheme` the browser
// defaulted to, i.e. never an EXPLICIT choice). Naively crossing all ~19
// routes by the 4 artboard widths (375/834/1194/1440, viewport.spec.ts's
// PHONE/TABLET/IPAD_LANDSCAPE/DESKTOP) by 2 themes is 152 axe scans; at
// 2–9s each that is 15+ minutes added to a 3.3-minute suite, which is not
// acceptable for what the two axes actually buy:
//
//   - THEME changes colour — `data-theme` swaps which `tokens.css` values
//     resolve — so it is the axis that can move `color-contrast`, and a
//     component's contrast is specific to what surrounds it, so it is
//     worth checking on EVERY route, not a sample. It does NOT vary with
//     width: the colour tokens are keyed by `data-theme`/
//     `prefers-color-scheme`, never by a `min-width` media query (Phase
//     1's breakpoint task confirms the only `min-width` rules in `web/app`
//     are the tier boundary and the density steps), so crossing theme with
//     every width would just re-run the same colour check at four sizes
//     for no new finding.
//   - WIDTH changes layout and which CHROME IS PRESENT — the 224px rail
//     above 1024px, the hamburger + drawer below it — which is shared
//     shell markup (`Nav`/`TopBar`/`Footer`), not per-route content. Most
//     routes' own content does not change shape between 834 and 1194
//     (Phase 6's own framing). What DOES change by role is which nav
//     destinations and account-menu items render (`web/src/lib/nav.ts`:
//     `restrictedToTeacher`, the admin-only "Manage" section), so the
//     representative sample below is one route per SESSION TYPE, not one
//     route overall.
//
// So the matrix below is three groups, not one 19×4×2 cross:
//
//   1. THEME SWEEP — every route in `ROUTES`, both themes, at ONE width
//      (1440, `WIDTHS.desktop` — an actual artboard width, replacing the
//      old implicit 1280 default). Full coverage on the axis that can find
//      something on any given route.
//   2. WIDTH SWEEP — `WIDTH_SWEEP_ROUTES` (one anon, one teacher, one admin
//      route — student is covered by group 3) at the three widths group 1
//      did not already cover (375/834/1194), one theme (light — width does
//      not move colour, per above). Representative coverage on the axis
//      that can find something in shared chrome, sampled by role.
//   3. FLAGSHIP — `/me` (student, the richest single page: full shell +
//      heatmap + feed) at all 4 widths × both themes, explicitly. This is
//      the one place the full 4×2 cross is actually run end to end, so the
//      phase's literal "4 widths × 2 themes" acceptance has a direct,
//      point-in-time witness rather than only an argument that two
//      separate 1-D sweeps compose safely.
//
// THE BLIND SPOT — restated so this task does not imply more coverage than
// it has. Axe-core does not check border colours: `border-color: <low
// contrast>` on its own produces no axe finding at any width, in any
// theme, no matter how the matrix is sliced. That is exactly how the OLD
// yellow's 2.46:1 survived 69 passing assertions before Phase 1 caught it.
// The tests that DO cover measured contrast are `web/src/lib/palette.test.ts`
// (a floor for every token pairing the app actually uses) and
// `web/src/lib/home-contrast.test.ts` (the same for `color-mix()` values,
// which no CSS lint sees either) — not this file, at any width or theme.
// ---------------------------------------------------------------------------
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

// The four artboard widths, same pairing as viewport.spec.ts's own
// PHONE/TABLET/IPAD_LANDSCAPE/DESKTOP — see the MATRIX comment above for
// which of them each group below actually exercises and why.
type WidthName = 'phone' | 'tablet' | 'ipadLandscape' | 'desktop';
const WIDTHS: Record<WidthName, { width: number; height: number }> = {
  phone: { width: 375, height: 812 },
  tablet: { width: 834, height: 1194 },
  ipadLandscape: { width: 1194, height: 834 },
  desktop: { width: 1440, height: 900 },
};
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/**
 * Sets the EXPLICIT theme choice, same idiom as shiki-dual-theme.spec.ts's
 * own comment: `colorScheme` on the context is the OS preference,
 * `data-theme` on the document element is the explicit choice that is
 * supposed to win over it. Every matrix test below only ever sets
 * `data-theme` — never `colorScheme` — because the point is to prove BOTH
 * explicit choices are clean, not to re-litigate the OS-vs-explicit
 * precedence shiki-dual-theme.spec.ts already covers.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

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
  viewport?: { width: number; height: number },
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: state ?? undefined, viewport });
  try {
    const page = await context.newPage();
    return await run(page);
  } finally {
    await context.close();
  }
}

/**
 * The matrix's bar: zero violations of ANY impact, not just critical (see
 * the header comment on why this is stricter than Part A's baseline and why
 * it is safe to assert today).
 */
function assertNoViolations(results: AxeResults, label: string): void {
  expect(
    results.violations,
    `Accessibility violations on ${label}:\n${results.violations
      .map((v) => `- ${v.impact ?? 'unknown'} ${v.id}: ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`)
      .join('\n')}`,
  ).toEqual([]);
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
  /**
   * The route SPENDS a fixture just by being navigated to (server-side, on
   * the GET itself — not on a click), so it cannot be visited a second time
   * by anything and still show the same page. The theme sweep below visits
   * every route twice (once per theme); a route flagged here is scanned
   * ONCE instead, in `THEMES[0]` only. Found the hard way: the accept-
   * invitation route's second (dark) visit failed with "You are invited"
   * not found, because the first (light) visit had already exchanged the
   * URL's token for a claim cookie and redirected to the generic /invite
   * page.
   */
  singleUse?: boolean;
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
    singleUse: true,
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
  { name: 'home (resume, activity, up next, your courses)', path: '/me', session: 'student', expectUrl: /\/me$/ },
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

// GROUP 1 — THEME SWEEP. Every route, both themes, at one width
// (WIDTHS.desktop — see the MATRIX comment at the top of the file for why
// one width is enough for this axis). This is Phase 6's "Re-run
// a11y.spec.ts across the matrix" task for the theme half of the matrix,
// and it replaces Part A's old single-theme, implicit-1280px pass: the
// `light` iteration below is that same baseline made explicit, plus a new
// `dark` iteration alongside it.
for (const route of ROUTES) {
  const themesForRoute = route.singleUse ? [THEMES[0]] : THEMES;
  for (const theme of themesForRoute) {
    test(`axe: ${route.name} (${route.path}) [${theme}]`, async ({ browser, baseURL }) => {
      const state = route.session === 'anon' ? null : { student: studentState, teacher: teacherState, admin: adminState }[route.session];
      await withPage(
        browser,
        baseURL,
        state,
        async (page) => {
          await page.goto(route.path);
          await expect(page).toHaveURL(route.expectUrl);
          if (route.expectVisible) {
            await expect(page.getByText(route.expectVisible).first()).toBeVisible();
          }
          await setTheme(page, theme);

          /*
           * `color-contrast` is disabled for /kitchen-sink ONLY, and only there.
           *
           * That page is the token proof sheet: it renders a swatch for EVERY
           * token in tokens.css, so axe measures each swatch against whatever
           * label sits next to it — pairings that exist nowhere in the product
           * and are not meant to. It reported 53 nodes of serious
           * `color-contrast` on that basis, none of which describes a real
           * screen.
           *
           * The contrast guarantees that DO matter are measured, not skipped:
           * `web/src/lib/palette.test.ts` asserts a floor for every pairing the
           * app actually uses (it is what caught light accent-gold at 2.84:1 and
           * dark link at 4.07:1 in Phase 1), and `home-contrast.test.ts` does the
           * same for `color-mix` values, which no CSS lint can see. Suppressing
           * the rule here removes noise from a page nobody reads as UI; it does
           * not remove coverage.
           */
          const builder = new AxeBuilder({ page });
          if (route.path === '/kitchen-sink') builder.disableRules(['color-contrast']);
          const results = await builder.analyze();
          logViolations(`${route.name} [${theme}]`, results);
          assertNoViolations(results, `${route.name} [${theme}]`);
        },
        WIDTHS.desktop,
      );
    });
  }
}

// GROUP 2 — WIDTH SWEEP. A representative sample, not all 19 routes (see
// the MATRIX comment): one route per session type NOT already given the
// full 4-width treatment by the flagship below (student is the flagship),
// at the three widths group 1 did not already cover, in light theme only
// (colour does not move with width — group 1 already proved that axis).
interface WidthSweepCase {
  name: string;
  path: string;
  session: 'anon' | 'teacher' | 'admin';
  expectUrl: RegExp;
}

const WIDTH_SWEEP_ROUTES: WidthSweepCase[] = [
  // Anon: no rail/drawer chrome at all — the "chrome absent" case.
  { name: 'sign in', path: '/login', session: 'anon', expectUrl: /\/login(\?|$)/ },
  // Teacher: nav destinations and grading-queue content differ from a student's.
  { name: 'grading queue', path: '/grading', session: 'teacher', expectUrl: /\/grading$/ },
  // Admin: the account menu grows its "Manage" section (web/src/lib/nav.ts).
  { name: 'admin: people', path: '/admin/people', session: 'admin', expectUrl: /\/admin\/people$/ },
];

const WIDTH_SWEEP_WIDTHS: WidthName[] = ['phone', 'tablet', 'ipadLandscape'];

for (const route of WIDTH_SWEEP_ROUTES) {
  for (const widthName of WIDTH_SWEEP_WIDTHS) {
    test(`axe: ${route.name} (${route.path}) [${widthName} ${WIDTHS[widthName].width}px]`, async ({ browser, baseURL }) => {
      const state = route.session === 'anon' ? null : { teacher: teacherState, admin: adminState }[route.session];
      await withPage(
        browser,
        baseURL,
        state,
        async (page) => {
          await page.goto(route.path);
          await expect(page).toHaveURL(route.expectUrl);
          const results = await new AxeBuilder({ page }).analyze();
          const label = `${route.name} [${widthName} ${WIDTHS[widthName].width}px]`;
          logViolations(label, results);
          assertNoViolations(results, label);
        },
        WIDTHS[widthName],
      );
    });
  }
}

// GROUP 3 — FLAGSHIP: the one place the literal "4 widths × 2 themes" cross
// is run in full, end to end, rather than assembled from two 1-D sweeps.
// `/me` (student home) is the richest single page — full shell, heatmap,
// activity feed — so it is the route most likely to show a width/theme
// interaction if one exists. `desktop` is skipped in both themes: group 1
// already scans `/me` there (it is one of the 19 `ROUTES`), so re-running
// it here would just re-pay for an already-covered cell.
for (const widthName of Object.keys(WIDTHS) as WidthName[]) {
  if (widthName === 'desktop') continue;
  for (const theme of THEMES) {
    test(`axe: home (/me) [${widthName} ${WIDTHS[widthName].width}px, ${theme}]`, async ({ browser, baseURL }) => {
      await withPage(
        browser,
        baseURL,
        studentState,
        async (page) => {
          await page.goto('/me');
          await expect(page).toHaveURL(/\/me$/);
          await setTheme(page, theme);
          const results = await new AxeBuilder({ page }).analyze();
          const label = `home (/me) [${widthName} ${WIDTHS[widthName].width}px, ${theme}]`;
          logViolations(label, results);
          assertNoViolations(results, label);
        },
        WIDTHS[widthName],
      );
    });
  }
}

/*
 * The narrow tier's nav is a DRAWER (artboard P11), and none of the groups
 * above see it open: the theme sweep and flagship groups scan `/me` at
 * every width including the two narrow ones (phone, tablet), but always in
 * its default (closed) state — the drawer only exists after a click. So it
 * gets its own scan, at 375, in that post-click state — the drawer over the
 * page, the rest of the shell `inert` — in both themes: the open drawer
 * paints its own scrim/overlay over the rest of the shell, exactly the kind
 * of surface a theme swap can move contrast on.
 */
test.describe('axe: the narrow-tier nav drawer, open', () => {
  for (const theme of THEMES) {
    test(`no violations with the drawer over the page at 375 [${theme}]`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({
        baseURL,
        storageState: studentState,
        viewport: { width: 375, height: 812 },
      });
      try {
        const page = await context.newPage();
        await page.goto('/me');
        await setTheme(page, theme);
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

        const results = await new AxeBuilder({ page }).analyze();
        const label = `nav drawer (375, open) [${theme}]`;
        logViolations(label, results);
        assertNoViolations(results, label);
      } finally {
        await context.close();
      }
    });
  }
});

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

      // The seeded lesson's first code line carries one author annotation
      // (tools/src/e2e-seed.ts's LESSON_MARKDOWN `[!note]` marker) —
      // describeLine (web/src/lib/annotations.ts) names the line, the line
      // COUNT and the annotation count in the control's own accessible
      // name. The count is 12 because the design-import annotation-overlay
      // task grew that fence from one line to twelve (see the seed's own
      // comment on why); this test's subject — Tab reaches a line control,
      // and two activations reach its card — is unchanged by that.
      const lineButton = page.getByRole('button', { name: 'Line 1 of 12, 1 annotation' });
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

      // ANCHORED. This was `/annotation on line 1/i`, which also matches
      // "annotation on line 11" — harmless until the annotation-overlay task
      // (2026-09-03) extended the seeded fence so lines 1, 4 and 11 all
      // carry annotations, at which point the unanchored form resolved to
      // two elements and failed strict mode. The assertion is about line 1
      // specifically, so it says so.
      const card = page.getByRole('article', { name: /annotation on line 1$/i });
      await expect(card).toBeFocused();
    });
  });
});
