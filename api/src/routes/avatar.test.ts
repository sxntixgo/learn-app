import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';
import type { Actor } from '../policy/can.ts';
import { MAX_AVATAR_BYTES } from '../profile/avatar.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run avatar.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const TAG = 'avatar-route';
let userId: string;
let handle: string;

async function makeStudent(): Promise<{ id: string; handle: string }> {
  const id = randomUUID();
  const h = `${TAG}-${id.slice(0, 8)}`;
  await pool.query(`insert into users (id, display_name, handle, email) values ($1, $2, $3, $4)`, [
    id,
    `${TAG} user`,
    h,
    `${h}@example.test`,
  ]);
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [id]);
  return { id, handle: h };
}

async function scrub(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(`select id from users where display_name like $1`, [`${TAG}%`]);
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.erasing_user', $1, true)`, [row.id]);
      await client.query(`delete from users where id = $1`, [row.id]);
      await client.query('commit');
    } catch {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}

function actorFor(id: string, roles: string[] = ['student']): Actor {
  return { id, roles } as Actor;
}

async function jpegFixture(
  width = 400,
  height = 300,
  background: { r: number; g: number; b: number } = { r: 30, g: 90, b: 160 },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
}

async function upload(actor: Actor, payload: Buffer, contentType = 'image/jpeg') {
  const server = await buildServer({ actor });
  try {
    return await server.inject({
      method: 'PUT',
      url: '/api/v1/me/avatar',
      headers: { 'content-type': contentType },
      payload,
    });
  } finally {
    await server.close();
  }
}

describe('the avatar routes (§11.1)', () => {
  beforeAll(async () => {
    setPool(pool);
    await scrub();
  });

  beforeEach(async () => {
    const made = await makeStudent();
    userId = made.id;
    handle = made.handle;
  });

  afterAll(async () => {
    await scrub();
    await closePool();
  });

  // ---- uploading ------------------------------------------------------------

  it('accepts a JPEG and answers with the upload descriptor', async () => {
    const response = await upload(actorFor(userId), await jpegFixture());

    expect(response.statusCode, response.body).toBe(200);
    const avatar = response.json() as { kind: string; seed: string; url: string };
    expect(avatar.kind).toBe('upload');
    expect(avatar.url).toContain(`/api/v1/profiles/${handle}/avatar?v=`);
    // The identicon seed survives alongside it, as the fallback face.
    expect(avatar.seed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores a re-encoded WebP, never the bytes it was handed', async () => {
    const input = await jpegFixture();
    await upload(actorFor(userId), input);

    const { rows } = await pool.query<{ bytes: Buffer; content_type: string; width: number; height: number }>(
      'select bytes, content_type, width, height from user_avatars where user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content_type).toBe('image/webp');
    expect(rows[0]!.width).toBe(256);
    expect(rows[0]!.height).toBe(256);
    expect(rows[0]!.bytes.equals(input)).toBe(false);
    expect((await sharp(rows[0]!.bytes).metadata()).format).toBe('webp');
  });

  it('marks the account as using an upload, so the read path agrees', async () => {
    await upload(actorFor(userId), await jpegFixture());
    const { rows } = await pool.query<{ avatar_kind: string }>('select avatar_kind from users where id = $1', [userId]);
    expect(rows[0]!.avatar_kind).toBe('upload');
  });

  it('replaces an existing avatar rather than accumulating rows', async () => {
    // The two fixtures differ in COLOUR, not just in dimensions. A first
    // attempt varied only the size — 400x300 then 320x320 — and produced the
    // identical digest, because two flat rectangles of the same colour
    // re-encode to byte-identical 256px squares. That is the pipeline working
    // (same image, same URL, caches stay valid), and a test that cannot tell
    // "replaced" from "unchanged".
    await upload(actorFor(userId), await jpegFixture(400, 300, { r: 30, g: 90, b: 160 }));
    const first = await pool.query<{ sha256: string }>('select sha256 from user_avatars where user_id = $1', [userId]);

    await upload(actorFor(userId), await jpegFixture(320, 320, { r: 200, g: 40, b: 40 }));
    const second = await pool.query<{ sha256: string }>('select sha256 from user_avatars where user_id = $1', [userId]);

    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.sha256).not.toBe(first.rows[0]!.sha256);
  });

  it('leaves the digest — and so the cached URL — alone when the image is unchanged', async () => {
    const same = await jpegFixture();
    const first = (await upload(actorFor(userId), same)).json() as { url: string };
    const second = (await upload(actorFor(userId), same)).json() as { url: string };
    expect(second.url).toBe(first.url);
  });

  it('refuses an SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');
    const response = await upload(actorFor(userId), svg, 'image/png');

    expect(response.statusCode).toBe(400);
    const { rows } = await pool.query('select 1 from user_avatars where user_id = $1', [userId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a media type it has no parser for, before any handler runs', async () => {
    // 415 from Fastify itself: no parser is registered for this type, so the
    // request never reaches a handler.
    const response = await upload(actorFor(userId), Buffer.from('binary'), 'application/octet-stream');
    expect(response.statusCode).toBe(415);
  });

  it('refuses JSON at the handler, since a JSON parser is registered globally', async () => {
    // NOT 415, and the difference is worth stating: `application/json` has a
    // parser on this server for every other route, so Fastify happily parses
    // it and hands the handler an object. The route's own
    // `Buffer.isBuffer(body)` check is what refuses it. Asserting 415 here
    // (the first version of this test did) would have been asserting a
    // protection that does not exist.
    const response = await upload(actorFor(userId), Buffer.from('{}'), 'application/json');
    expect(response.statusCode).toBe(400);
  });

  it('refuses an oversized body with 413', async () => {
    const response = await upload(actorFor(userId), Buffer.alloc(MAX_AVATAR_BYTES + 1024, 0x41));
    expect(response.statusCode).toBe(413);
  });

  it('refuses an empty body', async () => {
    const response = await upload(actorFor(userId), Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
  });

  // ---- who may upload -------------------------------------------------------

  it('refuses an anonymous upload, and stores nothing', async () => {
    const response = await upload(ANONYMOUS_ACTOR, await jpegFixture());
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query('select 1 from user_avatars');
    expect(rows.every(() => true)).toBe(true);
    const mine = await pool.query('select 1 from user_avatars where user_id = $1', [userId]);
    expect(mine.rows).toHaveLength(0);
  });

  it('refuses an operator account — §5.1 gives it no learner profile to decorate', async () => {
    for (const roles of [['admin'], ['teacher']]) {
      const response = await upload(actorFor(userId, roles), await jpegFixture());
      expect(response.statusCode, roles.join()).toBe(403);
    }
    const { rows } = await pool.query('select 1 from user_avatars where user_id = $1', [userId]);
    expect(rows).toHaveLength(0);
  });

  // ---- serving --------------------------------------------------------------

  it('serves the image to an anonymous reader, with the digest as the ETag', async () => {
    await upload(actorFor(userId), await jpegFixture());

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}/avatar` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(response.rawPayload).metadata()).format).toBe('webp');
    await server.close();
  });

  it('answers 304 when the caller already holds the current image', async () => {
    await upload(actorFor(userId), await jpegFixture());

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const first = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}/avatar` });
    const second = await server.inject({
      method: 'GET',
      url: `/api/v1/profiles/${handle}/avatar`,
      headers: { 'if-none-match': first.headers['etag'] as string },
    });

    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    await server.close();
  });

  it('answers the same 404 for an account on its identicon and for a handle that does not exist', async () => {
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });

    const identicon = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}/avatar` });
    const missing = await server.inject({ method: 'GET', url: `/api/v1/profiles/${TAG}-nobody/avatar` });

    expect(identicon.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Identical bodies: otherwise this endpoint is an oracle for which
    // handles are taken, which is exactly what the profile route next to it
    // takes care not to be.
    expect(identicon.json()).toEqual(missing.json());
    await server.close();
  });

  it('does not serve an avatar for an account with no student role', async () => {
    await upload(actorFor(userId), await jpegFixture());
    await pool.query(`delete from user_roles where user_id = $1 and role = 'student'`, [userId]);

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}/avatar` });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  // ---- removing -------------------------------------------------------------

  it('removes the avatar and reverts to the identicon', async () => {
    await upload(actorFor(userId), await jpegFixture());

    const server = await buildServer({ actor: actorFor(userId) });
    const response = await server.inject({ method: 'DELETE', url: '/api/v1/me/avatar' });
    expect(response.statusCode).toBe(204);

    const { rows } = await pool.query<{ avatar_kind: string }>('select avatar_kind from users where id = $1', [userId]);
    expect(rows[0]!.avatar_kind).toBe('identicon');
    expect((await pool.query('select 1 from user_avatars where user_id = $1', [userId])).rows).toHaveLength(0);

    const after = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}/avatar` });
    expect(after.statusCode).toBe(404);
    await server.close();
  });

  it('is idempotent — removing an avatar that was never uploaded still succeeds', async () => {
    const server = await buildServer({ actor: actorFor(userId) });
    const response = await server.inject({ method: 'DELETE', url: '/api/v1/me/avatar' });
    expect(response.statusCode).toBe(204);
    await server.close();
  });

  it('refuses an anonymous removal, and the avatar survives', async () => {
    await upload(actorFor(userId), await jpegFixture());

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'DELETE', url: '/api/v1/me/avatar' });
    expect(response.statusCode).toBe(403);
    await server.close();

    const { rows } = await pool.query('select 1 from user_avatars where user_id = $1', [userId]);
    expect(rows).toHaveLength(1);
  });

  // ---- the interaction with account deletion --------------------------------

  it('goes with the account when it is deleted, and does not block the deletion', async () => {
    // Migration 0019 chose `on delete cascade` and deliberately carries NO
    // consistency trigger, because a BEFORE DELETE trigger on this table sits
    // directly on the irreversible path — which is the exact shape of the bug
    // 0017 existed to fix (a table nobody could delete from). This is that
    // decision, tested: an account with an avatar must still be erasable.
    await upload(actorFor(userId), await jpegFixture());
    expect((await pool.query('select 1 from user_avatars where user_id = $1', [userId])).rows).toHaveLength(1);

    const server = await buildServer({ actor: actorFor(userId) });
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/me/account',
      payload: { confirmHandle: handle },
    });
    expect(response.statusCode, response.body).toBe(204);
    await server.close();

    expect((await pool.query('select 1 from users where id = $1', [userId])).rows).toHaveLength(0);
    expect((await pool.query('select 1 from user_avatars where user_id = $1', [userId])).rows).toHaveLength(0);
  });

  // ---- the profile payload --------------------------------------------------

  it('shows up in the public profile payload, for an anonymous reader', async () => {
    await upload(actorFor(userId), await jpegFixture());

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const response = await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { avatar: { kind: string; url?: string } };
    expect(body.avatar.kind).toBe('upload');
    expect(body.avatar.url).toContain('/avatar?v=');
    await server.close();
  });

  it('goes back to identicon in the payload once removed', async () => {
    await upload(actorFor(userId), await jpegFixture());
    const owner = await buildServer({ actor: actorFor(userId) });
    await owner.inject({ method: 'DELETE', url: '/api/v1/me/avatar' });
    await owner.close();

    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    const body = (await server.inject({ method: 'GET', url: `/api/v1/profiles/${handle}` })).json() as {
      avatar: { kind: string; url?: string };
    };
    expect(body.avatar.kind).toBe('identicon');
    expect(body.avatar.url).toBeUndefined();
    await server.close();
  });
});
