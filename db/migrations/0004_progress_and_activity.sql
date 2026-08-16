-- Phase 3: progress and activity (design §9.1, §10).
--
-- Organizing principle (design §7): "content tables are derived state; user
-- tables are source of truth. ... Nothing under `users` can be recovered."
-- `users`, `lesson_progress`, and `activity_events` are the first user
-- tables in this schema. Unlike 0002's `drop table if exists lessons
-- cascade` (safe there because Phase 1's `lessons` held only disposable
-- content), these three tables are created with `if not exists` rather than
-- a bare `create table` — a re-run of this migration, or a test harness that
-- resets bookkeeping without knowing about tables added after it was
-- written (tools/migrate.test.ts's table-reset list is scoped to migrations
-- 0001-0003 and is out of scope for this change), must never risk a
-- destructive `drop` reaching real progress or activity history. Functions
-- and the trigger use `create or replace` for the same reason.

-- 1. users — minimal, only what progress needs an owner for.
--
-- Phase 6 adds auth columns (password/session/role). Nothing here
-- anticipates that; adding columns later is a cheap, additive migration,
-- the same shape as 0003.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  timezone      text,
  display_name  text,
  created_at    timestamptz not null default now()
);

-- Phase 3 is single-user (CLAUDE.md, plan). `api/src/policy/can.ts`'s
-- DEV_ACTOR.id is this fixed UUID so that every `lesson_progress` /
-- `activity_events` row written under the hardcoded dev actor has a real
-- FK target. `on conflict do nothing` makes re-applying (or re-running
-- against a database that already has this row) a no-op rather than an
-- error.
insert into users (id, display_name, timezone)
values ('00000000-0000-0000-0000-000000000001', 'Dev User', null)
on conflict (id) do nothing;

-- 2. lesson_progress
--
-- FK to lessons(id): this is the relationship migration 0002's stable
-- lesson identity (upsert on (module_id, lesson_key), archive-not-delete)
-- exists to protect — a re-import must never orphan a progress row.
-- `on delete cascade` on both FKs: if the dev user or a lesson row is ever
-- actually deleted (never happens via import, which archives; this matters
-- for test fixtures), the progress row naturally disappears with it rather
-- than dangling. Unique on (user_id, lesson_id) is what makes the upsert in
-- the progress route idempotent (design §6).
create table if not exists lesson_progress (
  user_id        uuid not null references users (id) on delete cascade,
  lesson_id      uuid not null references lessons (id) on delete cascade,
  state          text not null default 'in_progress' check (state in ('in_progress', 'complete')),
  completed_at   timestamptz,
  last_position  text,
  seconds_spent  integer not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

-- 3. activity_events
--
-- Design §10: the single source for the feed, heatmap, streaks, and the
-- streak_days badge criterion. course_id/lesson_id are deliberately NOT
-- `on delete cascade`/`on delete set null`: either would require Postgres
-- to issue a real UPDATE or DELETE against this table when a referenced
-- course/lesson row is removed, which the append-only trigger below would
-- reject — so the default (`no action`) is the only FK behavior compatible
-- with an append-only child table. In practice this never bites: content
-- rows are archived, never deleted (design §7).
create table if not exists activity_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  type         text not null check (type in (
                 'lesson_completed', 'exercise_submitted', 'exercise_returned', 'quiz_passed',
                 'course_enrolled', 'course_completed', 'degree_earned', 'badge_awarded'
               )),
  occurred_at  timestamptz not null default now(),
  course_id    uuid references courses (id),
  lesson_id    uuid references lessons (id),
  meta         jsonb not null default '{}'::jsonb
);

-- Query this table will actually serve (design §10): a user's events in
-- time order, for the feed and the heatmap.
create index if not exists idx_activity_events_user_occurred on activity_events (user_id, occurred_at);

-- Append-only, enforced by the database rather than by convention (the
-- whole point per design §10: if this table can be edited, the feed, the
-- heatmap, streaks, and badge criteria can silently drift apart the moment
-- someone "fixes" or backfills a row by hand). Unconditional: there is no
-- carve-out for admin tooling here, deliberately — a corrective action
-- should insert a compensating event, not rewrite history.
create or replace function activity_events_forbid_mutation() returns trigger as $$
begin
  raise exception 'activity_events is append-only: % is not permitted', tg_op;
end;
$$ language plpgsql;

create or replace trigger activity_events_no_update
  before update on activity_events
  for each row execute function activity_events_forbid_mutation();

create or replace trigger activity_events_no_delete
  before delete on activity_events
  for each row execute function activity_events_forbid_mutation();
