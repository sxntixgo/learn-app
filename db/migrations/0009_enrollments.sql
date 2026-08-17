-- Phase 6: enrollments (design §7, §12).
--
-- "users ─┬─ enrollments ───── courses" — a user table, not a content table
-- (design §7's organizing principle: "content tables are derived state;
-- user tables are source of truth. Nothing under `users` can be
-- recovered.") That is why un-enrolling (api/src/routes/courses.ts's DELETE
-- .../enrolments) is a soft state change (`status = 'withdrawn'`), never a
-- DELETE of the row: the fact "this person was enrolled in this course from
-- X to Y" is exactly the kind of user history this schema is built to
-- never silently discard, the same reasoning that makes lessons archive
-- instead of delete on the content side.
--
-- `status` carries more than 'active' vs 'withdrawn' on purpose: Phase 13's
-- course invites (design §12) will land an invited-but-not-yet-accepted
-- enrollment as a row here too, which is why the column exists now rather
-- than being a boolean. Nothing in Phase 6 writes 'invited' — only
-- 'active' and 'withdrawn' are reachable through today's routes — but the
-- column is shaped so that landing does not require a schema change.
--
-- `unique (user_id, course_id)`: one relationship per (user, course), ever.
-- Re-enrolling after withdrawing flips the same row back to 'active' rather
-- than inserting a second one — see the POST route's `on conflict do
-- update`.
--
-- Idempotency: same pattern as 0004 (`create table if not exists`) — this is
-- a user table, so it is never dropped by the test harness's content reset,
-- but the guard costs nothing and keeps every migration in this file
-- consistent to read.

create table if not exists enrollments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  course_id    uuid not null references courses (id) on delete cascade,
  status       text not null default 'active',
  enrolled_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, course_id)
);

do $$ begin
  alter table enrollments add constraint enrollments_status_known
    check (status in ('active', 'invited', 'withdrawn'));
exception when duplicate_object or duplicate_table then null; end $$;

-- "Am I enrolled in this course" (the catalog/detail routes) and "who is
-- enrolled in my course" (a teacher's future roster screen, design §5.2)
-- are the two lookups this table exists to serve.
create index if not exists idx_enrollments_course on enrollments (course_id) where status = 'active';
create index if not exists idx_enrollments_user on enrollments (user_id) where status = 'active';
