-- Phase 11: badges and degrees (design §9.2, §9.3).
--
-- Organizing principle, same as every user table before it (design §7):
-- `badges` and `degrees` are DEFINITIONS — partly derived from git, partly
-- hand-tuned in the admin UI. `user_badges` and `user_degrees` are AWARDS,
-- and awards are source of truth that nothing may recover: design §9.3,
-- "badges are never revoked. Editing a course must not strip a badge someone
-- earned."
--
-- Three structural decisions follow from that sentence, and each is enforced
-- here rather than in application code:
--
--   1. `user_badges.badge_id` is `on delete restrict` (the Postgres default,
--      spelled out). Deleting a badge that somebody earned is refused BY THE
--      DATABASE — the admin CRUD in api/src/routes/admin-badges.ts turns the
--      refusal into a 409, but even a psql session cannot revoke an award by
--      dropping its definition. `on delete cascade` here would have made
--      "never revoked" a promise the schema itself broke.
--   2. `user_badges` has no `criteria` snapshot and needs none: an award is a
--      fact about a moment, not a claim that the criteria still hold. Editing
--      `badges.criteria` afterwards changes who will earn it NEXT, never who
--      has earned it.
--   3. Degrees name their courses by SLUG (text), not by a foreign key.
--      Design §6.1: "courses are referenced by global slug, so a degree may
--      span repos ... a degree whose requirements are not all imported shows
--      as UNSATISFIABLE in admin rather than appearing broken to students."
--      An FK would make that state impossible to record — the import of the
--      degree would fail instead, which design §8 explicitly forbids
--      ("cross-repo references never fail an import").
--
-- Idempotent (`if not exists` throughout), for the same reason 0004 is: these
-- are user tables and a re-run must never risk dropping an award.

-- ---------------------------------------------------------------------------
-- 1. degrees — declared in git (design §9.2), one row per degree.
-- ---------------------------------------------------------------------------
create table if not exists degrees (
  id                uuid primary key default gen_random_uuid(),
  -- Globally unique, like a course slug: a degree spans repos, so a
  -- repo-local id could not name one.
  slug              text not null unique,
  title             text not null,
  description       text,
  -- Which repo declared it, when known. Nullable: a degree imported from a
  -- local directory (the CLI) has no content_repos row.
  repo_id           uuid references content_repos (id) on delete set null,
  -- design §6.1: `required: [slugs]` plus `electives: {choose: N, from: [slugs]}`.
  -- Course SLUGS, deliberately not FKs — see the header.
  required_slugs    text[] not null default '{}',
  electives_choose  integer not null default 0 check (electives_choose >= 0),
  electives_from    text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A degree cannot ask for more electives than it offers; that is a manifest
  -- bug, and one no student could ever satisfy.
  constraint degrees_electives_choose_within_from
    check (electives_choose <= cardinality(electives_from))
);

-- ---------------------------------------------------------------------------
-- 2. badges — the TWO SOURCES (design §9.3).
--
-- "Git-sourced (degree badges, in the curriculum repo) are synced like any
-- content. Admin-sourced (gamification and global badges) are mutable DB
-- rows. Slugs are globally unique across both, and the importer refuses to
-- overwrite an admin-created badge."
--
-- `source` is the column that makes the refusal checkable: the importer reads
-- it before writing, and the admin CRUD reads it before editing (a git badge
-- is read-only there — editing it would be undone by the next sync, silently).
-- The unique constraint on `slug` is what makes the two namespaces one.
-- ---------------------------------------------------------------------------
create table if not exists badges (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  description   text,
  source        text not null check (source in ('git', 'admin')),
  -- git badges only: which repo declared it. Same nullability rationale as
  -- degrees.repo_id.
  repo_id       uuid references content_repos (id) on delete set null,
  -- Optional course scope (§5's "create course-scoped badges" row). Null for
  -- a global badge. `on delete set null` rather than cascade: deleting a
  -- course must not delete a badge, because deleting a badge would be
  -- revoking every award of it — see the header, decision 1.
  course_id     uuid references courses (id) on delete set null,
  -- The closed criteria vocabulary (design §9.3), stored as the declarative
  -- object the manifest carries. Validated against schemas/badge.schema.json
  -- before every write — by the importer AND by the admin route — since a
  -- jsonb column cannot express "exactly these eight types" itself.
  criteria      jsonb not null,
  -- Who created an admin-sourced badge. Null for git badges.
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_badges_source on badges (source);
create index if not exists idx_badges_course on badges (course_id) where course_id is not null;

-- ---------------------------------------------------------------------------
-- 3. user_badges — the awards. Design §9.3: "unique on (user_id, badge_id)
-- with awarded_at".
--
-- That unique constraint is not bookkeeping, it is the CONCURRENCY CONTROL.
-- Criteria are evaluated synchronously on every progress write (design §9.3),
-- so two simultaneous completions genuinely race to award the same badge.
-- The award path is a single `insert ... on conflict (user_id, badge_id) do
-- nothing returning id`: exactly one of the two racing statements returns a
-- row, and only that one emits the `badge_awarded` activity event. A
-- read-then-write ("select ... if none, insert") has a window between the two
-- statements and would double-award; there is deliberately no such code path.
-- ---------------------------------------------------------------------------
create table if not exists user_badges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  -- NO `on delete cascade`. See the header, decision 1: deleting an earned
  -- badge is refused by the database.
  badge_id    uuid not null references badges (id) on delete restrict,
  awarded_at  timestamptz not null default now(),
  unique (user_id, badge_id)
);

create index if not exists idx_user_badges_user on user_badges (user_id, awarded_at desc);

-- ---------------------------------------------------------------------------
-- 4. user_degrees — same shape, same rules.
-- ---------------------------------------------------------------------------
create table if not exists user_degrees (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  degree_id   uuid not null references degrees (id) on delete restrict,
  awarded_at  timestamptz not null default now(),
  unique (user_id, degree_id)
);

create index if not exists idx_user_degrees_user on user_degrees (user_id, awarded_at desc);

-- ---------------------------------------------------------------------------
-- 5. activity_events.badge_id — closing a gap left open since 0004.
--
-- Design §10 names the column outright: "activity_events — user_id · type ·
-- occurred_at · course_id? · lesson_id? · badge_id? · meta". Migration 0004
-- created the table without it because nothing awarded a badge yet, and the
-- `badge_awarded` event type has been in the CHECK constraint (unused) ever
-- since. This is the phase that emits it, so this is the phase that adds the
-- column.
--
-- No `on delete` action, matching course_id/lesson_id and for the same reason
-- 0004 gives: any referential action other than the default would need
-- Postgres to UPDATE or DELETE a row of an append-only table, which the
-- trigger rejects. In practice unreachable — a badge with an award cannot be
-- deleted at all (decision 1), and every badge_awarded event has one.
-- ---------------------------------------------------------------------------
alter table activity_events add column if not exists badge_id uuid references badges (id);
alter table activity_events add column if not exists degree_id uuid references degrees (id);
