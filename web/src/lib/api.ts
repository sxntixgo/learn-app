import { cookies } from 'next/headers';
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
export type Me = components['schemas']['Me'];
export type ImportRunSummary = components['schemas']['ImportRunSummary'];
export type ImportProgressEvent = components['schemas']['ImportProgressEvent'];
export type ImportCounts = components['schemas']['ImportCounts'];
export type AuthUser = components['schemas']['AuthUser'];

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
    headers: { ...(await authHeaders()), ...init.headers },
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

/** Import run history, newest first (design plan phase 5's admin screen). */
export async function fetchImportRuns(limit?: number): Promise<ImportRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const res = await apiFetch(`/api/v1/admin/import-runs${query}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch import runs: ${res.status}`);
  }
  return (await res.json()) as ImportRunSummary[];
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
    headers: { 'Content-Type': 'application/json' },
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
