#!/usr/bin/env node
/* eslint-disable no-undef */
// PWA icon generator (plan Phase 14 — see docs/plans/2026-08-15-learning-platform-plan.md).
//
// Draws a simple palette-derived mark — a graphite tile with a centred
// yellow ring, reusing design §14.1's badge language verbatim ("graphite
// tile, yellow ring or rule") — and writes it out as real PNGs at the sizes
// iOS and Android actually request. No `sharp` (unpatched libvips CVEs,
// deferred upgrade — see the Phase 14 task brief), no image library, no
// network fetch: this hand-rolls a PNG encoder (IHDR/IDAT/IEND, zlib
// DEFLATE via Node's built-in `zlib`, CRC32 per the PNG spec) because that
// is a smaller, more auditable surface than adding a dependency for four
// static assets that get generated once and committed.
//
// Run from `web/`:
//   node scripts/generate-pwa-icons.mjs public/icons
//
// Colours are a mechanical OKLCH -> sRGB conversion (CSS Color 4 / Björn
// Ottosson's OKLab, the canonical matrices) of the exact palette tokens in
// docs/design/CHOSEN-PALETTE.md — not invented values. `app/manifest.ts`
// documents the same conversion for the manifest's theme_color/
// background_color.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function oklchToSrgbBytes(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const toSrgb = (c) => {
    const clamped = Math.min(1, Math.max(0, c));
    const v = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };

  return [toSrgb(rLin), toSrgb(gLin), toSrgb(bLin)];
}

// docs/design/CHOSEN-PALETTE.md, light mode (9a) — the codebase's default
// layer (app/tokens.css puts light on bare `:root`, dark is a layered
// override), so a static generated asset with one shot uses it.
const GRAPHITE = oklchToSrgbBytes(0.3, 0.008, 250); // --color-footer-bg
const YELLOW = oklchToSrgbBytes(0.72, 0.15, 88); // --color-accent-yellow

// ---- Minimal PNG encoder ----------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Draws the graphite-tile-with-yellow-ring mark and encodes it as an 8-bit
 * RGB (no alpha — iOS wants full-bleed, opaque apple-touch-icons) PNG.
 *
 * `safeZoneFraction` is how much of the canvas the ring is allowed to use:
 * 1.0 for regular icons (the OS crops corners itself), ~0.8 for the
 * maskable icon (Android adaptive-icon spec requires all meaningful
 * content inside an 80%-diameter centred circle, since the OS may mask to
 * a circle, squircle, or rounded square — anything outside that circle can
 * be clipped away).
 */
function drawIcon(size, safeZoneFraction) {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = (size / 2) * safeZoneFraction * 0.78;
  const innerR = outerR * 0.62;

  const raw = Buffer.alloc(size * (1 + size * 3)); // filter byte + RGB per row
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const onRing = dist <= outerR && dist >= innerR;
      const [r, g, b] = onRing ? YELLOW : GRAPHITE;
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolor (RGB, no alpha)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idatData = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/generate-pwa-icons.mjs <output-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const specs = [
  // apple-touch-icon (web/app/layout.tsx `metadata.icons.apple`) — the size
  // iOS actually requests; the JSON manifest's icons array is not reliably
  // read by iOS (see the Phase 14 task brief / the report this script's
  // caller writes).
  { file: 'icon-180.png', size: 180, safeZoneFraction: 1.0 },
  // Android manifest minimum sizes (web/app/manifest.ts `icons`).
  { file: 'icon-192.png', size: 192, safeZoneFraction: 1.0 },
  { file: 'icon-512.png', size: 512, safeZoneFraction: 1.0 },
  // purpose: 'maskable' — extra inner padding, see drawIcon's doc comment.
  { file: 'icon-512-maskable.png', size: 512, safeZoneFraction: 0.8 },
];

for (const spec of specs) {
  const png = drawIcon(spec.size, spec.safeZoneFraction);
  writeFileSync(`${outDir}/${spec.file}`, png);
  console.log(`wrote ${outDir}/${spec.file} (${png.length} bytes)`);
}
