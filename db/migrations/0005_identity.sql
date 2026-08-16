-- Phase 6: identity schema (design §5, §5.1, §5.2, §12, §13).
--
-- This migration turns 0004's placeholder `users` table — id, timezone,
-- display_name, plus the seeded DEV_ACTOR row every phase-1..5 progress and
-- activity row points at — into a real identity model, and adds the tables
-- the first-run bootstrap needs.
--
-- Idempotency, same reasoning as 0004: everything here is `if not exists`,
-- `create or replace`, or an `add constraint` guarded against re-adding.
-- (Both duplicate_object and duplicate_table are caught: re-adding a UNIQUE
-- constraint trips over its backing INDEX's name first, which is a
-- duplicate_table, not a duplicate_object.)
-- tools/src/migrate.test.ts resets `schema_migrations` and
-- drops the *content* tables (0001-0003) without dropping `users`, so this
-- file is re-executed against a database where its own tables already
-- exist. It must be a no-op then — and it must never touch a row of user
-- data on the way through (design §7: "nothing under `users` can be
-- recovered").
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: `password_hash` lands here
-- as a nullable column but nothing writes a real hash into it yet. Argon2id
-- hashing, JWTs, refresh tokens and sessions are a separate Phase 6 task.
-- NULL means "this account has no credential and cannot authenticate" —
-- whatever verifies a password later must treat NULL as an unconditional
-- failure rather than as an empty hash.

-- ---------------------------------------------------------------------------
-- 0. btree_gist — required by the admin-exclusivity exclusion constraint on
--    user_roles below. It is a "trusted" extension since PG13, so the
--    database owner can install it without superuser.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- 1. users gains the identity columns (design §5, §11)
--
-- Every column is nullable (or defaulted) because this table already holds
-- rows: the seeded DEV_ACTOR and whatever accounts a phase-3..5 instance
-- created. A NOT NULL email would fail this migration on exactly the
-- database it matters most on. Uniqueness is enforced regardless — Postgres
-- treats NULLs as distinct in a unique index — so the pre-auth rows coexist
-- with real accounts without weakening anything for the real accounts.
-- Application code (api/src/auth/bootstrap.ts) requires email and handle on
-- every account it creates.
-- ---------------------------------------------------------------------------
alter table users add column if not exists email         text;
alter table users add column if not exists handle        text;
alter table users add column if not exists password_hash text;
alter table users add column if not exists avatar_kind   text not null default 'identicon';
alter table users add column if not exists operator_for  uuid;
-- created_at already exists (0004).

do $$ begin
  -- Case-insensitive uniqueness without depending on citext: the column
  -- stores the lower-cased form and the check makes that structural, so a
  -- plain unique constraint is a case-insensitive one.
  alter table users add constraint users_email_lowercase check (email is null or email = lower(email));
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table users add constraint users_email_key unique (email);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- Design §11: the handle is user-chosen and appears in a URL (`/u/santiago`),
  -- and is explicitly NOT derived from the email local part. 2-31 characters,
  -- lower-case ASCII, starting alphanumeric — no dots (they collide with file
  -- extensions in routes), no uppercase (so uniqueness is unambiguous).
  alter table users add constraint users_handle_url_safe
    check (handle is null or handle ~ '^[a-z0-9][a-z0-9_-]{1,30}$');
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table users add constraint users_handle_key unique (handle);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- Design §11.1: generated identicon by default; uploads re-encoded to WebP.
  alter table users add constraint users_avatar_kind_known check (avatar_kind in ('identicon', 'upload'));
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- Design §5.1 account linking: an admin (operator) account may be marked as
  -- the operator for a student account. `on delete set null` rather than
  -- cascade — deleting the student must not silently delete the operator
  -- account too. Uniqueness gives a student at most one operator account.
  alter table users add constraint users_operator_for_fkey
    foreign key (operator_for) references users (id) on delete set null;
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table users add constraint users_operator_for_key unique (operator_for);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table users add constraint users_operator_for_not_self check (operator_for is null or operator_for <> id);
exception when duplicate_object or duplicate_table then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. user_roles (design §5) — roles are a SET, not a ladder
--
-- `student` and `teacher` combine freely. `admin` combines with neither, and
-- that is enforced HERE rather than in application code. Design §5.1 gives
-- the reason: the invariant exists to bound blast radius — an everyday
-- account carrying admin turns any stolen session into a full instance
-- takeover — so it has to hold against the code path that forgets to check,
-- including a future admin tool, a manual `psql` session, or a restored
-- backup.
--
-- An exclusion constraint rather than a trigger, deliberately. A trigger that
-- reads user_roles to decide is not sufficient: under READ COMMITTED two
-- concurrent transactions, one granting `admin` and one granting `student`,
-- each look at a snapshot without the other's uncommitted row, both pass, and
-- both commit — leaving exactly the state the check exists to prevent. The
-- exclusion constraint is enforced by the index machinery, which makes the
-- second inserter wait on the first and then fail.
--
-- role_class collapses the three roles into the two classes the invariant is
-- actually about, so the constraint reads as what it means: one account, one
-- class.
-- ---------------------------------------------------------------------------
create table if not exists user_roles (
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('student', 'teacher', 'admin')),
  granted_at  timestamptz not null default now(),
  granted_by  uuid references users (id) on delete set null,
  role_class  text generated always as (case when role = 'admin' then 'operator' else 'learner' end) stored,
  primary key (user_id, role),
  constraint user_roles_admin_is_exclusive exclude using gist (user_id with =, role_class with <>)
);

-- ---------------------------------------------------------------------------
-- 3. instance_state (design §5.2) — one row, forever
--
-- Single-row-ness is structural: `id` is the primary key and may only ever be
-- 1, so "the instance state" is a row that cannot be duplicated into an
-- ambiguous second copy of the bootstrap flag.
--
-- setup_token_hash holds the SHA-256 of the one-time setup token printed to
-- the container logs on boot. The plaintext is never stored — not here, not
-- in a file, not in an env var.
-- ---------------------------------------------------------------------------
create table if not exists instance_state (
  id                     smallint primary key default 1 check (id = 1),
  bootstrapped_at        timestamptz,
  setup_token_hash       text,
  setup_token_issued_at  timestamptz,
  created_at             timestamptz not null default now(),
  -- Design §5.2: "once claimed, the setup route is permanently closed —
  -- recorded in instance_state". This makes the closure structural: a
  -- bootstrapped instance cannot hold a live setup token, so no later code
  -- path can reopen the claim by writing a fresh hash without also clearing
  -- the flag it is not supposed to be able to clear.
  constraint instance_state_token_closed_once_claimed
    check (bootstrapped_at is null or setup_token_hash is null)
);

insert into instance_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. invites (design §12, §13)
--
-- Registration is invite-only, with the first-run bootstrap as the single
-- exception. The issuing UI is Phase 13; the table lands here because
-- bootstrap and registration are the phase that needs it to exist.
--
-- Tokens are stored hashed and are single-use: `accepted_at`/`revoked_at`
-- record the terminal state rather than the row being deleted, so the admin
-- invite screen (design §12) can show status and issuer for every invite ever
-- created.
-- ---------------------------------------------------------------------------
create table if not exists invites (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('platform', 'course')),
  issued_by    uuid references users (id) on delete set null,
  email        text not null check (email = lower(email)),
  token_hash   text not null unique,
  course_id    uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  -- A course invite grants access to exactly one course; a platform invite
  -- creates an account and grants access to none. Neither shape is valid
  -- without the other half, so the pairing is a constraint rather than a
  -- convention.
  constraint invites_course_id_matches_kind check ((kind = 'course') = (course_id is not null))
);

do $$ begin
  -- Added separately from the create table: tools/src/migrate.test.ts drops
  -- `courses` with CASCADE, which takes this FK with it while leaving
  -- `invites` in place. Re-running the migration then repairs it, which a
  -- constraint declared inline in `create table if not exists` would not.
  alter table invites add constraint invites_course_id_fkey foreign key (course_id) references courses (id);
exception when duplicate_object or duplicate_table then null; end $$;

create index if not exists idx_invites_email on invites (email);

-- ---------------------------------------------------------------------------
-- 5. audit_log (design §12: "all privileged actions are written to audit_log")
--
-- Append-only, enforced by trigger exactly as activity_events is in 0004 —
-- and for a stronger reason: an audit log that privileged code can edit is
-- not an audit log. There is no carve-out for admin tooling.
--
-- `actor_id` is a bare uuid and deliberately NOT a foreign key. An append-only
-- child table cannot participate in any FK delete action (`cascade` and `set
-- null` both issue a DELETE/UPDATE the trigger rejects, and the default `no
-- action` would make an account permanently undeletable the moment it does
-- anything privileged). The audit record must outlive the account it
-- describes, so the id is stored as data and `meta` carries the human-readable
-- identity that was true at the time.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid,
  action       text not null,
  target       text,
  meta         jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index if not exists idx_audit_log_occurred on audit_log (occurred_at desc);
create index if not exists idx_audit_log_actor on audit_log (actor_id, occurred_at desc);

create or replace function audit_log_forbid_mutation() returns trigger as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op;
end;
$$ language plpgsql;

create or replace trigger audit_log_no_update
  before update on audit_log
  for each row execute function audit_log_forbid_mutation();

create or replace trigger audit_log_no_delete
  before delete on audit_log
  for each row execute function audit_log_forbid_mutation();
