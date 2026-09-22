"use strict";

/**
 * GenUI icon generator — deterministic, dependency-free.
 *
 * The image model was not configured, and the marketplace catalog carries no
 * icon field at all (0 of 28 live entries have one), so this exists only so the
 * plugin does not fall back to the host's letter tile in the local plugins
 * list. It draws the icon with plain arithmetic and encodes a real PNG with
 * node:zlib — reproducible on any machine, no image model, no network.
 *
 *   node scripts/make-icon.mjs
 *
 * Output: assets/icon.png (512x512 RGBA) and assets/icon.svg
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const SIZE = 512;
const SS = 4; // supersample factor: 4x4 samples per output pixel, for clean edges
const BIG = SIZE * SS;

/* ---------- tiny raster helpers (all coordinates in 512-space, scaled up) ---------- */

function makeBuffer() {
  return new Float64Array(BIG * BIG * 4); // r,g,b,a premultiplied-by-alpha in 0..1
}

function over(buf, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= BIG || y >= BIG || a <= 0) return;
  const i = (y * BIG + x) * 4;
  const dr = buf[i];
  const dg = buf[i + 1];
  const db = buf[i + 2];
  const da = buf[i + 3];
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  buf[i] = (r * a + dr * da * (1 - a)) / outA;
  buf[i + 1] = (g * a + dg * da * (1 - a)) / outA;
  buf[i + 2] = (b * a + db * da * (1 - a)) / outA;
  buf[i + 3] = outA;
}

/** Rounded rectangle in 512-space. */
function roundRect(buf, x0, y0, w, h, radius, color, alpha) {
  const X0 = x0 * SS;
  const Y0 = y0 * SS;
  const X1 = (x0 + w) * SS;
  const Y1 = (y0 + h) * SS;
  const R = radius * SS;
  for (let y = Math.floor(Y0); y < Math.ceil(Y1); y += 1) {
    for (let x = Math.floor(X0); x < Math.ceil(X1); x += 1) {
      const cx = Math.min(Math.max(x + 0.5, X0 + R), X1 - R);
      const cy = Math.min(Math.max(y + 0.5, Y0 + R), Y1 - R);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= R * R) over(buf, x, y, color, alpha);
    }
  }
}

/** Vertical gradient inside a rounded rectangle (drawn as 1px rows). */
function roundRectGradient(buf, x0, y0, w, h, radius, top, bottom) {
  const X0 = x0 * SS;
  const Y0 = y0 * SS;
  const X1 = (x0 + w) * SS;
  const Y1 = (y0 + h) * SS;
  const R = radius * SS;
  for (let y = Math.floor(Y0); y < Math.ceil(Y1); y += 1) {
    const t = Math.min(1, Math.max(0, (y + 0.5 - Y0) / (Y1 - Y0)));
    const color = [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t,
    ];
    for (let x = Math.floor(X0); x < Math.ceil(X1); x += 1) {
      const cx = Math.min(Math.max(x + 0.5, X0 + R), X1 - R);
      const cy = Math.min(Math.max(y + 0.5, Y0 + R), Y1 - R);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= R * R) over(buf, x, y, color, 1);
    }
  }
}

/** Circle / annulus in 512-space. */
function disc(buf, cx, cy, radius, color, alpha, innerRadius = 0) {
  const CX = cx * SS;
  const CY = cy * SS;
  const R = radius * SS;
  const IR = innerRadius * SS;
  for (let y = Math.floor(CY - R); y < Math.ceil(CY + R); y += 1) {
    for (let x = Math.floor(CX - R); x < Math.ceil(CX + R); x += 1) {
      const dx = x + 0.5 - CX;
      const dy = y + 0.5 - CY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= R * R && d2 >= IR * IR) over(buf, x, y, color, alpha);
    }
  }
}

/* ---------- the icon ---------- */

const INK = [0.16, 0.15, 0.22];
const INDIGO = [0.31, 0.27, 0.9];
const VIOLET = [0.49, 0.23, 0.93];
const WHITE = [1, 1, 1];
const AMBER = [0.98, 0.75, 0.14];

function draw() {
  const buf = makeBuffer();

  // Tile: rounded square with an indigo -> violet gradient.
  roundRectGradient(buf, 36, 36, 440, 440, 104, INDIGO, VIOLET);

  // Bento motif: a data card on top...
  roundRect(buf, 132, 132, 248, 84, 22, WHITE, 0.94);
  roundRect(buf, 158, 162, 92, 20, 10, INDIGO, 0.75);
  roundRect(buf, 266, 162, 62, 20, 10, AMBER, 1);

  // ...and below it, three bars of increasing height plus a ring that overlaps
  // the tallest bar, to read as "composed components" rather than a chart alone.
  const bars = [
    { x: 132, h: 58 },
    { x: 196, h: 92 },
    { x: 260, h: 74 },
  ];
  for (const bar of bars) roundRect(buf, bar.x, 372 - bar.h, 40, bar.h, 12, WHITE, 0.9);

  disc(buf, 356, 314, 52, AMBER, 1, 30); // ring
  disc(buf, 356, 314, 52, WHITE, 0.35, 46); // hairline highlight

  // Subtle ink outline keeps the tile readable on a white plugins list.
  roundRect(buf, 36, 36, 440, 440, 104, INK, 0.0); // no-op placeholder for clarity

  return buf;
}

/* ---------- downsample + PNG encode ---------- */

function downsample(buf) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const n = SS * SS;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * BIG + (x * SS + sx)) * 4;
          const sa = buf[i + 3];
          r += buf[i] * sa;
          g += buf[i + 1] * sa;
          b += buf[i + 2] * sa;
          a += sa;
        }
      }
      const o = (y * SIZE + x) * 4;
      if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- SVG twin ---------- */

function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="GenUI">
  <title>GenUI</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f45e6"/>
      <stop offset="1" stop-color="#7d3bee"/>
    </linearGradient>
  </defs>
  <rect x="36" y="36" width="440" height="440" rx="104" fill="url(#tile)"/>
  <g>
    <rect x="132" y="132" width="248" height="84" rx="22" fill="#fff" fill-opacity="0.94"/>
    <rect x="158" y="162" width="92" height="20" rx="10" fill="#4f45e6" fill-opacity="0.75"/>
    <rect x="266" y="162" width="62" height="20" rx="10" fill="#fbbf24"/>
  </g>
  <g fill="#fff" fill-opacity="0.9">
    <rect x="132" y="314" width="40" height="58" rx="12"/>
    <rect x="196" y="280" width="40" height="92" rx="12"/>
    <rect x="260" y="298" width="40" height="74" rx="12"/>
  </g>
  <circle cx="356" cy="314" r="41" fill="none" stroke="#fbbf24" stroke-width="22"/>
</svg>
`;
}

/* ---------- run ---------- */

const outDir = path.join(import.meta.dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

const rgba = downsample(draw());
const png = encodePng(rgba, SIZE, SIZE);
fs.writeFileSync(path.join(outDir, "icon.png"), png);
fs.writeFileSync(path.join(outDir, "icon.svg"), svg(), "utf8");

console.log(`assets/icon.png  ${SIZE}x${SIZE}  ${png.length} bytes`);
console.log(`assets/icon.svg  ${Buffer.byteLength(svg(), "utf8")} bytes`);
console.log("sha256(png):", createHash("sha256").update(png).digest("hex").slice(0, 32));