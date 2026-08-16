-- Phase 2: the columns the import transaction (api/src/content/import.ts)
-- needs and 0002 did not have. Additive only — nothing here rewrites or
-- drops a row.
--
-- 1. modules.archived_at
--
-- Design §7 states the rule for lessons: rows removed from a manifest are
-- archived, never deleted, so user data that points at them still resolves.
-- A module is in exactly the same position: once lesson_progress exists
-- (Phase 3) a course page walking modules must still find the module an old
-- progress row's lesson belongs to. Deleting a module would cascade
-- (`lessons.module_id ... on delete cascade`) and take its lessons with it,
-- which is precisely the silent history loss the archive rule exists to
-- prevent. Archiving is therefore not cosmetic here — it is what keeps the
-- cascade from ever firing during a routine re-import.
alter table modules add column archived_at timestamptz;

-- 2. import_runs.course_slug
--
-- An import_runs row must survive a FAILED import — that is the entire
-- point of an audit trail — but a first import that fails rolls back the
-- `courses` row along with everything else, so there is no course id to
-- point at. The slug comes from the manifest, is known before any write,
-- and is globally unique (courses.slug), so it identifies the attempt
-- whether or not a course row ended up existing. A nullable FK column
-- would have been null in exactly the case the log matters most.
alter table import_runs add column course_slug text;

-- 3. import_runs.log becomes an object
--
-- 0002 defaulted `log` to '[]' with a comment describing it as an array of
-- structured entries. The importer writes a single summary object instead —
-- {counts: {...}, error?: {...}} — because what an admin reviewing Gate 2
-- needs is "what did this run do to the database", which is four numbers per
-- entity, not a replayed event stream. The column type is unchanged
-- (jsonb); only the default moves, so it matches the shape actually stored
-- for a run that is still in progress.
alter table import_runs alter column log set default '{}'::jsonb;
