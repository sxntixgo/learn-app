-- Phase 12: profiles and per-section visibility (design §11).
--
-- §11 gives the profile a handle, display name, avatar, bio, join date, and
-- five INDEPENDENTLY toggleable sections. Two of those five are split apart
-- deliberately and must never be collapsed back into one switch:
--
--   activity_feed     reveals WHAT you study
--   activity_heatmap  reveals WHEN you are at your desk
--
-- Different exposure, different decision, different row.
--
-- DEFAULTS ARE THE LEAST VISIBLE SETTING. §11: "a privacy control shipped
-- defaulted-open is not a privacy control." That is expressed here twice, on
-- purpose:
--
--   1. `visibility` defaults to 'private' on the column, so a row inserted
--      without one is closed.
--   2. There is NO backfill and no per-user seeding. A user with no row for a
--      section is private, because api/src/profile/visibility.ts treats an
--      ABSENT row as 'private' — the storage layer is deny-by-default in the
--      same way the public serializer is. A future migration that adds a
--      sixth section therefore lands it closed for every existing account
--      without touching a single row.
--
-- Idempotency, same pattern as 0004/0005: `if not exists`, and every
-- `add constraint` guarded against both duplicate_object and duplicate_table
-- (a UNIQUE/PK constraint trips over its backing index's name first).
--
-- HANDLES: nothing here derives a handle from anything. §11 — "handles are
-- student-chosen, never defaulted from the email local part" — and 0005
-- already enforces the format. This migration deliberately adds no default,
-- no trigger, and no backfill for `users.handle`.

-- ---------------------------------------------------------------------------
-- 1. users gains the two profile-level fields §11 asks for.
--
-- `bio` is nullable free text (an empty bio is absent, not a blank string —
-- the API trims and stores NULL).
--
-- `profile_noindex` is §11's "per-student `noindex` toggle", and it defaults
-- to TRUE for the same reason the sections default to private: opting a
-- person's name into search-engine indexing is not a default anyone chose.
-- Turning it off is a deliberate act by the account holder.
-- ---------------------------------------------------------------------------
alter table users add column if not exists bio             text;
alter table users add column if not exists profile_noindex boolean not null default true;

do $$ begin
  -- A bounded bio, checked in the database as well as in the route: this
  -- string is rendered on an unauthenticated page.
  alter table users add constraint users_bio_length check (bio is null or char_length(bio) <= 2000);
exception when duplicate_object or duplicate_table then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. profile_section_visibility — one row per (user, section) that has ever
--    been set to something other than the default.
--
-- A table rather than five columns on `users`, because §11's section list is
-- expected to grow (§17 defers "study groups", which would be a sixth), and
-- because a missing row is a cheaper and safer representation of "closed"
-- than a column added with a default that has to be got right every time.
--
-- The section vocabulary is CLOSED by a check constraint, mirroring the
-- closed action vocabulary in api/src/policy/can.ts: a typo'd section string
-- must not become a sixth section that nothing knows how to enforce.
-- ---------------------------------------------------------------------------
create table if not exists profile_section_visibility (
  user_id     uuid not null references users (id) on delete cascade,
  section     text not null,
  visibility  text not null default 'private',
  updated_at  timestamptz not null default now(),
  primary key (user_id, section)
);

do $$ begin
  alter table profile_section_visibility add constraint profile_section_visibility_section_known
    check (section in ('badges', 'degrees', 'courses', 'activity_feed', 'activity_heatmap'));
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table profile_section_visibility add constraint profile_section_visibility_value_known
    check (visibility in ('private', 'signed_in', 'public'));
exception when duplicate_object or duplicate_table then null; end $$;

-- The profile page loads every section for one user at once, which is what
-- the primary key already serves. No second index: this table is read by
-- user_id and never scanned by section.
