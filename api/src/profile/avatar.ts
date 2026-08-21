import { createHash } from 'node:crypto';
import sharp from 'sharp';

// =============================================================================
// THE AVATAR RE-ENCODE PIPELINE (design §11.1: "always re-encode, never serve
// the bytes you were given").
//
// This is the only place in the application where an untrusted BINARY blob is
// parsed. Everything else that arrives from outside is text, and text is
// handled by parsers whose failure mode is an exception. Here the parser is
// libvips — a large C library whose failure modes have historically been
// memory-safety bugs, four of them in the release this project shipped with
// until the Next 16 upgrade (GHSA-f88m-g3jw-g9cj, CVE-2026-33327 / 33328 /
// 35590 / 35591). Being patched is the floor, not the ceiling; the point of
// everything below is that a patched decoder sees as little as possible.
//
// THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, not an implementation
// detail. Each step narrows what the next one may look at:
//
//   1. LENGTH, on the buffer, touching nothing. A gigabyte never becomes a
//      decoder's problem.
//   2. MAGIC BYTES, from the first twelve. Restricts the input to JPEG, PNG
//      and WebP — three of the nineteen formats sharp is compiled to read.
//      This is what rejects SVG (librsvg parses attacker-controlled XML),
//      PDF, HEIF, raw camera formats, and the GIF/TIFF loaders the CVEs were
//      found in. None of them has any business being an avatar.
//   3. HEADER-ONLY METADATA, which reads the dimensions without allocating a
//      pixel buffer, and must AGREE with step 2 — otherwise a polyglot gets
//      past the sniffer by wearing another format's first eight bytes.
//   4. PIXEL COUNT, from those dimensions. This is the decompression-bomb
//      guard: a 128-byte PNG can declare 2.5 gigapixels, which is small
//      enough to pass step 1 and well-formed enough to pass steps 2 and 3.
//   5. Only now, DECODE — with sharp's own `limitInputPixels` set as a second
//      barrier, so a disagreement between our arithmetic and libvips' is
//      still refused rather than allocated.
//
// Reordering any of these silently weakens it, so avatar.test.ts asserts the
// ORDER and not merely the outcome: its oversized fixture is also undecodable
// garbage, which produces a different refusal if the size check moves below
// the decode.
// =============================================================================

/**
 * 2 MiB. Generous for a 256-pixel square after re-encoding, and small enough
 * that a request body of this size is unremarkable. The route enforces the
 * same number at the transport layer so a large body is refused while it is
 * still on the wire; this check is what makes the module safe on its own.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * 50 megapixels. Above any real camera an account holder is likely to upload
 * from, three orders of magnitude below a bomb. Tuned to reject the attack
 * without rejecting a photograph — a guard that refuses real input gets
 * turned off, which is the worst outcome available.
 */
export const MAX_AVATAR_PIXELS = 50_000_000;

/** One size. An avatar is a small square; anything else is a scaling problem later. */
export const AVATAR_EDGE_PX = 256;

export const AVATAR_CONTENT_TYPE = 'image/webp';

/** What a caller may send. Deliberately three formats, not "images". */
export const ACCEPTED_UPLOAD_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const);

export type SniffedFormat = 'jpeg' | 'png' | 'webp';

export type AvatarRefusal = 'too-large' | 'unsupported-format' | 'too-many-pixels' | 'undecodable';

export interface Avatar {
  bytes: Buffer;
  width: number;
  height: number;
  contentType: typeof AVATAR_CONTENT_TYPE;
  sha256: string;
}

export type AvatarResult = { ok: true; avatar: Avatar } | { ok: false; refusal: AvatarRefusal; message: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The format the first bytes claim, or null.
 *
 * Claims, not proves — a caller can put any eight bytes at the front of any
 * file. What this buys is that the decoder is never handed a format we did
 * not intend to support; `processAvatar` cross-checks the claim against what
 * the decoder actually sees before trusting it.
 */
export function sniffImageFormat(input: Buffer): SniffedFormat | null {
  if (input.length < 12) return null;
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  // RIFF containers hold audio and video too; the four bytes at offset 8 are
  // what make one an image.
  if (input.subarray(0, 4).toString('latin1') === 'RIFF' && input.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  return null;
}

function refuse(refusal: AvatarRefusal, message: string): AvatarResult {
  return { ok: false, refusal, message };
}

/**
 * Validates and re-encodes an uploaded avatar.
 *
 * Never throws for bad input: a malformed upload is an ordinary outcome with
 * a named refusal, not an exception for a route to interpret. It will still
 * propagate a genuine programming error.
 */
export async function processAvatar(input: Buffer): Promise<AvatarResult> {
  // 1. Length.
  if (input.length > MAX_AVATAR_BYTES) {
    return refuse('too-large', `Image is ${input.length} bytes; the limit is ${MAX_AVATAR_BYTES}.`);
  }

  // 2. Magic bytes.
  const sniffed = sniffImageFormat(input);
  if (sniffed === null) {
    return refuse('unsupported-format', `Only ${ACCEPTED_UPLOAD_TYPES.join(', ')} are accepted.`);
  }

  // 3. Header-only metadata.
  //
  // `limitInputPixels: false` looks alarming here and is not: reading
  // metadata parses the header and stops, so a 2.5-gigapixel declaration
  // costs about three milliseconds and a megabyte of resident memory
  // (measured). The limit is DISABLED for exactly this call so that an
  // oversized image produces a precise, diagnosable refusal naming its
  // dimensions, rather than a generic decoder exception. Step 5 puts the
  // limit back for the part that allocates.
  let width: number | undefined;
  let height: number | undefined;
  let format: string | undefined;
  try {
    const metadata = await sharp(input, { limitInputPixels: false, animated: false }).metadata();
    width = metadata.width;
    height = metadata.height;
    format = metadata.format;
  } catch (error) {
    return refuse('undecodable', `Could not read the image header: ${(error as Error).message}`);
  }

  if (format !== sniffed) {
    // A polyglot: the header says one thing, the decoder sees another. The
    // interesting direction is an SVG behind a PNG signature — sniffing
    // alone would wave it through to librsvg.
    return refuse('unsupported-format', `Image claims to be ${sniffed} but decodes as ${format ?? 'nothing'}.`);
  }

  if (width === undefined || height === undefined) {
    return refuse('undecodable', 'The image header carries no dimensions.');
  }

  // 4. Pixel count.
  if (width * height > MAX_AVATAR_PIXELS) {
    return refuse(
      'too-many-pixels',
      `Image is ${width}×${height} (${width * height} pixels); the limit is ${MAX_AVATAR_PIXELS}.`,
    );
  }

  // 5. Decode and re-encode.
  let bytes: Buffer;
  try {
    bytes = await sharp(input, { limitInputPixels: MAX_AVATAR_PIXELS, animated: false })
      // Applies the EXIF orientation and then drops it, so a portrait photo
      // is not silently rotated by the strip below.
      .rotate()
      .resize(AVATAR_EDGE_PX, AVATAR_EDGE_PX, { fit: 'cover', position: 'centre' })
      // sharp copies no metadata unless asked (`withMetadata()`), so the
      // output carries no EXIF, XMP, IPTC or ICC — no camera model, no GPS
      // fix. avatar.test.ts asserts this on the raw bytes rather than
      // trusting the default, because the default is one API call away from
      // changing.
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (error) {
    return refuse('undecodable', `Could not re-encode the image: ${(error as Error).message}`);
  }

  return {
    ok: true,
    avatar: {
      bytes,
      width: AVATAR_EDGE_PX,
      height: AVATAR_EDGE_PX,
      contentType: AVATAR_CONTENT_TYPE,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
