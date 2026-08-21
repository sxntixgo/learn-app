-- Avatar uploads (Phase 12, design §11.1).
--
-- ---------------------------------------------------------------------------
-- WHY THE BYTES LIVE IN POSTGRES
--
-- The plan's "Out of scope (YAGNI)" list names "avatar storage outside
-- Postgres; object storage of any kind", and design §4 makes Postgres the only
-- stateful service. So the image goes in a row. At a handful of users and a
-- fixed 256×256 WebP — a few kilobytes each — that is not a compromise; a
-- bucket would add a second thing to back up, a second thing to secure, and a
-- second thing to restore in the right order.
--
-- It also means `tools/src/backup.ts` already covers avatars, with no change:
-- a pg_dump of the database is the whole state.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `users`
--
-- Two reasons, both about the blast radius of a careless query.
--
-- 1. `select *` from `users` is already dangerous (it carries `password_hash`;
--    see api/src/me/export.ts). Adding a bytea to that row makes every
--    incautious read of a user drag an image along with it, and every
--    `select *` in a join multiply it.
-- 2. `users` is read on nearly every request to populate the actor. An avatar
--    is read when a page renders a face. Keeping them apart keeps the hot row
--    narrow.
--
-- One row per account (`user_id` is the primary key), `on delete cascade`:
-- unlike a grade, an avatar is a possession of the person, not a fact about
-- somebody else's work, so it goes when they go. This is the same reasoning
-- 0018 applied in the opposite direction, and it is the reason `annotations`
-- and `rubric_scores` are `set null` while this is `cascade`.

create table if not exists user_avatars (
  user_id      uuid primary key references users (id) on delete cascade,
  -- The re-encoded image, never the bytes the caller sent
  -- (api/src/profile/avatar.ts).
  bytes        bytea       not null,
  content_type text        not null,
  width        integer     not null,
  height       integer     not null,
  -- Content digest of `bytes`. Serves as the ETag and as the cache-busting
  -- token in the avatar URL, so a replaced avatar is fetched immediately while
  -- an unchanged one is served from cache indefinitely.
  sha256       text        not null,
  updated_at   timestamptz not null default now()
);

-- The API only ever writes what its own encoder produced, but a constraint is
-- cheaper than trusting that forever, and it documents the format at the level
-- where it is actually true.
alter table user_avatars drop constraint if exists user_avatars_webp_only;
alter table user_avatars add constraint user_avatars_webp_only
  check (content_type = 'image/webp');

alter table user_avatars drop constraint if exists user_avatars_square;
alter table user_avatars add constraint user_avatars_square
  check (width = height and width between 1 and 1024);

alter table user_avatars drop constraint if exists user_avatars_sha256_shape;
alter table user_avatars add constraint user_avatars_sha256_shape
  check (sha256 ~ '^[0-9a-f]{64}$');

-- A backstop, not the real limit. api/src/profile/avatar.ts caps the INPUT at
-- 2 MiB and re-encodes to a 256px square, so a stored row is a few kilobytes;
-- anything approaching this bound means the pipeline was bypassed.
alter table user_avatars drop constraint if exists user_avatars_size_sane;
alter table user_avatars add constraint user_avatars_size_sane
  check (octet_length(bytes) between 1 and 1048576);

-- ---------------------------------------------------------------------------
-- NO CONSISTENCY TRIGGER, DELIBERATELY
--
-- `users.avatar_kind` (0005) already carries the 'identicon' | 'upload'
-- vocabulary and stays the source of truth for WHICH avatar to render, so in
-- principle the two could disagree: an account marked 'upload' with no row
-- here would render nothing.
--
-- The obvious fix is a trigger refusing to delete this row while the user is
-- still marked 'upload'. It was written, and then removed, because of what it
-- does on the path that matters most: deleting an account cascades to this
-- table, and a BEFORE DELETE trigger that consults `users` on the way through
-- is one Postgres ordering detail away from aborting the whole deletion. That
-- is precisely the failure 0017 existed to fix — a table nobody could delete
-- from because a trigger said no — and reintroducing its shape here, on the
-- irreversible path, to protect against a cosmetic inconsistency is a bad
-- trade.
--
-- The read path is fail-safe instead: a missing image falls back to the
-- generated identicon rather than rendering an empty box, so the worst case
-- of a disagreement is the avatar the account had before. The API writes both
-- halves in one transaction; see api/src/profile/avatar-store.ts.
