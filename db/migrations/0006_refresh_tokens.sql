-- Phase 6: refresh tokens (design §13).
--
-- "Rotating opaque refresh tokens with reuse detection — presenting a spent
-- token revokes the whole family. One per device, so 'sign out my iPad'
-- works."
--
-- The three columns that carry the whole design:
--
--   family_id   Every rotation issues a NEW row with the SAME family_id. A
--               family is one device's login session across its whole
--               30-day life. Revocation is per family, which is what makes
--               reuse detection meaningful: killing the family kills the
--               thief AND the victim, forcing a fresh login.
--   used_at     Set the moment a token is exchanged. A token with used_at
--               set is SPENT — presenting it again is, by definition, a
--               replay, because the legitimate client was handed a
--               different token and threw this one away.
--   revoked_at  Terminal. Set by logout, logout-all, a new login on the
--               same device, and (for every row at once) by reuse
--               detection.
--
-- Rows are kept rather than deleted so the spent-token state survives:
-- deleting a rotated token would turn a replay into "unknown token", which
-- is a silent failure instead of a family revocation. Expired rows can be
-- pruned by a future maintenance job, but only well past expires_at.
--
-- Only the SHA-256 of the token is stored. Same reasoning as
-- api/src/auth/setup-token.ts: this is a 256-bit random value, not a
-- human-chosen password, so a KDF would buy nothing. Argon2id (0005's note,
-- design §13) is for `users.password_hash` and nothing else.
--
-- Idempotency: same rules as 0004/0005 — `if not exists` everywhere, and
-- guarded `add constraint`, because tools/src/migrate.test.ts re-executes
-- this file against a database where its table already exists.

create table if not exists refresh_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  family_id     uuid not null,
  -- Unique: the lookup path is `where token_hash = $1`, and uniqueness makes
  -- "which row is this token" unambiguous by construction rather than by the
  -- application picking a row out of several.
  token_hash    text not null unique,
  device_label  text,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  revoked_at    timestamptz
);

do $$ begin
  alter table refresh_tokens add constraint refresh_tokens_expiry_after_issue check (expires_at > issued_at);
exception when duplicate_object or duplicate_table then null; end $$;

-- Reuse detection revokes by family, so this index is on the hot path of the
-- one operation that must never be slow enough to be worth racing.
create index if not exists idx_refresh_tokens_family on refresh_tokens (family_id);
create index if not exists idx_refresh_tokens_user on refresh_tokens (user_id, issued_at desc);
