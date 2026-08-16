# Learning Platform — Implementation Plan

**Date:** 2026-08-15
**Design:** [`2026-08-15-learning-platform-design.md`](./2026-08-15-learning-platform-design.md)
**Palette:** [`../design/CHOSEN-PALETTE.md`](../design/CHOSEN-PALETTE.md)
**Repo state at planning time:** empty (`learn-app` has no commits; only `docs/`)

---

## Goal

Build a self-hosted learning platform where students read markdown courses imported from
separate git repositories, track progress, submit annotated exercises for teacher grading,
and earn badges and nanodegrees — beautiful on phone, iPad, and desktop.

## Shipping order

**Phase 1 is the MVP: read a real lesson on your iPad.** It is a walking skeleton — one
markdown file, through the real parser, into the real database, rendered with the real
palette, served by the real compose stack. Thin, but end-to-end, so every later phase
thickens something that already works rather than adding another layer of foundation.

Multi-user concerns — auth, roles, enrollment — are deferred to **Phase 6**. This is safe
only because of one discipline established in Phase 1:

> **The policy seam exists from the first commit.** Every API handler takes an `actor`
> argument and asks `can(actor, action, resource)`. Until Phase 6, `actor` is a hardcoded
> development user. Adding real auth then means *populating* `actor` — not rewriting
> handlers. Any handler that skips this is a bug, not a shortcut.

> ⚠️ **Do not expose the app beyond localhost or your LAN before Phase 6 is complete.**
> Phases 1–5 have no authentication and an unhardened importer. Phase 6's gate is the
> point at which putting it behind public Caddy is safe.

## Success criteria

1. **(Phase 1)** A real lesson from a real repo renders legibly on the iPad
2. **(Phase 2)** A whole course imports from a local directory and can be browsed
3. **(Phase 3)** Progress, streaks, and the heatmap reflect real activity in your timezone
4. **(Phase 5)** Pointing at a git URL imports it; a broken manifest fails with `file:line`
5. **(Phase 6)** First account claims admin via setup token; students enroll from a catalog
6. **(Phase 9)** A student submits an annotated exercise; a teacher replies and scores a rubric
7. **(throughout)** Re-importing never damages progress, submissions, or awarded badges

## Hard constraints

- `web` container **never** receives `DATABASE_URL` (design §4)
- Plain SQL migrations, OpenAPI as the committed contract, EdDSA JWT — the three things that
  keep the Go migration path cheap (design §4.1)
- Repo is **public**: no secrets, no personal email, no fixtures with real data (design §16)
- Postgres is the only volume

## Model assignment rubric

Every task names the model to run it with. The rule, so assignments are re-derivable rather
than arbitrary:

| Model | Use for | Typical work |
|---|---|---|
| **haiku** | Mechanical and fully specified. Getting it wrong is obvious and cheap | Config files, boilerplate, codegen wiring, simple CRUD, small presentational components |
| **sonnet** | The default. Real implementation with contained judgement | Parsers, endpoints, components, tests, migrations, integration work |
| **opus** | Where a subtle mistake is expensive or hard to detect | Security boundaries, auth and token handling, data-integrity invariants, untrusted input, novel UX with no reference to copy |

Three categories earn **opus** specifically: **(a) security-critical** — anything touching
untrusted input, authentication, or a visibility boundary; **(b) data-integrity
invariants** — code where a subtle bug silently corrupts history rather than failing loudly;
**(c) genuinely novel UX** — components with no existing reference implementation to work
from.

---

## Phase 1 — Walking skeleton (MVP)

*One lesson, end to end, on the iPad. Deliberately thin in every dimension except depth.*

- [ ] **Compose stack** — `docker/docker-compose.yml` (`db` postgres:17 + named volume, `api`, `web`), `.env.example`, `.gitignore`, `docker/Caddyfile.example` routing `/api/*` → `api`
      **Acceptance:** `docker compose up -d` leaves all services healthy; `docker compose config` shows **no** `DATABASE_URL` under `web`; `git status` never lists `.env`
      **Model:** `haiku`
- [ ] **Migration runner + `0001`** — plain SQL from `db/migrations/`, creating `lessons (id, slug, title, blocks jsonb)`
      **Acceptance:** running the migrate service twice is a no-op the second time; `schema_migrations` shows one version
      **Model:** `sonnet`
- [ ] **Markdown → blocks** for `prose` and `code` only, in `api/src/content/`
      **Acceptance:** snapshot test converts a fixture lesson to the expected block JSON
      **Model:** `sonnet`
- [ ] **`tools/seed`** loading one local `.md` file into `lessons`
      **Acceptance:** run against a local clone of `claudecode-documentation`; exactly one row appears
      **Model:** `haiku`
- [ ] **`GET /api/v1/lessons/:slug`** — takes an `actor` and calls `can()`, with `actor` hardcoded and `can()` returning true
      **Acceptance:** `curl` returns the block array; a test asserts the handler calls `can()` — this seam is the whole reason auth can be deferred
      **Model:** `sonnet`
- [ ] **OpenAPI contract** — `openapi/openapi.yaml` with that one path, plus generated client types
      **Acceptance:** `npm run gen:api` produces types; CI fails when committed types are stale
      **Model:** `haiku`
- [ ] **Reader page** rendering `prose` and `code`, Shiki highlighting at render time
      **Acceptance:** the lesson renders with correct highlighting; nothing highlighted at import time
      **Model:** `sonnet`
- [ ] **Minimal tokens** from `CHOSEN-PALETTE.md` — three self-hosted subset fonts, light/dark colours, 46ch prose measure
      **Acceptance:** page matches `docs/design/9a-light.png` in type and colour; dark scheme swaps correctly; loads with third-party hosts blocked
      **Model:** `sonnet`
- [ ] **CI** — lint, typecheck, test on push
      **Acceptance:** green on a trivial PR
      **Model:** `haiku`

> **Gate 1 — the MVP.** Bring it up on the WSL host and read that lesson on your iPad over
> the LAN. Judge it honestly: does the type feel right, is the code legible at that width,
> is the prose measure comfortable? Everything later assumes yes.

### Phase 1 outcome (built 2026-08-15)

**Status: complete except the two checks that need Docker / the iPad.**

Verified here: 18 tests passing, lint and typecheck clean, migration idempotent, API boots
and serves a real 87-block lesson (43 prose / 44 code), reader page renders at 200 with 44
Shiki-highlighted blocks, fonts self-hosted with no external requests, `web` has no
database access, no credentials in any committable file.

**Still to verify on the WSL host** — these could not run in the dev container (no Docker):

- [ ] `docker compose -f docker/docker-compose.yml up` brings all four services healthy
- [ ] `docker compose config` confirms `web` has no `DATABASE_URL` *(verified statically here)*
- [ ] Read the lesson on the iPad over the LAN — **this is the actual Gate 1 judgement**

**Deviations from plan, and why:**

| Deviation | Reason |
|---|---|
| Dev container runs Node + Postgres natively, not in Docker | Docker unavailable in the container; compose files are authored but unverified |
| Relative imports use `.ts`, not `.js` | `.js` imports pass tests (vitest resolves them) but the server cannot boot. See CLAUDE.md |
| `gen:api:check` hardened to require the generated file be tracked | As written it was vacuous — `git diff` on an untracked file always passes |
| `vitest fileParallelism: false` | DB-touching test files share one test database and raced |
| Prose 46ch / code 70ch as two sibling max-widths | Interim. The real breakout-container system is Phase 4 |
| Palette ranges collapsed to midpoints (`0.92`, `0.775`) | `CHOSEN-PALETTE.md` gives ranges; CSS custom properties need one value. **Confirm at Gate 1** |

**New work discovered, for later phases:**

- [ ] Existing content uses ```mermaid fences, currently rendered as plain code. A `diagram`
      block type is worth considering in Phase 10 alongside `chart` and `figure`.
      **Model:** `sonnet`
- [ ] `web/tsconfig.json` is Next-generated and sits outside the root composite project, so
      `npm run typecheck` does not cover it — `next build` does. Consider unifying in Phase 4.
      **Model:** `haiku`

---

## Phase 2 — Real courses from a local directory

- [ ] **Content schema** — `content_repos`, `courses`, `tracks`, `modules`, `lessons` (extended), `import_runs`
      **Acceptance:** unique index exists on `lessons (course_id, module_key, lesson_key)`
      **Model:** `sonnet`
- [ ] **JSON Schemas** for `course.yaml` and the block array, committed
      **Acceptance:** schemas accept good fixtures and reject bad ones with a useful error path
      **Model:** `sonnet`
- [ ] **Fenced-block parser** plus in-source annotation markers (`# [!note cx] …`)
      **Acceptance:** fixtures per block type; a test asserts marker comments are **stripped** from rendered source
      **Model:** `sonnet`
- [ ] **`tools/validate` CLI** running the same pipeline against a local directory
      **Acceptance:** exit 0 on a good fixture; exit 1 on a broken one with `file:line` in stderr
      **Model:** `sonnet`
- [ ] **Import transaction** from a local directory — upsert on natural key, archive missing lessons, skip unchanged via `content_hash`
      **Acceptance:** importing twice touches 0 rows the second time; removing a lesson from the manifest sets `archived_at` rather than deleting; an existing `lesson_progress` row still resolves afterward
      **Model:** `opus` — *(b) data integrity: a subtle bug here silently orphans progress instead of failing*
- [ ] **`tools/scaffold`** drafting a `course.yaml` from an existing tree *(natural first Go project — design §4.1)*
      **Acceptance:** run against a copy of `claudecode-documentation`; output validates against the schema
      **Model:** `sonnet`
- [ ] **Course and module navigation** with next/previous
      **Acceptance:** traversal follows manifest order; archived lessons are unreachable
      **Model:** `sonnet`
- [ ] **Retrofit and import one real repo**
      **Acceptance:** lesson count matches the manifest; spot-check three lessons
      **Model:** `sonnet`

> **Gate 2.** Browse a whole real course on the iPad. Review the `import_runs` log before
> importing the rest.

### Phase 2 outcome (built 2026-08-16)

**Status: complete.** 96 tests passing, lint and typecheck clean, CI green.

Verified here against a real 61-lesson retrofit of `claudecode-documentation`:

- Re-import rewrites nothing — fingerprint over every lesson id/slug/timestamp identical
- A failed import leaves the database **byte-identical**, and still writes a `failed`
  `import_runs` row carrying the error
- Errors name the file and the cause (e.g. an undeclared track, listing the declared ones)
- Archived lessons are invisible: direct fetch 404s, catalog count drops, restore brings back
- `prev`/`next` traverse the whole course, crossing module boundaries
- Annotation markers extract correctly while leaving ordinary `#` comments in 8 real bash
  blocks untouched, and identical-looking markers in prose alone
- Round trip proven: `scaffold` → `validate` → `import` → idempotent re-import

**Deviations from plan, and why:**

| Deviation | Reason |
|---|---|
| No general tagged-fence registry | Phase 2's block schema is `prose`/`code` only; a registry with nothing to register is the speculative abstraction the plan's YAGNI section forbids. Arrives with the first tagged block in Phase 7 |
| Migration `0003` added | `0002` had `archived_at` on lessons but not modules, so archiving a module would cascade-delete its lessons — the exact silent history loss the archive rule prevents |
| `lessons.slug` became course-scoped | Two courses can each have an `intro`. Forced the lesson route to become course-scoped, so `openapi.yaml`, routes, tests and web pages changed together |
| Retrofit `course.yaml` kept local, not committed to the content repo | User's call. It becomes a prerequisite in Phase 5 when git cloning lands |
| `tools/src/seed.test.ts` rewritten | It never invoked `seed.ts` — it reimplemented an insert against a table it created itself, and would have passed with `seed.ts` deleted |

**Known gap to decide at Gate 2:** the scaffolder skips root-level markdown
(`INTRODUCTION.md`, `TABLE_OF_CONTENTS.md`) because it sits in no module directory. It
reports each skip with a reason rather than dropping it silently, but real content does
need moving or hand-adding. Reconciliation against the hand-written manifest was exact:
61 − 4 root files + 13 nested example files = 70.

---

## Phase 3 — Progress and activity

*Still single-user. `actor` remains hardcoded.*

- [x] **`lesson_progress`** with mark-complete and resume-position
      **Acceptance:** completing a lesson updates course percentage; reopening restores position
      **Model:** `sonnet`
- [x] **Append-only `activity_events`**
      **Acceptance:** completing a lesson writes exactly one row; a test or DB trigger rejects updates and deletes
      **Model:** `sonnet`
- [ ] **`users.timezone`** — guessed client-side, confirmable in settings
      **Acceptance:** changing timezone shifts heatmap buckets across a day boundary (test)
      **Model:** `sonnet`
      *(Note: migration 0004 already created `users.timezone` as a nullable column, since `lesson_progress`/`activity_events` needed `users` to exist regardless. The client-side guessing and settings UI remain unbuilt.)*
- [ ] **Heatmap component** — viewport-sized trailing window, scrollable, snapped to the current week
      **Acceptance:** ~13 weeks at 375px, ~53 at 1440px; every cell carries an aria-label with an exact count; empty visibly distinct from level one
      **Model:** `opus` — *(c) novel UX: viewport-adaptive window, timezone bucketing, and a colour-only scale that must stay accessible*
- [ ] **Activity feed** on the dashboard
      **Acceptance:** events render newest-first with correct local timestamps
      **Model:** `haiku`
- [ ] **Streaks derived from events**, never a stored counter
      **Acceptance:** unit test over synthetic event days including a timezone boundary
      **Model:** `sonnet`

> **Gate 3.** Heatmap legible at 375px in both colour schemes.

### Phase 3 outcome so far (`lesson_progress` + `activity_events`, built 2026-08-16)

**Status: the first two checklist items are complete.** 109 tests passing (96 carried over
plus 13 new), lint and typecheck clean, `gen:api:check` exits 0 against a freshly
regenerated `web/src/lib/api-types.ts`.

Migration `0004_progress_and_activity.sql` adds `users` (minimal — id/timezone/display_name/
created_at, seeded with the fixed UUID `DEV_ACTOR.id` now uses instead of the placeholder
string `'dev-user'`), `lesson_progress` (unique on `(user_id, lesson_id)`, FK to
`lessons(id)`), and `activity_events` (FK to `courses`/`lessons` deliberately left
`NO ACTION` rather than `CASCADE`/`SET NULL`, since either would require Postgres to issue an
UPDATE/DELETE against an append-only table). New tables use `create table if not exists` /
`create or replace` rather than 0001-0003's bare `create table`, since — per design §7 — user
tables are never safe to drop-and-recreate the way Phase 1's disposable `lessons` table was
in 0002.

Verified here:

- `psql` proves the append-only trigger for real: both a direct `UPDATE` and a direct
  `DELETE` against a real `activity_events` row raise `activity_events is append-only: ...
  is not permitted`, and the row is unchanged afterward.
- Against the dev DB's real `claude-code-docs` course (61 lessons): `POST .../overview/progress`
  with `{"state":"complete"}` moved the course summary from 0% to 2% (1/61); a second,
  identical `POST` left `completedAt` unchanged and the database showed exactly one
  `lesson_progress` row and exactly one `lesson_completed` `activity_events` row.
- Marking an `exercise`-kind lesson complete directly returns 409 (design §9.1: only `kind:
  'lesson'` completes this way).
- The lesson GET endpoint's new `progress` field is `null` until a `lesson_progress` row
  exists, then reflects it.
- Every new handler takes `actor`, calls `can()`, and has a spy test proving it
  (`lesson:progress:write`, `course:progress:read`).

**Out of scope here, left for the remaining Phase 3 checklist items:** timezone guessing,
the heatmap, the activity feed UI, and streaks — all deliberately untouched per this task's
brief, and owned by later work on this same phase.

---

## Phase 4 — Design system completion

*Deferred this far deliberately: Phases 1–3 proved which components actually exist.*

- [ ] **Five track hues** as OKLCH siblings of the link teal — L and C fixed, H varied, excluding the link teal's hue
      **Acceptance:** swatch page shows all five in both schemes, each distinguishable; chosen H values documented in `docs/design/`
      **Model:** `sonnet`
- [ ] **Breakout containers** for code, chart, figure, heatmap
      **Acceptance:** at 375/834/1440 prose holds 46ch while a breakout block visibly exceeds it
      **Model:** `sonnet`
- [ ] **Spacing, radii, border-weight scales** on a `/kitchen-sink` page
      **Acceptance:** every token rendered and named
      **Model:** `haiku`
- [ ] **App shell** — bottom tab bar below 768px, collapsible sidebar at and above
      **Acceptance:** with `pointer: coarse` emulation, every action is reachable without hover
      **Model:** `sonnet`
- [ ] **Colour-scheme preference** in a cookie, applied during SSR
      **Acceptance:** the class is present in the **SSR response body**, asserted there rather than after hydration
      **Model:** `sonnet`
- [ ] **Lint rule** banning raw colour/font/size literals in components
      **Acceptance:** fires on a deliberately added `color: #fff`
      **Model:** `haiku`

> **Gate 4 — the riskiest unknown.** Run a Claude Design pass on the **annotatable code
> block** at 375/834/1440 before Phase 8. Placing and reading line-anchored annotations at
> 375px is the hardest problem in the product. Also settle the yellow-contrast question:
> either it clears 3:1 as a non-text indicator, or the active-nav underline is permanently
> paired with a second signal.

---

## Phase 5 — Git import and hardening

*Everything needed before this app may face a network.*

- [ ] **Clone from a git URL** (depth 1) and import, recording the commit SHA
      **Acceptance:** importing by URL produces the same rows as a local-directory import of the same content
      **Model:** `sonnet`
- [ ] **Path-traversal rejection and symlink refusal** on every manifest `src`
      **Acceptance:** a fixture repo containing `../../etc/passwd` and a symlink is rejected — one test each
      **Model:** `opus` — *(a) security: manifest paths are attacker-controlled strings; the design names this the real vulnerability*
- [ ] **URL scheme allowlist, size cap, clone timeout**
      **Acceptance:** a `file:///etc` URL is refused; an oversized repo aborts cleanly
      **Model:** `opus` — *(a) security*
- [ ] **SVG and prose-HTML sanitization**
      **Acceptance:** an SVG with `<script>` and `onload=` is stripped but still renders
      **Model:** `opus` — *(a) security: the one sanctioned escape hatch is also the one XSS vector*
- [ ] **Admin import screen** with streamed progress and `import_runs` history
      **Acceptance:** a failing import surfaces `file:line` in the UI, and the previous version stays intact
      **Model:** `sonnet`

> **Gate 5.** Review every hardening test. This is the phase that decides whether the app
> can safely face a network.

---

## Phase 6 — Auth, roles, catalog, enrollment

*The multi-user phase. `actor` becomes real.*

- [ ] **Identity schema** — `users`, `user_roles`, `instance_state`, `refresh_tokens`, `invites`, `audit_log`
      **Acceptance:** a DB-level constraint test asserts `admin` cannot coexist with `student`/`teacher`
      **Model:** `sonnet`
- [ ] **First-run bootstrap** — setup token printed to logs; admin claimed atomically via `UPDATE instance_state … WHERE bootstrapped_at IS NULL`
      **Acceptance:** two concurrent registrations yield exactly one admin, the other a 409; afterwards the setup route returns 410
      **Model:** `opus` — *(a) security + a genuine race condition*
- [ ] **Bootstrap wizard** creating the linked operator + student pair
      **Acceptance:** two rows exist with `operator_for` set on the admin
      **Model:** `sonnet`
- [ ] **Password and token handling** — Argon2id; EdDSA JWT (15 min); rotating per-device refresh tokens with reuse detection
      **Acceptance:** replaying a spent refresh token revokes the whole family (test); cookies are httpOnly, Secure, SameSite
      **Model:** `opus` — *(a) security: token rotation and reuse detection are easy to get subtly wrong*
- [ ] **Populate `actor` and complete the policy module**
      **Acceptance:** table-driven test with **one case per cell** of the design's §5 permission matrix
      **Model:** `opus` — *(a) security: this is the single authorization chokepoint for the whole app*
- [ ] **`courses.visibility`** (`open`/`restricted`/`hidden`, default `hidden`) with an owner publish control
      **Acceptance:** a freshly imported course is absent from the catalog until published; **re-importing does not change visibility**
      **Model:** `sonnet`
- [ ] **Catalog and enrollment**
      **Acceptance:** per-role tests — self-enrol succeeds on `open`, returns 403 on `restricted` without an invite, `hidden` never appears
      **Model:** `sonnet`
- [ ] **Login rate limiting** per IP and per account
      **Acceptance:** 429 after the configured attempt count
      **Model:** `sonnet`

> **Gate 6 — exposure.** Policy matrix green, admin exclusivity enforced in the database,
> hardening from Phase 5 reviewed. **Only now may this go behind public Caddy.**

---

## Phase 7 — Quizzes

- [ ] **`quiz` block** — rendering, submission, scoring, pass threshold
      **Acceptance:** passing completes the lesson; failing leaves it incomplete
      **Model:** `sonnet`
- [ ] **`quiz_attempts`** carrying `track_id`
      **Acceptance:** a per-track score query returns expected values for seeded attempts
      **Model:** `sonnet`

---

## Phase 8 — Exercises: annotate and submit

- [ ] **Annotatable `code` block UI**, built from the Gate 4 design
      **Acceptance:** place, edit, and delete a line-anchored annotation at 375/834/1440
      **Model:** `opus` — *(c) novel UX: the hardest component in the product, with no reference implementation*
- [ ] **`exercise_submissions`** storing a **snapshot** of the block content; annotations anchor to it
      **Acceptance:** submit, edit that lesson upstream, re-import — the submission renders exactly as submitted (**the critical test of this phase**)
      **Model:** `opus` — *(b) data integrity: wrong anchoring silently corrupts every past submission*
- [ ] **Submit completes the lesson** and unlocks the answer key
      **Acceptance:** a solo course with no teacher can complete an exercise
      **Model:** `sonnet`
- [ ] **`exercise_submitted` event**
      **Acceptance:** one event per submission, visible in the feed
      **Model:** `haiku`

---

## Phase 9 — Grading

- [ ] **Teacher grading queue** across owned courses
      **Acceptance:** policy test asserting 403 for a course the teacher does not own
      **Model:** `sonnet`
- [ ] **Threaded annotations** via `parent_id`
      **Acceptance:** a teacher reply nests under the student comment; a top-level teacher annotation marks a missed line
      **Model:** `sonnet`
- [ ] **`rubric` block and `rubric_scores`**
      **Acceptance:** scoring each criterion computes the total and updates per-track scores
      **Model:** `sonnet`
- [ ] **Return flow** emitting `exercise_returned`
      **Acceptance:** the student sees score and feedback, and the event appears in their feed
      **Model:** `sonnet`

> **Gate 9.** Confirm no student can read another student's submission.

---

## Phase 10 — Charts, figures, sidecars

- [ ] **`chart` block**, responsive, using the OKLCH-sibling categorical ramp
      **Acceptance:** legible at 375px; a five-series chart stays distinguishable in both schemes
      **Model:** `sonnet` — *load the `dataviz` skill before writing chart code*
- [ ] **`figure` block** with sanitized static SVG
      **Acceptance:** covered by the Phase 5 sanitizer tests; the figure still renders
      **Model:** `sonnet`
- [ ] **`data: ./file.csv` sidecar** support
      **Acceptance:** a 400-row sidecar renders; a missing file fails validation with `file:line`
      **Model:** `haiku`

---

## Phase 11 — Badges and degrees

- [ ] **Badge and degree schema** — `badges`, `user_badges`, `degrees`, `user_degrees`; git and admin sources; globally unique slugs
      **Acceptance:** the importer **refuses** to overwrite an admin-created badge — assert the error, not a silent skip
      **Model:** `sonnet`
- [ ] **Criteria evaluation**, synchronous on progress writes, filtered to affected types
      **Acceptance:** one unit test per criterion type in the closed vocabulary; awarding is idempotent under repeated writes
      **Model:** `opus` — *(b) data integrity: double-awards and missed awards are both silent failures*
- [ ] **Awards never revoked**
      **Acceptance:** deleting the course or altering criteria leaves `user_badges` intact
      **Model:** `haiku`
- [ ] **Degree requirements and electives**; unsatisfiable degrees surfaced in admin
      **Acceptance:** a degree referencing an unimported course shows unsatisfiable rather than failing the import
      **Model:** `sonnet`
- [ ] **Badge export-to-YAML** admin action
      **Acceptance:** exported YAML validates against the badge schema
      **Model:** `haiku`
- [ ] **Award animation** respecting `prefers-reduced-motion`
      **Acceptance:** with the preference set, the award still appears without motion
      **Model:** `sonnet`

---

## Phase 12 — Profiles and visibility

- [ ] **Profile page** with badges, degrees, courses, feed, and heatmap sections
      **Acceptance:** all sections render for the owner
      **Model:** `sonnet`
- [ ] **Per-section visibility** (`private`/`signed_in`/`public`), enforced in the API
      **Acceptance:** a hidden section is **absent from the JSON payload** — asserted on the response body, not the DOM
      **Model:** `opus` — *(a) security: a visibility boundary between users*
- [ ] **Public profile route** — deny-by-default serializer, rate limiting, per-user `noindex`, OG tags
      **Acceptance:** a test that adds a new field to the profile model asserts it does **not** appear publicly without explicit allowlisting
      **Model:** `opus` — *(a) security: this is the classic profile-endpoint leak*
- [ ] **Avatars** — generated identicon plus upload pipeline
      **Acceptance:** a JPEG with EXIF GPS yields a WebP with no metadata; SVG rejected; oversized rejected **before** decode; a decompression bomb does not exhaust memory
      **Model:** `opus` — *(a) security: untrusted binary input and image decoding*

> **Gate 12.** Confirm no endpoint returns an email address to an unauthenticated caller.

---

## Phase 13 — Invitations and administration

- [ ] **Invites and budgets** — platform invites (admin), course invites (teacher), teacher budgets defaulting to 0
      **Acceptance:** budget decrements on issue, refunds on expiry or revocation; a teacher with 0 budget gets 403
      **Model:** `sonnet`
- [ ] **Combined register-and-enrol link**
      **Acceptance:** one link creates the account and the enrollment in a single flow
      **Model:** `sonnet`
- [ ] **Admin screens** — invite list with issuer and status, `audit_log` view, role and budget assignment
      **Acceptance:** issuing an invite, changing a role, and publishing a course each appear in the audit log
      **Model:** `sonnet`

---

## Phase 14 — PWA manifest

- [ ] **`manifest.webmanifest`**, icons, theme colour, `display: standalone`
      **Acceptance:** Add to Home Screen on the iPad gives your icon and name, launches without browser chrome, and gets its own app-switcher card
      **Model:** `haiku`

---

## Risks

| Risk | Mitigation |
|---|---|
| **Deferring auth to Phase 6 invites a retrofit** | The `actor` + `can()` seam exists from the first handler in Phase 1. Phase 6 populates it rather than rewriting. Any handler skipping it is a bug |
| **Running unauthenticated during Phases 1–5** | Explicit rule: localhost/LAN only until Gate 6. Hardening lands in Phase 5, immediately before exposure |
| **Annotating code at 375px may not work** | Gate 4 designs it before Phase 8 builds on it. The read-only version ships in Phase 1 regardless |
| **Re-import damaging progress or submissions** | Natural-key upsert, archive-never-delete, snapshotted submissions — each an `opus` task with an explicit test |
| **Path traversal in manifest `src` paths** | Dedicated malicious-fixture tests in Phase 5, before any network exposure |
| **Three font families on mobile** | Self-hosted and subset in Phase 1; measure first-load weight at Gate 1 |
| **Phases 8–9 are the largest area** | Solo study works fully without them; they can slip without blocking anything earlier |

## Assumptions

Flag any of these being wrong — each changes the plan:

1. The WSL host is reachable from the iPad over the LAN for Phases 1–5, and over TLS from Phase 6
2. Content repos will be reshaped to carry `course.yaml` (confirmed in design)
3. Postgres 17 and current Node are acceptable in that compose stack
4. "Santiago's Desk" is the blog; the platform inherits **palette and type**, not the brand
5. A handful of users — no phase plans for concurrency beyond that

## Out of scope (YAGNI)

- Service worker / offline reading (progress writes stay idempotent, so it stays additive)
- Cohort-wide activity feed; peer review of submissions
- TOTP two-factor
- Avatar storage outside Postgres; object storage of any kind
- Materialized daily rollups for the heatmap
- A second visual direction ("modern") — dropped; tokens keep it possible
- **Rewriting any service in Go.** The seam is preserved and contract-tested, but no phase
  exercises it. `tools/scaffold` in Phase 2 is the natural first Go project
- Admin impersonation / "view as student"
- Payments, certificates, discussion forums, email notifications

## Open questions

1. Does the yellow clear 3:1 as a non-text indicator in light mode? (Gate 4)
2. Final hue values for the five-hue track ramp once derived (Phase 4)
3. Does the platform carry its own name and identity, or share the blog's?
4. Which content repo is retrofitted first — `claudecode-documentation` is assumed

## Next step

Execute with **`software-development`**, or **`build-phase`** for a single milestone, which
honours the per-task model assignments above. Do not start a phase before the preceding gate
has been reviewed.
