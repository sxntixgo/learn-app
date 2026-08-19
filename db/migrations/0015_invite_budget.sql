-- Phase 13: platform-invite budgets and the invite lifecycle (design §12).
--
-- Migration 0005 landed `invites` and `audit_log` ahead of the UI that uses
-- them. This migration adds the one column §12 names but 0005 could not:
--
--   "A teacher's platform-invite budget DEFAULTS TO 0 — creating accounts is
--    granted deliberately, not assumed. ... The budget decrements on ISSUE
--    (so invites cannot be hoarded or spammed) and is refunded on expiry or
--    revocation."
--
-- Three columns come out of that sentence, and each is here because the
-- alternative is guessing:
--
--   users.platform_invite_budget  the budget itself, defaulting to 0 in the
--                                 SCHEMA and not merely in the code that
--                                 grants it, so an account created by any
--                                 path (bootstrap, invite acceptance, a
--                                 manual psql insert) can never come into
--                                 existence able to create accounts.
--
--   invites.budget_consumed       whether THIS invite actually took a unit of
--                                 budget. An admin's platform invite is
--                                 unlimited (§12) and takes none; a teacher's
--                                 takes one. A refund must not be inferred
--                                 later from `kind` plus the issuer's roles —
--                                 roles change, and a teacher promoted to
--                                 admin (or demoted) would otherwise turn a
--                                 revocation into either a lost unit or a
--                                 minted one.
--
--   invites.refunded_at           makes the refund IDEMPOTENT. Expiry has no
--                                 cron job in this design (§4: Postgres is the
--                                 only stateful service, no job queue), so the
--                                 refund is applied lazily by whoever next
--                                 looks at the issuer's budget. `where
--                                 refunded_at is null` in that UPDATE is what
--                                 stops two concurrent lookers refunding the
--                                 same invite twice — the same technique as
--                                 the bootstrap claim's `where bootstrapped_at
--                                 is null` (design §5.2).
--
-- Idempotency: `add column if not exists` and guarded `add constraint`, the
-- same shape as 0005, because tools/src/migrate.test.ts re-executes every
-- migration against a database where its objects already exist.

-- ---------------------------------------------------------------------------
-- 1. The budget (design §12, §5's "Invite to the platform | from budget")
-- ---------------------------------------------------------------------------
alter table users add column if not exists platform_invite_budget integer not null default 0;

do $$ begin
  -- Non-negative in the database, not just in the decrementing UPDATE. The
  -- issue path decrements with `where platform_invite_budget > 0` and treats
  -- a zero-row result as a refusal; this constraint is the backstop for any
  -- other path, including a future admin tool that sets a budget directly.
  alter table users add constraint users_platform_invite_budget_non_negative
    check (platform_invite_budget >= 0);
exception when duplicate_object or duplicate_table then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. The invite lifecycle columns
-- ---------------------------------------------------------------------------
alter table invites add column if not exists budget_consumed boolean not null default false;
alter table invites add column if not exists refunded_at timestamptz;

-- Whether accepting this invite may CREATE AN ACCOUNT, decided once at issue
-- time and never re-derived.
--
-- §12 budgets the power to create accounts, and a course invite exercises
-- that power too when the invited address has no account yet ("one action
-- issues one link that both registers the person and enrolls them"). So the
-- issue path asks `invite:platform:create` for ANY invite that would create
-- an account, whatever its kind, and records the answer here. Deriving it at
-- acceptance instead ("is there an account for this email right now?") would
-- mean a teacher with an exhausted budget could mint an account by inviting
-- an address whose account later went away.
alter table invites add column if not exists creates_account boolean not null default false;

do $$ begin
  -- An invite has at most ONE terminal state. The acceptance claim is
  -- `update invites set accepted_at = now() where accepted_at is null and
  -- revoked_at is null and expires_at > now()`, so a row carrying both would
  -- mean that claim raced a revocation and both won. It cannot; this makes
  -- that structural rather than a property of the one query that happens to
  -- be written correctly today.
  alter table invites add constraint invites_one_terminal_state
    check (accepted_at is null or revoked_at is null);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- A refund is only meaningful for an invite that consumed budget, and an
  -- ACCEPTED invite is never refunded — the unit bought an account, which is
  -- exactly what it was spent on.
  alter table invites add constraint invites_refund_requires_consumption
    check (refunded_at is null or (budget_consumed and accepted_at is null));
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- Budget is only ever spent on account creation. An invite that cannot
  -- create an account and yet took a unit off someone's budget is a bug in
  -- the issue path, not a state to be tolerated.
  alter table invites add constraint invites_budget_only_for_new_accounts
    check (not budget_consumed or creates_account);
exception when duplicate_object or duplicate_table then null; end $$;

-- The admin invite screen (§12: "a screen listing every invite with issuer
-- and status") reads newest-first across the whole table; a teacher's own
-- list reads newest-first for one issuer. One index serves both.
create index if not exists idx_invites_issued_by on invites (issued_by, created_at desc);
create index if not exists idx_invites_created on invites (created_at desc);

-- The lazy refund sweep looks for expired, unaccepted, unrevoked,
-- unrefunded invites that consumed budget — a small slice of the table, so a
-- partial index keeps it that way as the table grows.
create index if not exists idx_invites_refundable on invites (issued_by, expires_at)
  where budget_consumed and refunded_at is null and accepted_at is null and revoked_at is null;
