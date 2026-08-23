-- ---------------------------------------------------------------------------
-- AN INVITE LINK IS SPENT THE MOMENT IT IS OPENED.
--
-- The token in an invite URL is the credential (§13: "registration only via
-- invite token"). A URL is the worst place to keep one: the reverse proxy
-- access-logs the path, it lands in browser history, and it is forwarded in
-- Referer. api/src/log-redaction.ts took the API's own log out of that list,
-- but the proxy in front of it still records `GET /invite/<token>`.
--
-- So the URL token now survives exactly one request. Opening the link
-- consumes it and mints a CLAIM token, which is returned in a response body
-- (not a URL), stored by the web app in an httpOnly cookie, and is what the
-- accept step actually presents. A token recovered from a log afterwards is
-- already spent.
--
-- Three columns rather than nulling `token_hash`: that column is `not null
-- unique`, and keeping the hash is worth more than reclaiming the row — an
-- operator asking "was this link ever opened, and when?" gets an answer.
--
--   token_consumed_at  when the URL token was spent. Non-null means the link
--                      has been opened and will never work again.
--   claim_token_hash   SHA-256 of the continuation token. Same construction
--                      as the URL token and for the same reasons; only the
--                      hash is ever stored.
--   claim_expires_at   short, and never outliving the invite itself. Long
--                      enough to fill in a registration form, not long
--                      enough to be a second standing credential.
-- ---------------------------------------------------------------------------

alter table invites add column if not exists token_consumed_at timestamptz;
alter table invites add column if not exists claim_token_hash  text;
alter table invites add column if not exists claim_expires_at  timestamptz;

do $$ begin
  -- A claim is a hash AND a deadline. One without the other is either a
  -- credential that never expires or a deadline guarding nothing.
  alter table invites add constraint invites_claim_is_whole
    check ((claim_token_hash is null) = (claim_expires_at is null));
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  -- A claim can only exist for a link that was actually opened.
  alter table invites add constraint invites_claim_requires_consumed_token
    check (claim_token_hash is null or token_consumed_at is not null);
exception when duplicate_object or duplicate_table then null; end $$;

-- The lookup the accept path makes. Partial, because almost every row has no
-- live claim, and unique for the same reason `token_hash` is: two invites
-- must never answer to one secret.
create unique index if not exists idx_invites_claim_token_hash
  on invites (claim_token_hash)
  where claim_token_hash is not null;
