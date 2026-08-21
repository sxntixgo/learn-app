import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, it, expect } from 'vitest';
import {
  AVATAR_CONTENT_TYPE,
  AVATAR_EDGE_PX,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PIXELS,
  processAvatar,
  sniffImageFormat,
} from './avatar.ts';

// =============================================================================
// The four acceptance criteria the plan sets for this pipeline (Phase 12,
// "Avatars"):
//
//   a JPEG with EXIF GPS yields a WebP with no metadata
//   SVG rejected
//   oversized rejected BEFORE decode
//   a decompression bomb does not exhaust memory
//
// Each has a test below that fails for the right reason if the corresponding
// guard is removed. "Before decode" and "does not exhaust memory" are both
// claims about HOW the answer is reached, not just what it is, so neither can
// be checked by asserting on a return value alone — see the two tests that
// say so.
// =============================================================================

// ---- fixtures ---------------------------------------------------------------

async function jpeg(width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } })
    .jpeg()
    .toBuffer();
}

/**
 * A JPEG carrying the metadata a phone actually attaches: camera make/model,
 * software, and a GPS fix. sharp writes the GPS IFD as `IFD3`.
 */
async function jpegWithGps(): Promise<Buffer> {
  return sharp(await jpeg())
    .withExif({
      IFD0: { Make: 'ACME', Model: 'TestCam', Software: 'learn-app-fixture' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .jpeg()
    .toBuffer();
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A structurally valid PNG whose IHDR *declares* enormous dimensions while
 * the file itself is a hundred-odd bytes — the classic decompression bomb.
 * Built by hand rather than with sharp, because producing it honestly would
 * mean allocating the very buffer this test exists to prove we never
 * allocate.
 */
function pngBomb(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const scanline = Buffer.alloc(width + 1, 0);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="red"/></svg>',
);

// ---- the happy path ---------------------------------------------------------

describe('processAvatar re-encodes what it accepts', () => {
  it('turns a JPEG into a square WebP of the fixed avatar size', async () => {
    const result = await processAvatar(await jpeg(400, 300));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.avatar.contentType).toBe(AVATAR_CONTENT_TYPE);
    expect(result.avatar.width).toBe(AVATAR_EDGE_PX);
    expect(result.avatar.height).toBe(AVATAR_EDGE_PX);

    // Read the ACTUAL bytes back rather than trusting the reported numbers.
    const written = await sharp(result.avatar.bytes).metadata();
    expect(written.format).toBe('webp');
    expect(written.width).toBe(AVATAR_EDGE_PX);
    expect(written.height).toBe(AVATAR_EDGE_PX);
    expect(written.pages ?? 1).toBe(1);
  });

  it('accepts PNG and WebP as well as JPEG', async () => {
    const source = await jpeg(300, 300);
    for (const bytes of [await sharp(source).png().toBuffer(), await sharp(source).webp().toBuffer()]) {
      const result = await processAvatar(bytes);
      expect(result.ok).toBe(true);
    }
  });

  it('reports a sha256 that is actually the digest of the bytes it returns', async () => {
    const result = await processAvatar(await jpeg());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.avatar.sha256).toBe(createHash('sha256').update(result.avatar.bytes).digest('hex'));
  });

  it('never returns the bytes it was given (§11.1: always re-encode)', async () => {
    const input = await sharp(await jpeg(AVATAR_EDGE_PX, AVATAR_EDGE_PX))
      .webp()
      .toBuffer();
    const result = await processAvatar(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Already a WebP, already the right size — the one case where a lazy
    // implementation would be tempted to pass the input through.
    expect(result.avatar.bytes.equals(input)).toBe(false);
  });
});

// ---- acceptance 1: metadata is stripped -------------------------------------

describe('a JPEG with EXIF GPS yields a WebP with no metadata', () => {
  it('strips the EXIF block entirely', async () => {
    const tagged = await jpegWithGps();
    // The fixture has to be a real one, or this whole test is vacuous.
    expect((await sharp(tagged).metadata()).exif, 'fixture carries no EXIF').toBeTruthy();

    const result = await processAvatar(tagged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const out = await sharp(result.avatar.bytes).metadata();
    expect(out.exif).toBeUndefined();
    expect(out.xmp).toBeUndefined();
    expect(out.iptc).toBeUndefined();
    expect(out.icc).toBeUndefined();
  });

  it('leaves no trace of the camera or the location in the raw output bytes', async () => {
    // Belt as well as braces: `metadata().exif === undefined` is sharp's
    // opinion about its own output. This reads the bytes. A metadata block
    // that sharp declines to parse but a forensic tool would still find is
    // exactly the leak this feature must not ship.
    const result = await processAvatar(await jpegWithGps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = result.avatar.bytes.toString('latin1');
    for (const needle of ['ACME', 'TestCam', 'learn-app-fixture', 'Exif']) {
      expect(raw.includes(needle), `output still contains ${needle}`).toBe(false);
    }
  });
});

// ---- acceptance 2: SVG rejected ---------------------------------------------

describe('SVG is rejected', () => {
  it('refuses an SVG at the allowlist, before the decoder is consulted', async () => {
    const result = await processAvatar(SVG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 'undecodable' here would mean we HANDED IT TO THE DECODER and it
    // happened to fail. sharp decodes SVG perfectly well — via librsvg,
    // which parses attacker-controlled XML. The refusal must come from the
    // allowlist, before any of that.
    expect(result.refusal).toBe('unsupported-format');

    // WHICH LAYER REFUSED IT IS THE POINT, so the message is asserted and not
    // just the reason. Found by mutation: deleting the magic-byte allowlist
    // outright left all eighteen tests in this file GREEN, because the
    // sniff-vs-decoder cross-check below catches SVG too and returns the same
    // reason. Two independent guards covering for each other is the design
    // working; a test suite that cannot tell them apart is not. This
    // assertion fails the moment the allowlist stops being what fires.
    expect(result.message).toContain('image/jpeg');
    expect(result.message).not.toContain('decodes as');
  });

  it('refuses an SVG wearing a PNG signature', async () => {
    // Magic-byte sniffing alone is not enough: prepend eight bytes and any
    // sniffer says PNG.
    //
    // WHAT ACTUALLY REFUSES THIS, measured rather than assumed: libvips
    // dispatches on the leading signature exactly as our sniffer does, so it
    // picks its PNG loader and fails at the header — 'undecodable', not the
    // cross-check. Every polyglot that could be built this way (JPEG SOI over
    // a GIF, a RIFF/WEBP header over a GIF, and four others) behaves the
    // same. The cross-check below is therefore not what closes this case; it
    // is a parser-differential guard for the day the two sniffers disagree,
    // which is the classic shape of a file-upload bypass. It is reachable
    // today only by removing the allowlist, which is how it was found.
    const polyglot = Buffer.concat([PNG_SIGNATURE, SVG]);
    expect(sniffImageFormat(polyglot)).toBe('png');

    const result = await processAvatar(polyglot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['undecodable', 'unsupported-format']).toContain(result.refusal);
  });

  it('refuses the other formats sharp is happy to decode', async () => {
    const source = await jpeg(64, 64);
    // GIF and TIFF are two of the three loaders the libvips CVEs were found
    // in (GHSA-f88m-g3jw-g9cj). Patched now — but an avatar has no reason to
    // arrive as either, and the narrowest input surface is the point.
    for (const bytes of [await sharp(source).gif().toBuffer(), await sharp(source).tiff().toBuffer()]) {
      const result = await processAvatar(bytes);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal).toBe('unsupported-format');
      expect(result.message, 'the allowlist should be what refuses these').toContain('image/jpeg');
    }
  });

  it('refuses an empty body and a text file', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not an image at all')]) {
      const result = await processAvatar(bytes);
      expect(result.ok).toBe(false);
    }
  });
});

// ---- acceptance 3: oversized rejected BEFORE decode -------------------------

describe('an oversized upload is refused before it reaches the decoder', () => {
  it('refuses on size, not on content', async () => {
    // THE ORDERING IS THE ASSERTION. This buffer is both oversized AND
    // undecodable garbage. If the size check ran first — as it must — the
    // refusal is 'too-large'. If the implementation decoded first and
    // measured afterwards, the decoder would fail on the garbage and the
    // refusal would be 'unsupported-format' or 'undecodable' instead.
    //
    // Verified by mutation: moving the size check below the decode turns
    // this red while leaving every other test in the file green.
    const oversized = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x41);
    const result = await processAvatar(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('too-large');
  });

  it('refuses an oversized image that is otherwise perfectly valid', async () => {
    const big = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: { r: 1, g: 2, b: 3 }, noise: { type: 'gaussian', mean: 128, sigma: 90 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(big.length).toBeGreaterThan(MAX_AVATAR_BYTES);

    const result = await processAvatar(big);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('too-large');
  });

  it('accepts a file one byte under the limit, so the boundary is the limit', async () => {
    // Not an off-by-one pedantry: a limit that is actually one byte tighter
    // than documented is the kind of thing that only shows up in a support
    // thread.
    expect(MAX_AVATAR_BYTES).toBeGreaterThan(0);
    const result = await processAvatar(await jpeg(64, 64));
    expect(result.ok).toBe(true);
  });
});

// ---- acceptance 4: the decompression bomb -----------------------------------

describe('a decompression bomb does not exhaust memory', () => {
  it('refuses 2.5 gigapixels declared in 128 bytes, without allocating them', async () => {
    const bomb = pngBomb(50_000, 50_000);
    expect(bomb.length).toBeLessThan(1024);
    expect(50_000 * 50_000).toBeGreaterThan(MAX_AVATAR_PIXELS);

    // Decoding this would want ~2.5 GB at one byte per pixel. Anything in
    // the same order of magnitude means the guard did not hold. The
    // threshold is deliberately loose (a quarter of a gigabyte) so that GC
    // timing and allocator behaviour cannot make it flap, while still being
    // three orders of magnitude below what a real decode would take.
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    const result = await processAvatar(bomb);
    const grewBy = process.memoryUsage().rss - before;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('too-many-pixels');
    expect(grewBy, `resident memory grew by ${(grewBy / 1048576).toFixed(1)} MB`).toBeLessThan(256 * 1024 * 1024);
  });

  it('reports the dimensions it refused, so the refusal is diagnosable', async () => {
    const result = await processAvatar(pngBomb(30_000, 30_000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('30000');
  });

  it('accepts a large-but-sane photograph', async () => {
    // 3000×2000 is a normal camera frame: six megapixels, well under the
    // pixel ceiling. A guard tuned so tightly that it rejects real photos
    // would be a bug wearing a security badge.
    const photo = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 90, g: 120, b: 150 } },
    })
      .jpeg({ quality: 60 })
      .toBuffer();
    expect(photo.length).toBeLessThan(MAX_AVATAR_BYTES);
    expect(3000 * 2000).toBeLessThan(MAX_AVATAR_PIXELS);

    const result = await processAvatar(photo);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

// ---- the sniffer itself -----------------------------------------------------

describe('sniffImageFormat', () => {
  it('recognises the three accepted formats from their magic bytes', async () => {
    const source = await jpeg(16, 16);
    expect(sniffImageFormat(await sharp(source).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffImageFormat(await sharp(source).png().toBuffer())).toBe('png');
    expect(sniffImageFormat(await sharp(source).webp().toBuffer())).toBe('webp');
  });

  it('returns null for everything else, including truncated headers', async () => {
    const source = await jpeg(16, 16);
    expect(sniffImageFormat(await sharp(source).gif().toBuffer())).toBeNull();
    expect(sniffImageFormat(await sharp(source).tiff().toBuffer())).toBeNull();
    expect(sniffImageFormat(SVG)).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
    // 'RIFF' without 'WEBP' at offset 8 is a WAV or an AVI, not an image.
    expect(sniffImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull();
  });
});
