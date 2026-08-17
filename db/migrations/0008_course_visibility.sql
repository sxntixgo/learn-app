-- Phase 6: course visibility (design §12).
--
-- "Course visibility is three states, because 'private' conflates two
-- different things: open — listed in the catalog; any student may
-- self-enroll. restricted — listed, but enrollment requires a teacher's
-- invite. hidden — absent from the catalog; only invited students see it."
--
-- TWO RULES THIS COLUMN EXISTS TO ENFORCE
-- ----------------------------------------------------------------------
-- 1. NEW COURSES LAND HIDDEN. `not null default 'hidden'` is not just a
--    column default, it is the whole safety property: importing a repo can
--    never expose anything, because there is no code path that writes a
--    `courses` row without going through this default (or explicitly
--    overriding it, which nothing in the import pipeline does — see
--    api/src/content/import.ts's upsertCourse, which never mentions this
--    column at all, on either INSERT or UPDATE).
-- 2. RE-IMPORT NEVER TOUCHES IT. "Visibility lives in the database, never
--    in `course.yaml`, and re-import never touches it. If it came from git,
--    a routine content sync could silently republish a course made
--    private — the same class of bug as deleting lessons on re-import."
--    That property is enforced by ABSENCE, not by a guard: `upsertCourse`'s
--    UPDATE statement simply never lists `visibility` among the columns it
--    sets, so there is nothing for a future editor to accidentally weaken.
--    See api/src/content/import.test.ts and api/src/routes/courses.test.ts
--    for the re-import-preserves-visibility assertion.
--
-- EXISTING IMPORTED COURSES (this migration's own backfill decision)
-- ----------------------------------------------------------------------
-- Every course already in the database predates this column and is
-- currently visible to everyone (Phase 1-5 had no visibility concept at
-- all). `not null default 'hidden'` backfills every existing row to
-- 'hidden', not 'open' — chosen deliberately, for the same reason 0007 made
-- an absent owner_id read as admin-only rather than unrestricted:
--
--   "failing shut costs an admin one assignment; failing open costs the
--    whole catalog."
--
-- Silently publishing every pre-existing course the moment this migration
-- runs would be the exact bug §12 exists to prevent, just moved one column
-- to the left. An operator who wants those courses public again publishes
-- them deliberately (PATCH .../courses/{slug}), which is one admin action
-- per course — the same cost 0007 accepted for ownership, and cheap next to
-- "every course on the instance was public for however long nobody
-- noticed."
--
-- Idempotency: same pattern as 0007 — `add column if not exists` and a
-- guarded `add constraint`, so tools/src/migrate.test.ts's drop-and-rerun of
-- the content tables replays this cleanly.

alter table courses add column if not exists visibility text not null default 'hidden';

do $$ begin
  alter table courses add constraint courses_visibility_known
    check (visibility in ('open', 'restricted', 'hidden'));
exception when duplicate_object or duplicate_table then null; end $$;

-- The catalog query (api/src/routes/courses.ts) filters on this column on
-- every request; an index keeps that cheap as the catalog grows.
create index if not exists idx_courses_visibility on courses (visibility);
