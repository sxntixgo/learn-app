# Learning Platform — Design

**Date:** 2026-08-15
**Status:** Validated design. Not yet phased into an implementation plan.
**Next step:** `writing-plans` to turn this into phased, verifiable milestones.

---

## 1. What this is

A self-hosted web application for working through self-authored courses.

Students register by invitation, browse a catalog, enroll, and read lessons built from a
fixed set of interactive blocks — annotated source code, charts, quizzes, diagrams. In
exercises they annotate code themselves and submit it; teachers reply to those annotations
and score a rubric.
Progress is tracked, nanodegrees are earned by completing sets of courses, and badges
reward milestones. Profiles display what a student has earned, with per-section privacy
controls.

**Course content does not live in this repository.** It lives in separate git repos that
are imported by URL, parsed, and stored in the database.

The application must be genuinely beautiful, and must work equally well on phone, iPad,
and desktop.

## 2. Goals and non-goals

### Goals

- Reading long-form technical content is the core loop; everything serves it
- Beautiful on three form factors, all first-class
- Content authored in markdown, in separate repos, versioned in git
- Many courses must look like **one system**, not many themes
- Preserve a cheap path to rewriting backend components in Go, incrementally

### Non-goals (deliberately excluded)

- **Executing student code.** No sandboxes, no containers-per-run, no untrusted execution.
  Code is read and annotated, not run. This removes the single largest cost in the project.
- **Open public signup.** Invite-only. No email verification, no password-reset mail, no
  abuse handling, no SMTP in the compose file.
- **Offline reading**, initially. The PWA manifest ships; the service worker is deferred.
- **A job queue.** Imports take seconds for a handful of users.
- **Payments, certificates, discussion forums, cohort-wide social feeds.**

## 3. Decision log

| # | Decision | Rationale / consequence |
|---|---|---|
| 1 | Invite-only, small user base | No email verification, rate-limit, or abuse infrastructure needed |
| 2 | Code is **read and annotated**, never executed | Removes the sandbox entirely — the largest cost in the project |
| 3 | Content repos require a manifest; ship a **scaffolder** to draft one | Platform never guesses structure; retrofit of existing repos is cheap |
| 4 | Import clones → parses → **stores in the database** | Content is queryable; one storage system; disposable disk |
| 5 | **Component whitelist** for interactive blocks | Content supplies data, never code. Platform owns every pixel |
| 6 | **Web app manifest now**, service worker later | Home-screen icon and standalone launch for ~1% of the offline work |
| 7 | Phone + iPad + desktop all first-class | Every component legible at 375px; no hover-dependent affordances |
| 8 | Self-hosted Docker on WSL, behind existing Caddy | Persistent filesystem, TLS already solved, no serverless constraints |
| 9 | Self-marked completion for lessons; **exercises are annotated and submitted**; quizzes are passed | Prose lessons stay cheap; rigorous courses can be rigorous |
| 10 | **Next.js + TypeScript** | ~85% of the work is rendering; pick the stack strongest at rendering |
| 11 | **`web` + `api` + `db` split behind an HTTP contract** | Enables strangler-fig migration of endpoints to Go, one at a time |
| 12 | Content stored as a **platform-defined typed block schema** | Language-neutral; any implementation can emit it |
| 13 | Syntax highlighting at **render** time | Keeps the importer language-agnostic; re-theme without re-import |
| 14 | **Tagged fenced blocks** for authoring | Renders legibly on GitHub; CommonMark core; trivial for goldmark |
| 15 | Lessons **upserted on a natural key; archived, never deleted** | Progress survives re-import; removing content never deletes history |
| 16 | `lesson` user-marked; `exercise` completes on **submit**; `quiz` completes only by passing | One completion rule per kind, never two. Submit-to-complete keeps solo study working without a grader |
| 16b | **All scores are authoritative**: quizzes machine-scored, exercises teacher-scored against a rubric declared in content | No self-reported data anywhere; `track_score` draws from both |
| 16c | Exercise submissions **snapshot the block content**; annotations anchor to the snapshot | Editing a lesson can never corrupt or re-anchor past submissions |
| 17 | Degrees + degree badges in **git**; gamification badges in **admin** | Curriculum is versioned; playful knobs stay tunable |
| 18 | Badges **never revoked** | An award is a historical fact |
| 19 | **Append-only `activity_events`** as the single source for feed/heatmap/streaks | Prevents counters drifting apart |
| 20 | Course visibility `open`/`restricted`/`hidden`, **DB-only** | A content sync can never accidentally republish a course |
| 21 | Roles are a **set, not a ladder**: `student` + `teacher` combine freely; **`admin` is exclusive of both** | Teachers own rooms; admins own the building and never live in it. The reason is blast radius, not achievement integrity |
| 22 | Teacher progress access is **scoped and disclosed** | Never a silent override of a student's privacy setting |
| 23 | Admins invite to platform; teachers invite to courses + a **platform-invite budget** | Growth is capped and auditable |
| 24 | Public profiles use a **deny-by-default serializer** | A field added later is invisible until deliberately published |
| 25 | Avatars generated by default, **uploads re-encoded** into Postgres | Single volume, single backup; kills EXIF and polyglot files |
| 26 | **One visual direction — editorial — in light and dark.** No theme switcher | Palette and type resolved in `docs/design/CHOSEN-PALETTE.md`. Halves component QA; tokens still keep a second theme possible later |
| 27 | All timestamps **UTC in the database**, converted at display only | Timezone stored per student; guessed on first login |
| 28 | **First account claims admin**, gated by a setup token printed to the container logs | No admin credentials in env or seeds. Claim is atomic; the setup route closes permanently. The wizard creates a linked operator + student pair |

## 4. Architecture

```
                    [ Caddy ]  — existing, terminates TLS
                   ╱         ╲
      /  ────────╱             ╲──────── /api/*
               ▼                        ▼
        [ web ]  Next.js         [ api ]  TypeScript
        NO DATABASE_URL                   │
                                          ▼
                                    [ db ]  Postgres 17
                                    (the only volume)
```

**The service boundary is enforced physically: the `web` container is never given
`DATABASE_URL`.** It cannot bypass the API even by accident, which is what keeps the seam
real long after the discipline to maintain it has faded.

**Only Postgres has a volume.** The importer clones into a temp directory, parses, writes
rows, and deletes the clone. Avatar images are stored as rows. Backup is one `pg_dump`;
the app containers are disposable.

**No job queue.** An import of ~100 markdown files takes seconds. Imports run
synchronously with progress streamed to an admin screen, recording an `import_runs` row —
which is the correct place to hang a queue off, should one ever be needed.

### 4.1 The Go migration path

Caddy routes by path prefix, so endpoints migrate individually:

```
handle /api/v1/courses/*  { reverse_proxy api-go:8080 }   # migrated
handle /api/v1/*          { reverse_proxy api-ts:3001 }   # everything else
```

Four things make this work, each cheap now and expensive to retrofit:

1. **OpenAPI spec is the committed contract** — TS clients and Go server stubs are both
   generated from it. Neither implementation is the source of truth.
2. **Contract tests run against whatever is live at a path.** This is how equivalence is
   *proven*, not assumed.
3. **Plain SQL migrations**, run by a one-shot container. Not Drizzle's TS-native tooling.
   Drizzle may still generate types by reading the schema.
4. **Stateless EdDSA JWT auth.** A Go service needs only the public key. No shared session
   store, no TypeScript session logic to reimplement.

Rollback at any step is one line in the Caddyfile. Both services share Postgres, so no data
migration is involved.

**Free-standing Go projects**, coupled only to files and Postgres, available at any time:
the scaffolder CLI, the content validator (CI for content repos), a sync daemon, and the
importer itself.

## 5. Roles and permissions

**Roles are a set, not a ladder.** `user_roles` holds independently grantable roles.
`student` and `teacher` combine freely — a pure content author who never takes a course is
as valid as a teacher who does. **`admin` is exclusive of both.**

| | Student | Teacher | Admin |
|---|---|---|---|
| Enroll, read, track own progress | ✅ | — | — |
| Own profile, badges, degrees | ✅ | — | — |
| Register content repos, run syncs | — | own courses | curriculum repo only |
| Publish / set course visibility | — | own courses | override + transfer ownership |
| Create course-scoped badges | — | ✅ | — |
| See progress of enrolled students | — | own courses | — |
| Grade submissions, score rubrics | — | own courses | — |
| Invite to a course | — | own courses | — |
| Invite to the platform | — | from budget | unlimited |
| Define degrees, global badges | — | — | ✅ |
| Assign roles, grant invite budgets | — | — | ✅ |
| Read audit log, instance settings | — | — | ✅ |

**Course ownership** scopes a teacher's authority. A teacher holding both roles can author
a course only they can read — register a repo, let the course land `hidden`, self-enroll.
A private course of one, which is exactly what a personal-notes repo is.

### 5.1 Why admin is exclusive

The tempting justification — "an admin shouldn't award themselves a badge" — is **not** the
reason, and is in fact unenforceable here: admins define global badges and their criteria,
so they can always construct one they qualify for.

The real reason is **blast radius.** An everyday account carrying admin means every stolen
session, XSS, or unlocked laptop is a full instance takeover: role assignment, invite
budgets, and the audit log itself. Admin accounts are therefore *operator* accounts with no
enrollments, no progress, no badges, and no public profile. Same reasoning as not browsing
the web as root.

The friction is low by design. Everything in the daily content loop — registering repos,
syncing, publishing, course badges, course invites — is a **teacher** power. Admin is
needed only for platform invites, role assignment, budgets, degrees, global badges, and the
audit log: occasional acts, not daily ones.

**Account linking.** An admin account may be marked as the operator account for a student
account, enabling fast switching in the UI and letting the audit log read
*"santiago (operator)"* rather than showing an unexplained second identity.

**No impersonation feature.** "View as student" would reintroduce exactly the privilege
concentration this removes. Admins who want the student view use their student account.

### 5.2 First-run bootstrap

**The first account created on the instance becomes the admin.** No admin credentials in
env, no seeded account — which also keeps the public repository clean.

**Gated by a setup token.** On first boot the app generates a one-time token and prints it
to the container logs; the first-account form requires it. Without this, an
internet-reachable instance is claimable by whoever finds the URL first — and that window
silently re-opens on every database reset or deploy to a fresh volume, which is precisely
when it would go unnoticed.

- **The claim is atomic.** A single-row `instance_state` updated
  `WHERE bootstrapped_at IS NULL` inside the registration transaction, so two simultaneous
  registrations cannot both become admin.
- **Once claimed, the setup route is permanently closed** — recorded in `instance_state`,
  not merely hidden from the UI.

**The wizard creates a linked pair.** Because admin is exclusive, a lone first account
would be an operator who cannot learn anything and stares at an empty catalog. So the
bootstrap flow creates the operator account and then, in the same pass, the student account
— already linked for fast switching. One flow, two accounts, no trap.

**Teacher access to student progress is scoped and disclosed:** a teacher sees individual
progress only for students enrolled in courses they own, and students are told so plainly
at enrollment. Privacy toggles govern peer visibility, not the teaching relationship. The
thing to avoid is a silent override.

**Authorization lives in one tested policy module** — `can(actor, action, resource)`.
Read access depends on role, course visibility, enrollment, and ownership simultaneously;
scattered `if` statements across route handlers would rot within months.

## 6. Content model

### 6.1 Manifest

`course.yaml` owns **structure and order**. Frontmatter owns **lesson-local metadata**.
Filenames were the thing that could not express order reliably, so order becomes explicit —
but a lesson's title belongs next to the lesson, not in a manifest with 86 entries.

```yaml
schema: 1
slug: code-review
title: Code Review
subtitle: a course in four lenses
description: Theory then graded exercises, read through four lenses in sequence.

tracks:                       # max 5, each owns one hue
  - { id: cx, name: Complexity, hue: blue,   blurb: Deep vs shallow modules… }
  - { id: cr, name: Craft,      hue: maroon, blurb: Code health over perfection… }

tags: [python, js, go]

modules:
  - id: what-review-is-for
    title: What review is for
    lessons:
      - modules/01-what-review-is-for/README.md
      - modules/01-what-review-is-for/ex01-triage.md
```

```markdown
---
title: Exercise 1 — Triage
track: cr
kind: exercise        # lesson | exercise | quiz
estimate: 25m
---
```

`hue` must be one of `blue` `teal` `ochre` `maroon` `slate`. The importer rejects anything
else — carried over verbatim from the existing `AUTHORING.md`, because it is what keeps
twenty courses looking like one system rather than twenty themes.

A curriculum repo may additionally declare degrees and their badges:

```yaml
degrees:
  - slug: secure-code-review
    title: Secure Code Review
    required: [code-review, go-security]
    electives: { choose: 2, from: [networking, python-advanced, llm-security] }
```

Courses are referenced by **global slug**, so a degree may span repos. A degree whose
requirements are not all imported shows as *unsatisfiable* in admin rather than appearing
broken to students.

### 6.2 Stored form

A lesson is stored as a **typed block array** — the database form of the component
whitelist. Every block type has a published JSON Schema, validated before write.

```json
[ {"type":"prose",   "html":"<p>…</p>"},
  {"type":"code",    "lang":"python","source":"…","annotations":[…],"annotatable":false},
  {"type":"chart",   "kind":"bar","data":[…],"caption":"…"},
  {"type":"quiz",    "questions":[…],"pass":0.7},
  {"type":"rubric",  "criteria":[{"name":"…","max":5,"track":"cx"}]},
  {"type":"callout", "variant":"warning","html":"…"},
  {"type":"figure",  "svg":"…","caption":"…"} ]
```

`annotatable` flips a `code` block from carrying author annotations (read-only, in a
lesson) to accepting student annotations (in an exercise). A `rubric` block declares the
criteria a teacher scores against — see §9.4.

That schema is the real contract between content repos and the platform, and nothing in it
is JavaScript-shaped — which is what makes a Go importer possible.

### 6.3 Authoring syntax

**Tagged fenced blocks with YAML.** They render as tidy, obviously-intentional code blocks
when browsing a content repo on github.com; they are CommonMark core rather than a parser
extension; and `goldmark` yields them with their info string for free.

Annotated code uses **in-source marker comments**, so an annotated Python example lives in
a real ```python fence — editor highlighting, linting, and copy-paste-to-REPL all keep
working. Markers are stripped from rendered output.

```python
def review(diff):
    findings = []
    for hunk in diff.hunks:        # [!note cx] Shallow module: interface as complex as the body
        findings += self._scan(hunk)
    return findings
```

Chart data is inline by default — one file, one meaning — with `data: ./enrollment.csv`
available as an escape hatch for genuinely large datasets.

**The only escape hatch for bespoke visuals is a `figure` block containing static SVG.**
No scripts, ever.

## 7. Database schema

The organizing principle: **content tables are derived state; user tables are source of
truth.** Everything under `courses` is rebuildable from git. Nothing under `users` can be
recovered. The schema must make it structurally impossible for a re-import to damage
progress.

```
users ─┬─ enrollments ─────────  courses ─┬─ tracks
       ├─ lesson_progress ────── lessons ─┤
       ├─ quiz_attempts ───────┘          ├─ modules ── lessons
       ├─ exercise_submissions ─┬─ annotations (threaded)
       │                        └─ rubric_scores
       ├─ activity_events                 └─ course_invites
       ├─ user_badges ────────── badges
       ├─ user_degrees ───────── degrees
       ├─ user_roles
       └─ refresh_tokens

invites · content_repos ── import_runs · audit_log · avatars · instance_state
```

Load-bearing details:

- **Lessons are upserted on `(course_id, module_key, lesson_key)`** — an identity derived
  from the manifest and stable across re-imports, so `lesson_progress.lesson_id` foreign
  keys survive. Row IDs assigned at import time would orphan every progress record on
  every sync.
- **Lessons removed from a manifest are archived (`archived_at`), never deleted.** The
  catalog hides them; progress still points at something real.
- `lessons.blocks` is `jsonb`, validated against the block schema before write.
- `lessons.content_hash` lets a re-import skip unchanged lessons, so a one-line edit in an
  86-file repo touches one row.
- `courses.imported_commit` records the SHA, so the exact content version is always known.
- `rubric_scores.track_id` and `quiz_attempts.track_id` make per-track scoring a query
  rather than a reconstruction.
- **`exercise_submissions.snapshot`** (`jsonb`) stores the block content exactly as it was
  presented, and `annotations` anchor to that snapshot rather than to the live lesson.
  This is what stops a content edit from silently re-anchoring or corrupting past
  submissions.
- `annotations.parent_id` threads teacher replies beneath the student comment they answer.
- All timestamps are `timestamptz`, stored UTC.

## 8. Import pipeline

```
admin adds repo ──► clone --depth 1 ──► validate manifests ──► parse lessons
                                              │                      │
                                              ▼                      ▼
                                        fail fast with       blocks validated against
                                        file:line errors        block JSON Schema
                                              │                      │
                                              └──────► transaction ◄─┘
                                                  upsert · archive · record SHA
                                                            │
                                                    delete temp dir
```

- **Validate-only mode is a first-class entry point**, not a debug flag. The same code path
  runs from the admin UI, from a CLI against a local directory, and eventually as the Go
  validator in a content repo's CI. Authors find out a block is malformed before pushing.
- **One transaction per course.** A failed import leaves the previous version fully intact.
  There is no half-imported state, which matters because content gets edited while people
  are reading it.
- **Error quality is the authoring experience.** Every failure names file, line, and
  expectation. Worth over-investing in early.
- **Cross-repo references never fail an import.** A degree naming an unimported course
  records an unsatisfied requirement. Curriculum spanning repos means partial states are
  normal.

### 8.1 Hardening (content repos are untrusted input)

- **Path traversal is the real vulnerability here.** Manifest `src` paths are
  attacker-controlled strings; each is resolved and asserted to remain inside the clone
  directory. Symlinks are refused.
- **SVG figures are sanitized** — scripts, event handlers, `foreignObject` stripped.
- **Prose HTML passes an allowlist sanitizer**, since markdown permits raw HTML.
- **Clone limits:** depth 1, size cap, timeout, and a URL scheme allowlist so a repo URL
  cannot become `file:///etc`.

## 9. Progression

### 9.1 Completion

| `kind` | Completes when | Scored? |
|---|---|---|
| `lesson` | Student marks it complete | No |
| `exercise` | **Submitted.** Not markable | Yes, teacher-scored against a rubric — after the fact |
| `quiz` | **Passed** — threshold declared in the block. Not markable | Yes, machine-scored |

One rule per kind, never two competing notions of "done". Course completion is *all
non-optional lessons complete*.

**Exercises complete on submit, not on teacher return.** A private course of one has no
grader, and solo study is a first-class use case — requiring a grader would mean such a
course could never finish a single exercise. Submitting completes the lesson and unlocks
the answer key; grading is an additive layer attaching a score and feedback afterward.

**All scores are authoritative.** Quizzes are machine-scored; exercises are teacher-scored.
There is no self-reported data in the system, so `track_score` badge criteria and per-track
reporting draw on measured results only. Quiz questions carry a track; rubric criteria
carry a track.

### 9.2 Degrees

Defined in git, in a curriculum repo. Awarded when `required` courses are complete and
`electives.choose` is satisfied. Progress toward unearned degrees is visible.

### 9.3 Badges

Criteria vocabulary is **closed and declarative** — this is what prevents badges becoming
a scripting language:

`lessons_completed` · `exercises_passed` · `course_completed` · `courses_completed` ·
`degree_earned` · `track_score` · `streak_days` · `perfect_quiz`

Adding a ninth type is a deliberate platform change.

```yaml
badges:
  - slug: complexity-eye
    title: The Complexity Eye
    criteria: { type: track_score, track: cx, course: code-review, min: 90 }
```

**Two sources.** Git-sourced (degree badges, in the curriculum repo) are synced like any
content. Admin-sourced (gamification and global badges) are mutable DB rows. Slugs are
globally unique across both, and **the importer refuses to overwrite an admin-created
badge** rather than silently clobbering a hand-tuned one. An admin action **exports a badge
to YAML** so a threshold tuned against real data can be promoted into git.

**Evaluation is synchronous on every progress write**, filtered to criteria types the event
could affect — so the award animation fires the moment you finish, which is the entire
point.

**Badges are never revoked.** `user_badges` is unique on `(user_id, badge_id)` with
`awarded_at`. Editing a course must not strip a badge someone earned.

### 9.4 Exercises: annotation and grading

Exercises are the only place students **write** against content, and the shape fits the
subject matter almost exactly: for a code-review course, the exercise *is* a review and the
student's annotations *are* the review comments.

```
student opens exercise ──► annotates the code ──► submits ──► lesson completes
                                                     │            answer key unlocks
                              teacher's grading queue ◄┘
                                                     │
       replies to the student's annotations  ◄───────┤
       flags lines the student missed        ◄───────┤
       scores each rubric criterion          ◄───────┘
                                                     │
                                            returned  ──► score + feedback visible
```

**The `code` block gains an `annotatable` mode.** In a lesson it carries author
annotations, read-only. In an exercise it accepts student annotations against a line or
line range. An exercise may additionally take a free-text response, so exercises that are
prose answers rather than reviews work too.

**Annotations thread.** A `parent_id` lets a teacher reply to a specific student comment,
while a top-level teacher annotation flags a line the student missed entirely — which is
the more instructive of the two.

**Rubrics are declared in content, filled in by the teacher.** The exercise block declares
its criteria in git — name, max points, optional track — beside the exercise they grade. So
rubrics are versioned and reviewed with the content, every student is measured against the
same published bar, and students can read the criteria *before* submitting.

> **Submissions snapshot the block content as presented, and annotations anchor to the
> snapshot — never to the live lesson.** Otherwise an annotation on "line 14" silently
> corrupts the moment that lesson is edited, and every past submission rots. This is the
> same class of bug as deleting lessons on re-import. A teacher grading a month-late
> submission sees exactly what the student saw.

**Grading queue.** Teachers get a queue of submissions awaiting review across the courses
they own. Students learn that feedback arrived through the activity feed.

**Visibility.** A submission and its annotations are visible to the student who wrote it
and to teachers of the owning course — the access already disclosed at enrollment. Peer
review is out of scope.

## 10. Activity

An append-only **`activity_events`** table is the single source for the feed, the heatmap,
streaks, and the `streak_days` badge criterion. Without it, those become four counters that
drift apart the first time a bug is fixed or a row backfilled.

```
activity_events
  user_id · type · occurred_at · course_id? · lesson_id? · badge_id? · meta
```

Types: `lesson_completed`, `exercise_submitted`, `exercise_returned`, `quiz_passed`,
`course_enrolled`, `course_completed`, `degree_earned`, `badge_awarded`.

`exercise_returned` is what tells a student their feedback has arrived — without it,
graded work sits unread.

**Heatmap** — GitHub-style, with an intensity ramp of **one hue in five steps** from the
platform palette. The empty state is clearly distinct from level one, and every cell
carries an exact count for screen readers; a color-only scale is unreadable for a
significant number of people.

**It does not fit on a phone.** 53 columns × 7 rows at 375px gives sub-5px cells. So it
renders a trailing window sized to the viewport — roughly 13 weeks on phone, 26 on tablet,
53 on desktop — horizontally scrollable, snapped to the most recent week on load.

**Feed** appears on the student's own dashboard, and on a profile subject to its visibility
setting. A cohort-wide feed is deliberately out of scope.

## 11. Profiles and visibility

Handle (`/u/santiago`), display name, avatar, bio, join date, plus independently toggleable
sections:

| Section | Reveals |
|---|---|
| Badges | What you've earned |
| Degrees | Earned, and progress toward unearned |
| Courses | Completed and in-progress, shown separately |
| Activity feed | *What* you study |
| Activity heatmap | *When* you're at your desk |

The feed and heatmap are split because they are different kinds of exposure. Likewise
"degrees earned" is something to show off, while "courses in progress" quietly reveals what
you don't yet know.

Visibility per section: `private` / `signed_in` / `public`. **Defaults are the least
visible setting** — a privacy control shipped defaulted-open is not a privacy control.

**Enforcement rules:**

- Visibility is applied in the **API**, building responses from the viewer's identity.
  Hidden sections are absent from the payload, never sent-and-hidden with CSS.
- The public view uses a **separate deny-by-default serializer** with an explicit field
  allowlist — never "fetch the object and delete the private keys". A field added next year
  is invisible until deliberately published. This single decision prevents the classic
  profile-endpoint leak.
- **Email never crosses that boundary.** Handles are student-chosen, never defaulted from
  the email local part.
- The unauthenticated route is rate-limited, carries a per-student `noindex` toggle, and
  emits Open Graph tags so a shared badge looks good when pasted into Slack.

### 11.1 Avatars

Generated identicon by default, derived from the user ID and colored from the platform
palette. Uploads permitted.

**The governing rule for uploads: always re-encode, never serve the bytes you were given.**
Re-encoding to WebP at 256px and 64px eliminates EXIF, embedded payloads, and polyglot
files in one step. Magic-byte sniffing rather than trusting `Content-Type` or extension. A
size cap *before* decode and a dimension cap, so a decompression bomb cannot take the
container down. **SVG avatars are refused outright** — an uploaded SVG is a script
execution primitive. Served with `nosniff`, rate-limited.

Images are stored as rows in Postgres (~20–40KB each), preserving the single-volume,
single-backup property. A deliberate small-scale trade: past a few hundred accounts, that
table moves behind a volume or object store without the API changing.

## 12. Invitations and course visibility

| | Admin | Teacher |
|---|---|---|
| **Platform invite** — creates an account | ✅ | from budget |
| **Course invite** — grants access to one course | — | own courses |

A teacher's platform-invite budget **defaults to 0** — creating accounts is granted
deliberately, not assumed. One action issues one link that both registers the person and
enrolls them in the course. The budget decrements on **issue** (so invites cannot be
hoarded or spammed) and is refunded on expiry or revocation.

Because teachers can create accounts, admins get a screen listing every invite with issuer
and status, and all privileged actions — role changes, budget grants, invite issuance,
course publishing — are written to `audit_log`.

**Course visibility is three states**, because "private" conflates two different things:

- `open` — listed in the catalog; any student may self-enroll
- `restricted` — listed, but enrollment requires a teacher's invite
- `hidden` — absent from the catalog; only invited students see it

**Visibility lives in the database, never in `course.yaml`, and re-import never touches
it.** If it came from git, a routine content sync could silently republish a course made
private — the same class of bug as deleting lessons on re-import. **New courses land
`hidden`** and are published deliberately, so importing a repo can never expose anything.

**Lesson content always requires authentication.** A public course may have a public
landing page — title, description, module list — so a shared profile's "Completed: Code
Review" links somewhere real. The lessons themselves are always behind login.

## 13. Auth

- **Registration only via invite token**, with exactly one exception: the first-run
  bootstrap (§5.2), which is gated by a log-printed setup token instead. Invite tokens are
  stored hashed, single-use, expiring, and bound to the invited email. Passwords hashed
  with **Argon2id**.
- **EdDSA-signed JWT access token**, ~15 minutes, httpOnly + Secure + SameSite cookie. The
  Ed25519 keypair comes from env; the *public* key is all a future Go service needs. This
  is the piece that keeps endpoint-at-a-time migration cheap.
- **Rotating opaque refresh tokens with reuse detection** — presenting a spent token revokes
  the whole family. One per device, so "sign out my iPad" works.
- **Role is in the token for cheap reads; privileged mutations re-check the database**, so a
  demotion takes effect immediately rather than at next refresh.
- **Password recovery without SMTP:** an admin mints a one-time reset link. No mail server
  in the compose file — a dividend of staying invite-only.
- **Login rate-limited** per IP and per account, with backoff. TOTP is straightforward to
  add against this design later.

## 14. Design system

The existing `course.json` uses **`eyebrow`** and **`standfirst`** — print-journalism terms.
The editorial instinct was already there, and it is the right register for a platform whose
core loop is reading.

**One direction — editorial — in light and dark. No theme switcher.** The palette and type
system are resolved in **`docs/design/CHOSEN-PALETTE.md`**, with reference renders at
`docs/design/9a-light.png` and `9b-dark.png`. Colour preference (light/dark/system) is
stored per user and applied server-side from a cookie, so there is **no flash of the wrong
theme** on load.

Everything is specified in **OKLCH**, which is what makes the derivations below tractable.

**Type**

| Role | Face |
|---|---|
| Headings, UI, nav | Libre Franklin 700 (nav 500), headline tracking −0.03em |
| Body and prose | Source Serif 4 400, 16–17px, line-height 1.6–1.65 |
| Dates, tags, labels, code | IBM Plex Mono 400 (labels uppercase, 0.12–0.14em tracking) |

**Palette rules inherited verbatim** — these are what make it look considered, and they are
constraints on every component:

1. **One yellow only.** Structural accents only — never a fill, never body text.
2. Teal carries links, dates, and tags. Graphite carries structure.
3. Mono is reserved for dates, tags, labels, and code — never prose.

### 14.1 Reconciling the palette with the platform

Three places where the blog palette and the platform's needs collide, and how each resolves.

**Prose measure vs. code.** The chosen measure is **46ch** — roughly 380–420px. That reads
beautifully for prose and is far too narrow for code, which routinely exceeds 80 characters
and needs room for a margin annotation. The lesson reader therefore needs a **breakout
container**: prose holds the 46ch measure, while `code`, `chart`, `figure`, and the heatmap
escape to a wider column. Designed deliberately, not discovered.

**Five track hues vs. an austere palette.** Track hues are derived as **OKLCH siblings of
the link teal — L and C held fixed, only H varied** — so they read as one family rather than
a rainbow dropped into a restrained system. Two constraints follow:

- Track hues appear only as **structural** accents: a left-edge rule, a chip border, a small
  mono label. Never as text colour, never as a fill.
- The track ramp **excludes the link teal itself**, or "this is a track" and "this is a link"
  collapse into the same signal.

**Badges vs. "yellow is never a fill".** The rule holds. Badges render in the structural
language — graphite tile, yellow ring or rule, mono label — so earned/locked stays legible
without turning a profile into a sticker album.

### 14.2 Constants

- Light and dark both first-class — evening iPad reading is dark-mode reading
- **No hover-dependent affordances anywhere.** The central interaction is tapping an
  annotation on a line of code, and hover does not exist on an iPad. 44px targets
- Navigation changes shape, not content: bottom tab bar on phone, collapsible sidebar on
  tablet and desktop
- Prose measure stays constant across breakpoints; chrome and breakout blocks adapt
- `prefers-reduced-motion` respected throughout
- **Tokens remain the only source of font, size, radius, and spacing values.** Even with one
  theme, no component hardcodes them — that discipline is what keeps a second direction
  possible later without a rewrite.

**Contrast to verify.** In light mode the yellow sits at L 0.72 against paper at L 0.995 — a
delta of 0.275, unlikely to reach the 3:1 required of a non-text UI indicator. The
active-nav underline must therefore never be the *sole* signal for "you are here"; pair it
with a weight or colour change, as the reference render already does. Dark mode is
comfortable (yellow lifts to 0.82 against 0.215).

**Gamification is the risk to the aesthetic.** Badges and streaks pull toward a
candy-coloured look that would fight long-form reading. Delight is spent in small precise
moments — one well-crafted badge award animation — rather than in the resting-state visual
language.

Charts use sequential and categorical ramps built by the same OKLCH-sibling method, legible
in both colour schemes and at 375px. The heatmap's five-step ramp is single-hue teal.

### 14.3 Design workflow

The visual language is developed in **Claude Design** (claude.ai/design) as a design-system
project, then synced into this repo as a component library. The `DesignSync` tool reads and
writes those projects incrementally, one component at a time — never as a wholesale replace.

**What to design there, in order.** The sequence matters: designing screens first produces
pictures, designing tokens first produces a system.

1. ~~**Foundations.**~~ **Done** — see `docs/design/CHOSEN-PALETTE.md`. Remaining gaps:
   the derived five-hue track ramp (§14.1), the breakout container widths, and a spacing /
   radii / border-weight scale.
2. **Content blocks** — `prose`, annotated `code`, `chart`, `quiz`, `rubric`, `callout`,
   `figure`. **Start with the annotatable `code` block at all three widths.** It is
   simultaneously the most important component in the product and the hardest: reading
   line-anchored annotations at 375px is difficult, and *authoring* them there is harder
   still. If that component does not work, much of this design rests on sand.
3. **Shell** — bottom tab bar (phone) and collapsible sidebar (tablet/desktop), catalog
   card, lesson reader, module list.
4. **Progress** — progress indicator, contribution heatmap, streak, badge in earned and
   locked states, degree card.
5. **Profile** — header, section cards, visibility controls.
6. **Admin** — repo list, import run log with errors, invite table.
7. **The badge award moment.** The one place delight is deliberately spent.

**Constraints to carry into the design tool**, or the output will not be implementable
against this design:

- Design at **375 / 834 / 1440** explicitly. The heatmap and the annotated code block both
  break at 375 unless designed for it.
- **No hover-only affordances.** Every state reachable by hover must be reachable by tap.
- Both **light and dark** for every component.
- Obey the three inherited palette rules (§14): one yellow, structural only; teal for links,
  dates, tags; mono never for prose.
- Track hues are **semantic**, not decorative: the same hue means the same track in the
  sidebar, the unit table, a score, and a chart — and appears only as a structural accent.
- Prose holds the 46ch measure; only breakout blocks exceed it.

## 15. Time handling

- **Every timestamp is `timestamptz`, stored in UTC.** Conversion happens only at display.
- Profiles carry an optional **IANA timezone**. When unset, the client guesses via
  `Intl.DateTimeFormat().resolvedOptions().timeZone` and offers it for confirmation;
  fallback is UTC, clearly labelled.
- Heatmap and streak aggregation run in the student's timezone
  (`occurred_at AT TIME ZONE …`) — a grid whose days flip at UTC midnight is visibly wrong
  to anyone who studies in the evening.
- **Changing timezone shifts historical day buckets and may retroactively alter a streak.**
  Because badges are never revoked, an earned streak badge survives; the heatmap simply
  redraws, which is correct.
- The audit log displays local time with UTC available, since forensic ambiguity is worse
  than a little redundancy.

## 16. Public-repository constraints

**`github.com/sxntixgo/learn-app` will be public.** These are cheaper as rules than as a
later scrub:

- Every secret and environment-specific value comes from env vars. `.env.example` ships
  with placeholders; `.env` is gitignored.
- **No admin credentials anywhere** — not in env, not in a seed file. The first account
  claims admin via a setup token printed to the container logs (§5.2).
- No committed database dumps, fixtures, or screenshots containing real accounts or
  progress.
- Session keys and database passwords are generated at deploy time, never defaulted in code.
  No `SECRET_KEY = "changeme"` that can survive to production.
- No personal email anywhere in source, docs, or fixtures. Git identity already uses the
  GitHub noreply address, so commit metadata is clean.
- If a content repo is ever private, its access token lives in env only.

## 17. Deferred

Recorded so they are choices rather than oversights:

- Service worker / offline reading (progress writes stay idempotent and queueable so this
  is additive)
- Cohort-wide activity feed
- Peer review of exercise submissions
- TOTP two-factor
- Avatar storage moving out of Postgres
- Materialized daily rollups for the heatmap
- Public course landing pages beyond the minimal metadata view

## 18. Next step

Hand this to **`writing-plans`** to produce phased milestones with verifiable steps and
review gates.

Suggested phase-zero shape, to be confirmed there: schema and migrations, then the
importer with validate-only mode, then auth and the policy module, then the lesson reader
with the `prose` and `code` blocks — the narrowest path to reading a real course from a
real repo on a real device. Charts, badges, degrees, profiles, and the second theme all
layer on top of that spine.
