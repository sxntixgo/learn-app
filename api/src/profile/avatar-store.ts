import type pg from 'pg';
import type { Avatar } from './avatar.ts';

/**
 * Reading and writing the stored avatar (migration 0019).
 *
 * Separate from avatar.ts, which knows about image bytes and nothing about
 * the database, so the pipeline can be tested — including its bomb and
 * polyglot cases — without a connection.
 *
 * `users.avatar_kind` and the `user_avatars` row are TWO facts that have to
 * agree, and every function here writes both or neither. 0019 deliberately
 * carries no trigger enforcing that (its header says why: a BEFORE DELETE
 * trigger on this table sits directly on the account-deletion path, which is
 * the shape of the bug 0017 existed to fix), so the invariant is kept here
 * and the read path is written to survive it being broken anyway.
 */

export interface StoredAvatar {
  bytes: Buffer;
  contentType: string;
  sha256: string;
  updatedAt: Date;
}

interface AvatarRow {
  bytes: Buffer;
  content_type: string;
  sha256: string;
  updated_at: Date;
}

/**
 * The URL published in a profile payload.
 *
 * The digest is a cache-busting token, not a secret: the image behind it is
 * public to whoever can see the profile. Sixteen hex characters is plenty to
 * change the URL whenever the picture changes, and keeps the payload short.
 */
export function avatarUrl(handle: string, sha256: string): string {
  return `/api/v1/profiles/${encodeURIComponent(handle)}/avatar?v=${sha256.slice(0, 16)}`;
}

/**
 * Stores a re-encoded avatar and marks the account as using it.
 *
 * Takes a client rather than a pool: the caller owns the transaction, because
 * the two statements below must land together. Called outside one, an upsert
 * that succeeds followed by an update that fails would leave an image nobody
 * renders.
 */
export async function saveAvatar(client: pg.PoolClient, userId: string, avatar: Avatar): Promise<void> {
  await client.query(
    `insert into user_avatars (user_id, bytes, content_type, width, height, sha256, updated_at)
          values ($1, $2, $3, $4, $5, $6, now())
     on conflict (user_id) do update
             set bytes        = excluded.bytes,
                 content_type = excluded.content_type,
                 width        = excluded.width,
                 height       = excluded.height,
                 sha256       = excluded.sha256,
                 updated_at   = now()`,
    [userId, avatar.bytes, avatar.contentType, avatar.width, avatar.height, avatar.sha256],
  );
  await client.query(`update users set avatar_kind = 'upload' where id = $1`, [userId]);
}

/**
 * Reverts an account to its identicon. Idempotent — an account that never
 * uploaded anything is already in the state this produces, and says so with
 * the same 204 rather than a 404, because "remove my avatar" has been
 * honoured either way.
 */
export async function removeAvatar(client: pg.PoolClient, userId: string): Promise<void> {
  // Order matters only for readability; both are in the caller's transaction.
  await client.query(`update users set avatar_kind = 'identicon' where id = $1`, [userId]);
  await client.query('delete from user_avatars where user_id = $1', [userId]);
}

/**
 * The image bytes for a handle, or null.
 *
 * `avatar_kind = 'upload'` is part of the WHERE clause rather than something
 * the caller checks afterwards: it is the source of truth for which avatar an
 * account uses, so a stale row left behind by some future bug is invisible
 * here instead of being served. That is the fail-safe direction — the profile
 * falls back to the identicon it always had.
 */
export async function loadAvatarByHandle(client: pg.PoolClient, handle: string): Promise<StoredAvatar | null> {
  const { rows } = await client.query<AvatarRow>(
    `select a.bytes, a.content_type, a.sha256, a.updated_at
       from user_avatars a
       join users u on u.id = a.user_id
      where u.handle = $1
        and u.avatar_kind = 'upload'
        and exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role = 'student')`,
    [handle.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return { bytes: row.bytes, contentType: row.content_type, sha256: row.sha256, updatedAt: row.updated_at };
}

/**
 * The digest of an account's current avatar, or null when it uses the
 * identicon. Used to build the descriptor in a profile payload without
 * loading the image itself — a profile render must not drag a few kilobytes
 * of WebP through the JSON path.
 */
export async function loadAvatarDigest(client: pg.PoolClient, userId: string): Promise<string | null> {
  const { rows } = await client.query<{ sha256: string }>(
    `select a.sha256
       from user_avatars a
       join users u on u.id = a.user_id
      where a.user_id = $1 and u.avatar_kind = 'upload'`,
    [userId],
  );
  return rows[0]?.sha256 ?? null;
}
