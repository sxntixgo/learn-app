import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthRequiredError, fetchMeOrNull, fetchSearch } from '../../src/lib/api';
import { loginRedirectPath } from '../../src/lib/next-path';
import styles from './search.module.css';

export const metadata: Metadata = {
  title: 'Search — Learn App',
};

/*
 * Search (design §16, plan Phase 16 task 2). A plain `<form method="get">`
 * reading `?q=`, same idiom as /admin/audit's filter (that page's own
 * comment: "a query parameter the server already reads is exactly what a
 * GET form is for, and it keeps this screen working with no JavaScript") —
 * no client component, no fetch-on-keystroke, so there is nothing here that
 * needs the CSP's script-src nonce and nothing that can trap keyboard focus.
 *
 * `search:query` (api/src/policy/can.ts) carries exactly `course:list`'s
 * grant — student only — so a teacher-only or admin account 403s here the
 * same way it would on the catalog. The Nav destination itself is hidden
 * from such an account already (web/src/lib/nav.ts's `restrictedToSearch`,
 * app/layout.tsx's `fetchCanSearch`); this page is the second layer, for
 * whoever reaches the URL directly anyway.
 *
 * NOT `withAuthRedirect` — deliberately. Every other role-gated page
 * (/grading, /admin/*, /invites) wraps its fetch in `withAuthRedirect`,
 * which turns ANY 403 into `redirect('/login?next=<path>')`. That is
 * correct for an anonymous visitor, but for an already-signed-in account
 * that merely lacks the role, it is a real, reproducible infinite redirect
 * loop: /login sees a live session and immediately redirects back to
 * `next` (login/page.tsx: "already signed in: land where they were
 * headed"), which 403s again, forever — confirmed empirically against
 * /grading with a non-teacher session before writing this page
 * (`net::ERR_TOO_MANY_REDIRECTS`). That bug predates this task and is out
 * of scope to fix everywhere it's reachable (no backend or shared-lib
 * changes here), but there is no reason to copy a known-broken pattern
 * into new code, so this page tells the two cases apart itself: no
 * session at all still redirects to sign-in (the one case that terminates);
 * a real session that `search:query` refuses gets a plain sentence instead
 * of a loop.
 *
 * Two distinct EMPTY states (plan's acceptance line: "empty and no-results
 * states are real sentences" — deliberately two, not one):
 *   - nothing typed yet (`q` blank/missing) — a sentence inviting a search,
 *     never rendered alongside a query the API never ran.
 *   - a real query that matched nothing (`groups` is empty AND `q` is not
 *     blank) — a different sentence, naming the query back and suggesting
 *     what to try, not a bare "No results."
 * `fetchSearch` is called unconditionally (even for a blank `q`) rather
 * than short-circuited here, because the API's own 403 floor check runs
 * before it looks at `q` (api/src/routes/search.ts) — skipping the call for
 * a blank query would also skip the one request that proves a directly
 * visited /search still enforces the role floor.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '';
  const hasQuery = q.trim() !== '';

  const me = await fetchMeOrNull();
  if (!me) {
    redirect(loginRedirectPath('/search'));
  }

  let results;
  try {
    results = await fetchSearch(q);
  } catch (err) {
    if (!(err instanceof AuthRequiredError)) throw err;
    // A real session that `search:query` refuses (teacher-only or admin —
    // see the module comment above). Not a redirect: this account will
    // never pass that floor by signing in again.
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Search</h1>
        <p className={styles.empty}>
          Search isn&rsquo;t available for this account. If that seems wrong, ask whoever administers this instance.
        </p>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Search</h1>
      <p className={styles.intro}>Find a lesson by title or by words in its text, across every course you can see.</p>

      <form method="get" action="/search" className={styles.form} role="search">
        <label htmlFor="search-q" className={styles.label}>
          Search lessons
        </label>
        <div className={styles.inputRow}>
          <input
            id="search-q"
            name="q"
            type="search"
            defaultValue={q}
            className={styles.input}
            placeholder="e.g. recursion, photosynthesis…"
            maxLength={200}
          />
          <button type="submit" className={styles.submitButton}>
            Search
          </button>
        </div>
      </form>

      {!hasQuery ? (
        <p className={styles.empty}>
          Type a word or phrase above and press Search to look through lesson titles and text.
        </p>
      ) : results.groups.length === 0 ? (
        <p className={styles.empty}>
          No lessons matched &ldquo;{q}&rdquo;. Try a different word, check the spelling, or search for something
          more general.
        </p>
      ) : (
        <div className={styles.results}>
          {results.groups.map((group) => (
            <section key={group.courseSlug} className={styles.group} aria-labelledby={`group-${group.courseSlug}`}>
              <h2 id={`group-${group.courseSlug}`} className={styles.groupTitle}>
                {group.courseTitle}
              </h2>
              <ul className={styles.lessonList}>
                {group.lessons.map((lesson) => (
                  <li key={lesson.lessonSlug}>
                    <Link
                      href={`/courses/${encodeURIComponent(group.courseSlug)}/lessons/${encodeURIComponent(lesson.lessonSlug)}`}
                      className={styles.lessonCard}
                    >
                      <span className={styles.lessonTitle}>{lesson.title}</span>
                      {/*
                       * `lesson.snippet` is server-rendered by
                       * api/src/search/query.ts's `renderSnippet`: the raw
                       * prose text is HTML-escaped FIRST (every `&`, `<`,
                       * `>`, `"`, `'` becomes an entity), and only THEN are
                       * the two control-character sentinels turned into
                       * literal `<mark>`/`</mark>` tags. Because escaping
                       * happens before the sentinels are restored, any `<`
                       * or `>` that was genuinely part of the lesson prose
                       * (an escaped entity decoded back to a real character,
                       * or an author literally writing "3 < 5") is already
                       * `&lt;`/`&gt;` by the time this string is built, so
                       * it cannot introduce a third tag here — `<mark>` is
                       * structurally the only markup this string can ever
                       * contain. That is what makes rendering it as HTML
                       * safe rather than merely convenient.
                       */}
                      <span
                        className={styles.lessonSnippet}
                        dangerouslySetInnerHTML={{ __html: lesson.snippet }}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
