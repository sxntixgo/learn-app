import { cookies, headers } from 'next/headers';
import type { components } from './api-types';
import { AuthRequiredError, classifyStatus } from './api-errors';
import { relaySetCookies } from './auth-cookies';

// Types come from the generated contract (CLAUDE.md rule 3) — never
// hand-written. web talks to the API over HTTP only (CLAUDE.md rule 1); it
// never receives DATABASE_URL.

export type CourseSummary = components['schemas']['CourseSummary'];
export type CourseDetail = components['schemas']['CourseDetail'];
export type CourseManage = components['schemas']['CourseManage'];
export type CourseVisibility = components['schemas']['CourseVisibility'];
export type Enrolment = components['schemas']['Enrolment'];
export type Lesson = components['schemas']['Lesson'];
export type Heatmap = components['schemas']['Heatmap'];
export type HeatmapDay = components['schemas']['HeatmapDay'];
export type ActivityEvent = components['schemas']['ActivityEvent'];
export type CourseProgressSummary = components['schemas']['CourseProgressSummary'];
export type LessonProgressDetail = components['schemas']['LessonProgressDetail'];
export type ProgressState = components['schemas']['ProgressState'];
export type QuizSubmitRequest = components['schemas']['QuizSubmitRequest'];
export type QuizSubmitResult = components['schemas']['QuizSubmitResult'];
export type Submission = components['schemas']['Submission'];
export type SubmissionAnnotationInput = components['schemas']['SubmissionAnnotationInput'];
export type GradingQueueItem = components['schemas']['GradingQueueItem'];
export type GradeRequest = components['schemas']['GradeRequest'];
export type BadgeProgress = components['schemas']['BadgeProgress'];
export type DegreeProgress = components['schemas']['DegreeProgress'];
export type DegreeRequirement = components['schemas']['DegreeRequirement'];
export type CriterionProgress = components['schemas']['CriterionProgress'];
export type AwardNotice = components['schemas']['AwardNotice'];
export type AwardedBadge = components['schemas']['AwardedBadge'];
export type AwardedDegree = components['schemas']['AwardedDegree'];
export type Me = components['schemas']['Me'];
export type Profile = components['schemas']['Profile'];
export type ProfileSections = components['schemas']['ProfileSections'];
export type ProfileSettings = components['schemas']['ProfileSettings'];
export type ProfileSettingsUpdateRequest = components['schemas']['ProfileSettingsUpdateRequest'];
export type ProfileVisibility = components['schemas']['ProfileVisibility'];
export type ProfileSection = components['schemas']['ProfileSection'];
export type SectionVisibility = components['schemas']['SectionVisibility'];
export type ProfileBadge = components['schemas']['ProfileBadge'];
export type ProfileDegree = components['schemas']['ProfileDegree'];
export type ProfileCourse = components['schemas']['ProfileCourse'];
export type ProfileActivityEvent = components['schemas']['ProfileActivityEvent'];
export type ImportRunSummary = components['schemas']['ImportRunSummary'];
export type ImportProgressEvent = components['schemas']['ImportProgressEvent'];
export type ImportCounts = components['schemas']['ImportCounts'];
export type AuthUser = components['schemas']['AuthUser'];
export type Invite = components['schemas']['Invite'];
export type InviteKind = components['schemas']['InviteKind'];
export type InviteStatus = components['schemas']['InviteStatus'];
export type InviteCreateRequest = components['schemas']['InviteCreateRequest'];
export type IssuedInvite = components['schemas']['IssuedInvite'];
export type RevokedInvite = components['schemas']['RevokedInvite'];
export type InvitePreview = components['schemas']['InvitePreview'];
export type InviteAcceptRequest = components['schemas']['InviteAcceptRequest'];
export type InviteAcceptResult = components['schemas']['InviteAcceptResult'];
export type AuditEntry = components['schemas']['AuditEntry'];
export type AdminUser = components['schemas']['AdminUser'];
export type RoleAssignRequest = components['schemas']['RoleAssignRequest'];

// Re-exported so callers (Server Components deciding whether to redirect to
// /login) never need to import from ./api-errors directly — api.ts is the
// one seam that talks to the API, and this is the one error it can throw
// that isn't just "something is broken" (Task B).
export { AuthRequiredError } from './api-errors';

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }
  return base;
}

/**
 * Forwards the visitor's own session cookie to the API on a server-side
 * request. Every function in this module runs on the Next.js server (never
 * in the browser — see the client components that only ever import TYPES
 * from here), so `fetch` here is a server-to-server call that does NOT
 * automatically carry the browser's cookies the way a same-origin browser
 * fetch would. Without this, api/src/auth/actor.ts resolves every request
 * from web as the ANONYMOUS actor — which Phase 1-5 never noticed because
 * `can()` allowed everything, and Phase 6's real matrix denies most of it.
 * `next/headers`'s `cookies()` only works inside a request scope (a Server
 * Component render, a Server Action, a Route Handler); every caller below
 * is exactly one of those.
 */
async function authHeaders(): Promise<HeadersInit> {
  const store = await cookies();
  const header = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return header ? { Cookie: header } : {};
}

/**
 * Forwards the VISITOR's address to the API.
 *
 * Every call in this module is server-to-server: the browser talks to Next,
 * Next talks to the API. Without this, every request the API sees comes from
 * one address — web's — and every per-IP rate limit in api/src/auth/
 * rate-limit.ts degrades from "this visitor" to "everyone at once". For the
 * public profile route (design §11) that would mean one busy afternoon
 * locking the page for the whole instance; for the login route it silently
 * weakened the per-IP half of §13's two-key limiter in the same way.
 *
 * `x-forwarded-for` is appended to, not replaced, so the chain Caddy built
 * survives. The API only believes any of it when API_TRUST_PROXY is on
 * (api/src/index.ts) — off by default precisely so an unproxied deployment
 * cannot be told what address a request came from.
 */
async function forwardedHeaders(): Promise<HeadersInit> {
  const store = await headers();
  const forwardedFor = store.get('x-forwarded-for');
  const realIp = store.get('x-real-ip');
  const out: Record<string, string> = {};
  if (forwardedFor) out['x-forwarded-for'] = forwardedFor;
  else if (realIp) out['x-forwarded-for'] = realIp;
  if (realIp) out['x-real-ip'] = realIp;
  return out;
}

/**
 * The one place every authenticated request to the API goes through
 * (Task B). Every fetch helper below used to throw a bare `Error` on any
 * non-OK response — including a 403 from `can()` for a perfectly ordinary
 * anonymous visitor, which Next has no way to render but as a 500. Routing
 * every call through here means that bug can only be fixed once: a 401 (no
 * session) or 403 (can() said no) always becomes an `AuthRequiredError`,
 * for every caller, rather than depending on each function to have
 * remembered its own check.
 *
 * 404 is deliberately NOT handled here — "not found" and "not allowed to
 * even ask" are different answers (see courses.ts's 404-vs-403 line, design
 * §12), and only some callers 404 at all, so each of those decides for
 * itself via `res.status === 404`, same as `fetchCourse` always did.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    cache: 'no-store',
    ...init,
    headers: { ...(await authHeaders()), ...(await forwardedHeaders()), ...init.headers },
  });
  if (classifyStatus(res.status) === 'auth-required') {
    throw new AuthRequiredError();
  }
  return res;
}

export async function fetchCourses(): Promise<CourseSummary[]> {
  const res = await apiFetch('/api/v1/courses');
  if (!res.ok) {
    throw new Error(`Failed to fetch courses: ${res.status}`);
  }
  return (await res.json()) as CourseSummary[];
}

export async function fetchCourse(courseSlug: string): Promise<CourseDetail | null> {
  const res = await apiFetch(`/api/v1/courses/${encodeURIComponent(courseSlug)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as CourseDetail;
}

/**
 * Self-enrols the actor in a course (design §12). Returns null on a 403/404
 * — "not eligible right now" and "not found" are both states the caller
 * (the enrol button's Server Action) turns into a quiet, specific message
 * rather than a thrown error, since neither is exceptional from a reader's
 * point of view.
 */
export async function enrolInCourse(courseSlug: string): Promise<Enrolment> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/enrolments`, {
    method: 'POST',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to enrol in course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as Enrolment;
}

/** Un-enrols the actor from a course (design §12) — a soft withdrawal, not a hard delete. */
export async function unenrolFromCourse(courseSlug: string): Promise<Enrolment> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/enrolments`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to un-enrol from course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as Enrolment;
}

/**
 * Publishes/sets a course's visibility (Task C, design §12) — the owner's
 * or an admin's publish control. `can()` decides server-side; this is a
 * plain PATCH, not a re-implementation of that decision.
 */
export async function setCourseVisibility(courseSlug: string, visibility: CourseVisibility): Promise<CourseManage> {
  const res = await fetch(`${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to update visibility for course "${courseSlug}": ${res.status}`));
  }
  return (await res.json()) as CourseManage;
}

/**
 * The actor's activity heatmap. `weeks` is a trailing window ending today;
 * the API clamps it to [1, 53] and zero-fills every day in between, so the UI
 * never infers a gap. We ask for the full year and let CSS decide how much of
 * it is visible without scrolling — see src/lib/heatmap.ts for why.
 */
export async function fetchHeatmap(weeks: number): Promise<Heatmap> {
  const res = await apiFetch(`/api/v1/me/heatmap?weeks=${encodeURIComponent(String(weeks))}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch heatmap: ${res.status}`);
  }
  return (await res.json()) as Heatmap;
}

export async function fetchLesson(courseSlug: string, lessonSlug: string): Promise<Lesson | null> {
  const res = await apiFetch(
    `/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch lesson "${lessonSlug}" in course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as Lesson;
}

/**
 * The actor's recent activity feed, newest first (design §10). `limit` is
 * left to the API's own default/clamp ([1, 100], default 20) when omitted.
 */
export async function fetchActivity(limit?: number): Promise<ActivityEvent[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await apiFetch(`/api/v1/me/activity${query}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch activity: ${res.status}`);
  }
  return (await res.json()) as ActivityEvent[];
}

/**
 * The actor's badges — EARNED AND LOCKED, in that order (design §9.3).
 *
 * Locked ones are not filtered out here or in the API: "a badge nobody can
 * see is not a goal", and each carries the scalar progress the dashboard
 * renders as "3 of 5 lessons".
 */
export async function fetchMyBadges(): Promise<BadgeProgress[]> {
  const res = await apiFetch('/api/v1/me/badges');
  if (!res.ok) {
    throw new Error(`Failed to fetch badges: ${res.status}`);
  }
  return (await res.json()) as BadgeProgress[];
}

/** The actor's degrees, earned and in progress (design §9.2). */
export async function fetchMyDegrees(): Promise<DegreeProgress[]> {
  const res = await apiFetch('/api/v1/me/degrees');
  if (!res.ok) {
    throw new Error(`Failed to fetch degrees: ${res.status}`);
  }
  return (await res.json()) as DegreeProgress[];
}

/** The actor's progress summary for a course: totals, percent, and every lesson's state. */
export async function fetchCourseProgress(courseSlug: string): Promise<CourseProgressSummary | null> {
  const res = await apiFetch(`/api/v1/courses/${encodeURIComponent(courseSlug)}/progress`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch progress for course "${courseSlug}": ${res.status}`);
  }
  return (await res.json()) as CourseProgressSummary;
}

/** The actor's own profile — id, display name, and effective timezone (design §15). */
export async function fetchMe(): Promise<Me> {
  const res = await apiFetch('/api/v1/me');
  if (!res.ok) {
    throw new Error(`Failed to fetch me: ${res.status}`);
  }
  return (await res.json()) as Me;
}

// =============================================================================
// PROFILES (design §11, Phase 12).
// =============================================================================

/**
 * A learner's public profile page (design §11).
 *
 * Deliberately NOT routed through `apiFetch`: this is the one page in the app
 * that a signed-out visitor is supposed to be able to read, so a missing
 * session must render the anonymous view rather than redirect to /login. The
 * session cookie is still forwarded when there IS one — that is what makes
 * the API serve the owner's or a peer's view instead.
 *
 * 404 becomes null: an unknown handle and an account with no learner profile
 * answer identically by design, and the page renders Next's notFound() for
 * both.
 */
export async function fetchProfile(handle: string): Promise<Profile | null> {
  const res = await fetch(`${apiBase()}/api/v1/profiles/${encodeURIComponent(handle)}`, {
    cache: 'no-store',
    headers: { ...(await authHeaders()), ...(await forwardedHeaders()) },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch profile "${handle}": ${res.status}`);
  }
  return (await res.json()) as Profile;
}

/** The actor's own profile settings — bio, noindex, and the five section toggles. */
export async function fetchProfileSettings(): Promise<ProfileSettings> {
  const res = await apiFetch('/api/v1/me/profile');
  if (!res.ok) {
    throw new Error(`Failed to fetch profile settings: ${res.status}`);
  }
  return (await res.json()) as ProfileSettings;
}

/**
 * Saves any subset of the actor's profile settings. Not routed through
 * `apiFetch`: a 400 (an unknown section, an over-long bio) is an ordinary
 * outcome the settings form shows as a message, not an auth failure.
 */
export async function updateProfileSettings(body: ProfileSettingsUpdateRequest): Promise<ProfileSettings> {
  const res = await fetch(`${apiBase()}/api/v1/me/profile`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to save profile settings: ${res.status}`));
  }
  return (await res.json()) as ProfileSettings;
}

/** Import run history, newest first (design plan phase 5's admin screen). */
export async function fetchImportRuns(limit?: number): Promise<ImportRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await apiFetch(`/api/v1/admin/import-runs${query}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch import runs: ${res.status}`);
  }
  return (await res.json()) as ImportRunSummary[];
}

// =============================================================================
// INVITATIONS AND ADMINISTRATION (design §12, §5).
//
// The list, the roster and the audit log go through `apiFetch`, so a
// student who types /invites into the address bar meets the same
// AuthRequiredError redirect every other role-gated page uses. The three
// MUTATIONS do not: "your budget is 0", "you do not own that course" and
// "that invitation was already accepted" are ordinary outcomes the form
// must show WITHOUT throwing away what the issuer typed — the same reason
// gradeSubmission and saveSubmissionDraft bypass it.
// =============================================================================

/**
 * Every invite for an admin; a teacher's own for a teacher (design §12:
 * "admins get a screen listing every invite with issuer and status").
 * Expired invites are refunded by the API in passing.
 */
export async function fetchInvites(limit?: number): Promise<Invite[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await apiFetch(`/api/v1/invites${query}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch invitations: ${res.status}`);
  }
  return (await res.json()) as Invite[];
}

/**
 * Whether this actor may see the invitations screen at all — the layout's
 * answer to "should Nav's Invitations destination render". Same shape as
 * `fetchIsTeacher`: ask the API's own `invite:list` floor and treat a
 * refusal as "no", never as an error, because the shell renders for
 * everybody.
 */
export async function fetchCanInvite(): Promise<boolean> {
  try {
    await fetchInvites(1);
    return true;
  } catch (err) {
    if (err instanceof AuthRequiredError) return false;
    throw err;
  }
}

export type IssueInviteResult = { ok: true; issued: IssuedInvite } | { ok: false; message: string };

/** Issues one invitation. The token comes back exactly once, in `issued.token`. */
export async function createInvite(body: InviteCreateRequest): Promise<IssueInviteResult> {
  const res = await fetch(`${apiBase()}/api/v1/invites`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, message: await errorMessage(res, `Could not issue that invitation: ${res.status}`) };
  }
  return { ok: true, issued: (await res.json()) as IssuedInvite };
}

export type RevokeInviteResult = { ok: true; revoked: RevokedInvite } | { ok: false; message: string };

/** Revokes an invitation, returning its unit of budget if it took one (design §12). */
export async function revokeInvite(inviteId: string): Promise<RevokeInviteResult> {
  const res = await fetch(`${apiBase()}/api/v1/invites/${encodeURIComponent(inviteId)}/revoke`, {
    method: 'POST',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    return { ok: false, message: await errorMessage(res, `Could not revoke that invitation: ${res.status}`) };
  }
  return { ok: true, revoked: (await res.json()) as RevokedInvite };
}

/**
 * What a link is for, before anyone accepts it. Unauthenticated by design
 * (the token is the credential), so this is NOT routed through `apiFetch`:
 * a dead link answers 410 and the accept page says so, rather than
 * bouncing a signed-out invitee to /login.
 */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  const res = await fetch(`${apiBase()}/api/v1/invites/lookup?token=${encodeURIComponent(token)}`, {
    cache: 'no-store',
    headers: { ...(await authHeaders()), ...(await forwardedHeaders()) },
  });
  if (res.status === 410 || res.status === 400) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to look up that invitation: ${res.status}`);
  }
  return (await res.json()) as InvitePreview;
}

export type AcceptInviteResult = { ok: true; result: InviteAcceptResult } | { ok: false; message: string };

/**
 * Accepts an invitation: registers the account and enrols it where a course
 * is attached, in one call (design §12). No session comes back — acceptance
 * is not a login — so the accept page signs the new account in afterwards
 * with the credentials it just set, which is what makes it one flow.
 */
export async function acceptInvite(body: InviteAcceptRequest): Promise<AcceptInviteResult> {
  const res = await fetch(`${apiBase()}/api/v1/invites/accept`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(await forwardedHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, message: await errorMessage(res, `Could not accept that invitation: ${res.status}`) };
  }
  return { ok: true, result: (await res.json()) as InviteAcceptResult };
}

/** The audit log, newest first (design §12), optionally filtered to one action. */
export async function fetchAuditLog(options: { limit?: number; action?: string } = {}): Promise<AuditEntry[]> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.action) params.set('action', options.action);
  const query = params.toString();
  const res = await apiFetch(`/api/v1/admin/audit${query ? `?${query}` : ''}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch the audit log: ${res.status}`);
  }
  return (await res.json()) as AuditEntry[];
}

/** Every account with its roles and invite budget — the roster the two admin mutations act on. */
export async function fetchAdminUsers(limit?: number): Promise<AdminUser[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await apiFetch(`/api/v1/admin/users${query}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch accounts: ${res.status}`);
  }
  return (await res.json()) as AdminUser[];
}

/**
 * Whether this actor holds the operator role (design §5.1) — the shell's
 * answer to "should Nav's Admin destination render". Asked the same way as
 * `fetchIsTeacher` and `fetchCanInvite`: put the API's own `user:list`
 * floor, an admin-only cell of the §5 matrix, and treat a refusal as "no".
 */
export async function fetchIsAdmin(): Promise<boolean> {
  try {
    await fetchAdminUsers(1);
    return true;
  } catch (err) {
    if (err instanceof AuthRequiredError) return false;
    throw err;
  }
}

export type AdminUserResult = { ok: true; user: AdminUser } | { ok: false; message: string };

async function adminUserMutation(path: string, body: unknown, fallback: string): Promise<AdminUserResult> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, message: await errorMessage(res, `${fallback}: ${res.status}`) };
  }
  return { ok: true, user: (await res.json()) as AdminUser };
}

/**
 * Grants or revokes one role (design §5). A 409 here is §5.1's exclusivity —
 * "admin is exclusive of student and teacher" — and the API's own sentence
 * explaining it is what the screen shows.
 */
export async function setUserRole(userId: string, body: RoleAssignRequest): Promise<AdminUserResult> {
  return adminUserMutation(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/roles`,
    body,
    'Could not change that role',
  );
}

/** Sets an account's platform-invite budget to an absolute number (design §12). */
export async function setInviteBudget(userId: string, budget: number): Promise<AdminUserResult> {
  return adminUserMutation(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/invite-budget`,
    { budget },
    'Could not set that budget',
  );
}

/**
 * The actor's own profile, or null if there is no session — used by the
 * shell (Task D) to decide between "Sign in" and a Sign-out control without
 * a 403 turning into a page-level redirect: the shell renders on every page,
 * signed in or not, so it must never throw where a page's own data-loading
 * would.
 */
export async function fetchMeOrNull(): Promise<Me | null> {
  try {
    return await fetchMe();
  } catch (err) {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Marks a lesson complete for the actor. Only `kind: "lesson"` may be
 * completed this way — the API returns 409 for an exercise or quiz, since
 * those complete on submission/passing in later phases. Callers that only
 * ever show this control for `kind === 'lesson'` should not see the 409 in
 * practice, but we surface the API's own message rather than assume.
 */
export async function markLessonComplete(courseSlug: string, lessonSlug: string): Promise<LessonProgressDetail> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/progress`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
      body: JSON.stringify({ state: 'complete' }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to mark lesson "${lessonSlug}" complete: ${res.status}`));
  }
  return (await res.json()) as LessonProgressDetail;
}

/**
 * Submits a quiz attempt for scoring (design §9.1: quizzes are
 * machine-scored server-side; the browser never decides pass/fail). On a
 * pass, completes the lesson and emits a quiz_passed activity event —
 * idempotently, so retaking after already passing never double-completes.
 */
export async function submitQuizAttempt(
  courseSlug: string,
  lessonSlug: string,
  answers: QuizSubmitRequest['answers'],
): Promise<QuizSubmitResult> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/quiz`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
      body: JSON.stringify({ answers }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to submit quiz for lesson "${lessonSlug}": ${res.status}`));
  }
  return (await res.json()) as QuizSubmitResult;
}

/**
 * The actor's own exercise submission (design §9.4). Like `fetchLesson`,
 * routed through `apiFetch` so a missing/insufficient session redirects to
 * sign-in (Task B) rather than surfacing as an error the lesson page has no
 * way to render. 404 means "not started yet" — a real, common state, not a
 * failure — and becomes `null`, exactly as `fetchCourse` and `fetchLesson`
 * already treat their own 404s.
 */
export async function fetchSubmission(courseSlug: string, lessonSlug: string): Promise<Submission | null> {
  const res = await apiFetch(
    `/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/submission`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch submission for lesson "${lessonSlug}": ${res.status}`);
  }
  return (await res.json()) as Submission;
}

/**
 * Saves a draft of the actor's exercise submission (design §9.4). Replaces
 * the annotation set wholesale — the caller sends every annotation it wants
 * kept, every save. Not routed through `apiFetch`: like `markLessonComplete`
 * and `submitQuizAttempt`, a refusal here (400 bad anchor, 409 already
 * submitted/returned) is an ordinary outcome the caller (ExercisePanel) shows
 * as a message, not a redirect-worthy auth failure.
 */
export async function saveSubmissionDraft(
  courseSlug: string,
  lessonSlug: string,
  annotations: SubmissionAnnotationInput[],
): Promise<Submission> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/submission`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
      body: JSON.stringify({ annotations }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to save submission draft for lesson "${lessonSlug}": ${res.status}`));
  }
  return (await res.json()) as Submission;
}

/**
 * Submits the actor's exercise (design §9.1/§9.4). Completes the lesson and
 * freezes the snapshot the reader renders from thereafter. Idempotent on the
 * API side — a retried submit returns the same submission rather than
 * erroring — so this never needs to guard against a double click itself.
 */
export async function submitSubmission(courseSlug: string, lessonSlug: string): Promise<Submission> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/submission/submit`,
    {
      method: 'POST',
      headers: await authHeaders(),
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to submit lesson "${lessonSlug}": ${res.status}`));
  }
  return (await res.json()) as Submission;
}

// =============================================================================
// GRADING (design §9.4, Phase 9). Everything below is the TEACHER'S half of
// the submissions API — routes/submissions.ts's grading section.
// =============================================================================

/**
 * Every submission awaiting review across courses the actor owns (design
 * §9.4), oldest first. Routed through `apiFetch` like every other
 * route-guarded page fetch (Task B): a signed-out visitor or a student gets
 * 403 from `submission:queue:read`, and that becomes `AuthRequiredError`
 * here exactly like a 403 anywhere else in this client — the /grading page
 * redirects to sign-in on it via `withAuthRedirect`, and the root layout
 * (`fetchIsTeacher` below) instead treats it as "not a teacher".
 */
export async function fetchGradingQueue(): Promise<GradingQueueItem[]> {
  const res = await apiFetch('/api/v1/grading/queue');
  if (!res.ok) {
    throw new Error(`Failed to fetch grading queue: ${res.status}`);
  }
  return (await res.json()) as GradingQueueItem[];
}

/**
 * Whether the actor can reach the grading queue at all — the root layout's
 * answer to "should Nav's Grading destination render" (design §9.4: "do not
 * show it to students"). There is no `roles` field on Me to check directly
 * (web has no database access of its own, CLAUDE.md rule 1), so this asks
 * the API's own `submission:queue:read` role floor the same question
 * `fetchGradingQueue` does, and treats an auth failure as "no" rather than
 * letting it propagate — the shell renders for every visitor, signed in or
 * not, so it must never throw where a page's own data-loading would.
 */
export async function fetchIsTeacher(): Promise<boolean> {
  try {
    await fetchGradingQueue();
    return true;
  } catch (err) {
    if (err instanceof AuthRequiredError) return false;
    throw err;
  }
}

/**
 * A teacher's view of one student's submission (design §9.4). Same payload
 * `fetchSubmission` returns to the student themself, including
 * `rubricScores`. Routed through `apiFetch`: a course the actor does not
 * own answers 403 from `submission:grade`, which becomes `AuthRequiredError`
 * here — the grading page redirects to sign-in on it via
 * `withAuthRedirect`, the same treatment every other ownership-gated page in
 * this app already gives a 403 (e.g. `fetchCourse`). 404 means this student
 * has no submission for this lesson — a real, common state (they haven't
 * done the exercise), not a failure — and becomes `null`.
 */
export async function fetchSubmissionForGrading(
  courseSlug: string,
  lessonSlug: string,
  userId: string,
): Promise<Submission | null> {
  const res = await apiFetch(
    `/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/submissions/${encodeURIComponent(userId)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch submission for grading: ${res.status}`);
  }
  return (await res.json()) as Submission;
}

/**
 * Scores rubric criteria and/or adds annotations (replies and top-level
 * flags), then returns the submission (design §9.4, Task C) — every call,
 * including a re-grade, moves `status` to `returned`. Not routed through
 * `apiFetch`: like `saveSubmissionDraft`, a refusal here (400 malformed
 * input or an incomplete rubric, 409 still a draft) is an ordinary outcome
 * the grading form shows as a message WITHOUT discarding what the teacher
 * typed, not an auth failure to redirect away from.
 */
export async function gradeSubmission(
  courseSlug: string,
  lessonSlug: string,
  userId: string,
  body: GradeRequest,
): Promise<Submission> {
  const res = await fetch(
    `${apiBase()}/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/submissions/${encodeURIComponent(userId)}/grade`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to grade submission: ${res.status}`));
  }
  return (await res.json()) as Submission;
}

// =============================================================================
// Task C/D: the four routes that create or destroy a session
// (api/src/routes/auth.ts). Unlike everything above, these are deliberately
// NOT routed through apiFetch: a 401 from a bad login attempt is the whole
// point of the login form, not a bug to redirect away from, and it must
// never surface as an AuthRequiredError. Every response that sets cookies is
// relayed onto web's own response — see auth-cookies.ts's module comment for
// why that has to happen explicitly.
// =============================================================================

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; message: string; retryAfterSeconds?: number };

/**
 * Signs in with email + password (Task C). Never throws on an ordinary
 * credential failure — the login form shows the API's own message (design
 * §13: identical whether the account doesn't exist or the password is
 * wrong, so this surfaces it verbatim rather than adding a distinction the
 * API deliberately does not make).
 */
export async function login(email: string, password: string, deviceLabel?: string): Promise<LoginResult> {
  const res = await fetch(`${apiBase()}/api/v1/auth/login`, {
    method: 'POST',
    cache: 'no-store',
    // The visitor's address goes with it: §13's limiter counts per IP as
    // well as per account, and without this every login on the instance
    // would share one counter.
    headers: { 'Content-Type': 'application/json', ...(await forwardedHeaders()) },
    body: JSON.stringify({ email, password, deviceLabel }),
  });

  if (res.ok) {
    await relaySetCookies(res);
    const body = (await res.json()) as components['schemas']['AuthSessionResponse'];
    return { ok: true, user: body.user };
  }

  const message = await errorMessage(res, 'Could not sign in.');
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    return { ok: false, message, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined };
  }
  return { ok: false, message };
}

/**
 * Ends the current session (Task D's Sign-out control). Keyed off the
 * refresh cookie by the API itself, not the actor, so this always succeeds —
 * signing out is never an error (api/src/routes/auth.ts) — and always clears
 * web's own cookies to match, even if the API had nothing to revoke.
 */
export async function logout(): Promise<void> {
  const res = await fetch(`${apiBase()}/api/v1/auth/logout`, {
    method: 'POST',
    cache: 'no-store',
    headers: await authHeaders(),
  });
  await relaySetCookies(res);
}
