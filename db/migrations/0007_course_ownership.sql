-- Phase 6: course ownership (design §5).
--
-- "**Course ownership** scopes a teacher's authority. A teacher holding both
-- roles can author a course only they can read — register a repo, let the
-- course land `hidden`, self-enroll."
--
-- Everything in the §5 matrix that reads "own courses" — run syncs, publish /
-- set visibility, create course-scoped badges, see enrolled students'
-- progress, grade submissions, invite to a course — is decided against this
-- one column. Until now it did not exist, so those cells could not be
-- expressed at all and `api/src/policy/can.ts` covered only a role floor.
--
-- WHAT A NULL OWNER MEANS (the decision this migration is really making)
-- ---------------------------------------------------------------------
-- Nullable, because every course already in the database was imported before
-- ownership existed and there is nobody to attribute it to. A backfill would
-- have to invent an owner, and inventing an owner is inventing an authority.
--
-- So `owner_id is null` means **no teacher owns this course**, and the policy
-- module reads that as *admin only*:
--
--   * every teacher cell denies — a teacher's authority is scoped BY
--     ownership, and there is none here to scope it;
--   * the admin cells that exist for the row still apply (publish / override
--     visibility, transfer ownership), which is how an unowned course gets an
--     owner: an admin assigns one;
--   * the admin's "curriculum repo only" sync cell is exactly this case —
--     content the instance operator imported, owned by no teacher.
--
-- The alternative reading, "unowned means unrestricted", would make every
-- pre-existing course editable by any teacher on the instance the moment this
-- column landed. Failing shut costs an admin one assignment; failing open
-- costs the whole catalog.
--
-- `on delete set null` rather than cascade: deleting a teacher must not delete
-- the courses they authored, and must not leave `owner_id` pointing at a uuid
-- that a future account could be issued. The course falls back to unowned,
-- which is the admin-only state above.
--
-- Idempotency: same rules as 0004/0005/0006 — `add column if not exists` and a
-- guarded `add constraint`, because tools/src/migrate.test.ts drops `courses`
-- with CASCADE (taking this column and its FK with it) and re-executes every
-- migration against the surviving `users` table.

alter table courses add column if not exists owner_id uuid;

do $$ begin
  alter table courses add constraint courses_owner_id_fkey
    foreign key (owner_id) references users (id) on delete set null;
exception when duplicate_object or duplicate_table then null; end $$;

-- "The courses I own" is the query behind a teacher's whole dashboard, and
-- the lookup every ownership-scoped policy decision is preceded by.
create index if not exists idx_courses_owner on courses (owner_id);
