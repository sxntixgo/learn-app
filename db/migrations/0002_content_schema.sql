-- Phase 2: the content schema (design §7).
--
-- Organizing principle carried over from the design doc: content tables are
-- *derived* state. Everything under `courses` can be rebuilt by re-cloning a
-- content repo and re-importing it — nothing here is a system of record the
-- way a future `users`/`lesson_progress` table would be. That is what makes
-- it safe for this migration to replace the Phase 1 `lessons` table outright
-- (drop + recreate) rather than limp along with a chain of ALTERs: Phase 1
-- never shipped real content, only scratch/dev rows seeded by `tools/seed.ts`
-- and disposable rows created by tests, and none of it is referenced by any
-- user-data table yet (no `lesson_progress` exists until Phase 3). Dropping
-- it here is intentional data loss of *derived* rows only.
--
-- gen_random_uuid() ships in Postgres core (no pgcrypto needed) since PG13,
-- same as 0001.

drop table if exists lessons cascade;

-- A git repository (or, for now, a local directory) that content is
-- imported from. `default_ref` is the branch/ref the importer clones when
-- none is specified. `last_synced_at` is null until the first successful
-- import.
create table content_repos (
  id              uuid primary key default gen_random_uuid(),
  url             text not null unique,
  default_ref     text not null default 'main',
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now()
);

-- One course.yaml manifest. `repo_id` is nullable because a course can be
-- imported from a local directory with no repo row at all (Phase 2's title
-- is literally "real courses from a local directory"). `slug` is the
-- globally-unique handle degrees reference across repos (design §6.1).
create table courses (
  id              uuid primary key default gen_random_uuid(),
  repo_id         uuid references content_repos (id) on delete set null,
  slug            text not null unique,
  title           text not null,
  subtitle        text,
  description     text,
  tags            text[] not null default '{}',
  updated_label   text,
  imported_commit text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A course's tracks (lenses), e.g. Complexity / Craft. `hue` is the palette
-- slot a track owns; the design is explicit that the platform must reject
-- any value outside the five-hue palette so twenty courses keep looking
-- like one system rather than twenty themes (design §6.1) — enforced here
-- with a CHECK rather than only in the JSON Schema (schemas/course.schema.json)
-- so it is impossible to get a bad hue into the database by any path,
-- manifest importer included.
create table tracks (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references courses (id) on delete cascade,
  key         text not null,
  name        text not null,
  hue         text not null check (hue in ('blue', 'teal', 'ochre', 'maroon', 'slate')),
  blurb       text,
  position    integer not null default 0,
  unique (course_id, key)
);

-- A course's modules. `key` is the manifest-stable module id (design's
-- `modules[].id`); `position` preserves manifest order, since filenames
-- can't express order reliably (design §6.1).
create table modules (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references courses (id) on delete cascade,
  key         text not null,
  title       text not null,
  position    integer not null default 0,
  unique (course_id, key)
);

-- Lessons, extended from the Phase 1 shape (id, slug, title, blocks,
-- created_at, updated_at) with the course/module/track relationships and
-- import bookkeeping columns.
--
-- Identity and the unique index
-- ------------------------------
-- Design §7 says: "Lessons are upserted on (course_id, module_key,
-- lesson_key)" — a key derived from the manifest and stable across
-- re-imports, so lesson_progress.lesson_id survives a re-sync.
--
-- We get that exact guarantee with `unique (module_id, lesson_key)` here
-- plus `unique (course_id, key)` on `modules` above, and *not* a directly
-- literal `unique (course_id, module_key, lesson_key)` column tuple:
-- `module_id` already functionally determines `course_id` (a module belongs
-- to exactly one course), so a lesson's module_id + lesson_key already pins
-- down (course, module, lesson) uniquely — the modules-table constraint is
-- what prevents two modules in the same course from claiming the same
-- `key` in the first place. Indexing the surrogate `module_id` FK instead
-- of a repeated `(course_id, module_key)` pair avoids denormalizing
-- `module_key` onto every lesson row just to build the composite index,
-- while providing the identical identity guarantee the design calls for.
-- `course_id` is still kept as a column on lessons (not derived only via
-- the module join) because it is queried constantly — course pages list
-- their lessons directly — and design §7's diagram draws lessons as a
-- direct child of both courses and modules.
--
-- `slug` (carried over from Phase 1) remains for direct/pretty lookup, but
-- is now scoped `unique (course_id, slug)` rather than globally unique:
-- Phase 1 had one course's worth of content so a global slug was
-- indistinguishable from a per-course one; Phase 2 has many courses, and
-- two different courses each having a lesson called `intro` must not
-- collide. `(module_id, lesson_key)` remains the durable import identity;
-- `(course_id, slug)` is the human-facing lookup key.
create table lessons (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references courses (id) on delete cascade,
  module_id         uuid not null references modules (id) on delete cascade,
  track_id          uuid references tracks (id) on delete set null,
  lesson_key        text not null,
  slug              text not null,
  title             text not null,
  kind              text not null default 'lesson' check (kind in ('lesson', 'exercise', 'quiz')),
  estimate_minutes  integer,
  position          integer not null default 0,
  source_path       text not null,
  content_hash      text not null,
  blocks            jsonb not null,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (module_id, lesson_key),
  unique (course_id, slug)
);

-- One row per import attempt, for the admin-facing import log (design §8,
-- Gate 2: "Review the import_runs log before importing the rest").
-- `repo_id` is nullable for the same local-directory-import reason as
-- `courses.repo_id`. `log` is a jsonb array of structured entries rather
-- than a single text blob so the admin UI can render it without parsing.
create table import_runs (
  id           uuid primary key default gen_random_uuid(),
  repo_id      uuid references content_repos (id) on delete set null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'success', 'failed')),
  commit_sha   text,
  log          jsonb not null default '[]'::jsonb
);
