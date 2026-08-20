-- Fix: no user with activity history could be deleted at all.
--
-- ---------------------------------------------------------------------------
-- THE BUG
--
-- `activity_events.user_id` is `references users (id) on delete cascade`
-- (0004), and the same table carries a `before delete` trigger that rejects
-- EVERY delete. Those two cannot both be satisfied: Postgres implements the
-- cascade by issuing a real DELETE against this table, the trigger refuses it,
-- and the whole `delete from users` aborts with
--
--     activity_events is append-only: DELETE is not permitted
--
-- So any account that had ever completed a lesson was permanently
-- undeletable. Not "hard to delete" — impossible, by any code path.
--
-- 0004's own comment reasons this out correctly for `course_id`/`lesson_id`
-- eleven lines above the offending column ("either would require Postgres to
-- issue a real UPDATE or DELETE against this table ... so the default
-- (`no action`) is the only FK behavior compatible with an append-only child
-- table"), and 0005 states the general rule and gives `audit_log.actor_id` a
-- bare uuid for exactly this reason. `user_id` is the one column that missed
-- it. Found by Phase 15's E2E seeding, which was the first thing to write an
-- activity event and then try to reset the account.
--
-- ---------------------------------------------------------------------------
-- THE FIX, AND WHY THIS ONE
--
-- Two options were real. The other was to match `audit_log`: drop the FK,
-- keep a bare uuid, and let the rows survive pointing at a user that no
-- longer exists. That keeps append-only absolute, but leaves a pseudonymous
-- record of someone's activity behind after they asked to be forgotten.
--
-- This takes the other one, deliberately: erasure of `activity_events` should
-- be real. The distinction from `audit_log` is the point. An audit log records
-- what PRIVILEGED ACTORS DID and must outlive the accounts it describes —
-- that is what makes it an audit log. `activity_events` is the person's own
-- history, read back only to them (§10: the feed, heatmap, streaks). When the
-- account is gone it serves nobody, so keeping it is retention without a
-- purpose.
--
-- The carve-out is deliberately the narrowest one that works:
--
--   * DELETE is permitted only while `app.erasing_user` is set for THIS
--     transaction, and only for rows whose `user_id` equals it. Setting the
--     flag lets you erase one named person; it is not a general "deletes are
--     allowed now" switch, so a bug in the deletion path cannot take out
--     anyone else's history along with its target.
--   * `set local` means it dies with the transaction. There is no way to
--     leave it on.
--   * UPDATE stays unconditionally forbidden. Rewriting history is still the
--     thing this table exists to prevent — 0004's "a corrective action should
--     insert a compensating event, not rewrite history" is untouched.
--
-- Usage (the account-deletion path, when it is built):
--
--     begin;
--     set local app.erasing_user = '<user uuid>';
--     delete from users where id = '<user uuid>';   -- cascade now succeeds
--     commit;
-- ---------------------------------------------------------------------------
create or replace function activity_events_forbid_mutation() returns trigger as $$
declare
  erasing text := current_setting('app.erasing_user', true);
begin
  if tg_op = 'DELETE'
     and erasing is not null
     and erasing <> ''
     and old.user_id::text = erasing
  then
    return old;
  end if;

  raise exception 'activity_events is append-only: % is not permitted', tg_op;
end;
$$ language plpgsql;

-- The triggers themselves are unchanged (0004 created both with `create or
-- replace`); only the function they call has learned the one exception.
