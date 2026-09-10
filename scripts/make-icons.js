/*
 * valyou — on-device social media content filtering.
 * Copyright (C) 2026 Sunayu LLC
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional permission under GNU GPL version 3 section 7: this
 * Program may be distributed through the Apple App Store, Google Play,
 * or comparable platforms whose terms would otherwise be incompatible
 * with the GPL. See LICENSE-EXCEPTION.
 */

/**
 * Brand icon generator.
 *
 * Renders the valyou mark — a white "v" on an indigo-to-violet gradient
 * rounded square — at every size Chrome wants, and writes real PNG files
 * with zero dependencies: pixels are computed with signed-distance
 * functions and the PNG container is assembled by hand on top of Node's
 * built-in zlib.
 *
 * Run once (and re-run only if the mark changes):
 *
 *     node scripts/make-icons.js
 *
 * The generated PNGs are committed, so the extension loads with no build
 * step; this script is tooling, not part of the runtime.
 *
 * ── For a reader new to this codebase ──────────────────────────────────
 * There is no image library here. The script does three things by hand:
 *   1. RASTERIZE — for every pixel it computes a colour from math (a
 *      "signed distance function" tells us how far a pixel is from the edge
 *      of the shape, which gives smooth, anti-aliased edges).
 *   2. COMPRESS  — the raw pixels are deflate-compressed with Node's zlib.
 *   3. ENCODE    — the compressed bytes are wrapped in the PNG file format
 *      (a signature followed by "chunks", each with its own checksum).
 * If any of "signed distance function", "buffer", or "PNG chunk" are new to
 * you, the comments below explain each the first time it appears.
 */
"use strict";

// `require(...)` is Node's classic (CommonJS) way to import a module; it
// returns whatever that module exported. The "node:" prefix means "this is a
// built-in Node module", not a package installed from npm.
const zlib = require("node:zlib"); // gzip/deflate compression (used for PNG data)
const fs = require("node:fs"); // file system: read/write files, make directories
const path = require("node:path"); // build file paths that work on any OS

/** Sizes Chrome uses: toolbar (16/32), management page (48), store (128). */
const SIZES = [16, 32, 48, 128];

/** Brand gradient endpoints (top-left -> bottom-right). */
const GRADIENT_FROM = [47, 111, 235]; // #2F6FEB indigo
const GRADIENT_TO = [124, 92, 255]; // #7C5CFF violet

/* ------------------------------------------------------------------ *
 * Geometry — signed distance functions in normalized 0..1 space       *
 * ------------------------------------------------------------------ */

/**
 * Distance from point (px,py) to the line segment (ax,ay)-(bx,by).
 * The two strokes of the "v" are fat segments with round caps, which is
 * exactly what a distance-to-segment threshold produces.
 *
 * WHY: if we know how far every pixel is from the centre-line of a stroke,
 * we can "paint" the stroke by colouring pixels whose distance is under the
 * stroke's half-width — and fade the boundary for a smooth edge. Round caps
 * come for free because distance-to-a-segment is naturally rounded at the
 * ends.
 *
 * @returns {number} Euclidean distance in normalized units.
 */
function segmentDistance(px, py, ax, ay, bx, by) {
  // Vector from A to B (the segment) and from A to the point P.
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  // Project P onto the infinite line through A-B, expressed as a fraction t
  // along the segment. Dot product / squared-length is the standard formula.
  // clamp t to [0,1] so we stay on the segment (not the infinite line) — this
  // is what rounds off the ends into caps.
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  // (cx,cy) is the closest point on the segment to P.
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  // Math.hypot = sqrt(dx*dx + dy*dy): straight-line (Euclidean) distance.
  return Math.hypot(px - cx, py - cy);
}

/**
 * Signed distance to a rounded square centred in the unit box.
 * Negative inside, positive outside. Retained for reference/tests.
 *
 * @param {number} px X in 0..1.
 * @param {number} py Y in 0..1.
 * @param {number} half Half-extent of the square.
 * @param {number} radius Corner radius.
 * @returns {number} Signed distance ("signed" = negative inside the shape,
 *   zero on the edge, positive outside — the sign tells you which side).
 */
function roundedSquareDistance(px, py, half, radius) {
  // Fold the point into one quadrant (Math.abs) so we only reason about a
  // single corner; the shrink by (half - radius) is the standard rounded-box
  // signed-distance trick.
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/**
 * The heraldic shield outline, as a closed polygon of boundary points in
 * normalized 0..1 space.
 *
 * A shield is the right silhouette for valyou: it reads instantly as
 * protection / safety / "filtered", which is exactly the product. The shape
 * is a flat rounded top that tapers through the shoulders to a single point —
 * the classic protective crest. Built once; the render loop measures signed
 * distance to it.
 *
 * @returns {Array<[number, number]>} Closed polygon, right half then mirrored.
 */
function shieldOutline() {
  const cx = 0.5;
  const yTop = 0.14; // top edge
  const yShoulder = 0.5; // where the straight sides begin to taper
  const yPoint = 0.9; // bottom point
  const halfW = 0.34; // half-width at the shoulders
  const rCorner = 0.11; // top-corner radius
  const N = 20; // samples per curved section (smooth at 128px)

  // We build only the RIGHT half of the shield as a list of [x,y] points,
  // then mirror it at the end. `right` is an array of points; `.push` appends.
  const right = [];
  right.push([cx, yTop]); // top-centre
  right.push([cx + halfW - rCorner, yTop]); // flat top to corner start

  // Rounded top-right corner (quarter arc, -90° → 0°). We approximate the arc
  // by sampling N points along it with cos/sin — a circle of radius rCorner
  // centred at (ccx,ccy).
  const ccx = cx + halfW - rCorner;
  const ccy = yTop + rCorner;
  for (let i = 1; i <= N; i += 1) {
    const a = -Math.PI / 2 + (i / N) * (Math.PI / 2);
    right.push([ccx + rCorner * Math.cos(a), ccy + rCorner * Math.sin(a)]);
  }

  // Straight right side down to the shoulder.
  right.push([cx + halfW, yShoulder]);

  // Quadratic-bezier belly from shoulder to the bottom point — the graceful
  // inward sweep that makes it read as a shield rather than a spade.
  // A quadratic Bézier curve is defined by three control points p0,p1,p2. For
  // a fraction t from 0→1, the point on the curve is:
  //   (1-t)^2*p0 + 2(1-t)t*p1 + t^2*p2   (here mt = 1-t).
  // p1 is the "pull" handle that bends the straight line into the belly curve.
  const p0 = [cx + halfW, yShoulder];
  const p1 = [cx + halfW * 0.97, yShoulder + (yPoint - yShoulder) * 0.5];
  const p2 = [cx, yPoint];
  for (let i = 1; i <= N; i += 1) {
    const t = i / N;
    const mt = 1 - t;
    right.push([
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ]);
  }

  // Mirror the right half across the centre line to close the polygon.
  // `right.slice()` makes a shallow copy so we don't mutate `right` while
  // reading it. We walk the right-side points backwards and reflect each x
  // about cx (x → cx - (x - cx)) to produce the left side.
  const poly = right.slice();
  for (let i = right.length - 2; i >= 1; i -= 1) {
    const [x, y] = right[i]; // array destructuring: unpack [x, y] from the point
    poly.push([cx - (x - cx), y]);
  }
  return poly;
}

/** The shield polygon, computed once and reused for every pixel/size. */
const SHIELD = shieldOutline();

/**
 * Even-odd point-in-polygon test (ray casting).
 *
 * WHY: shoot an imaginary horizontal ray from the point out to the right and
 * count how many polygon edges it crosses. Odd number of crossings = inside,
 * even = outside. We use this to know whether a pixel is within the shield so
 * we can give the distance the correct sign.
 *
 * @param {number} px X in 0..1.
 * @param {number} py Y in 0..1.
 * @param {Array<[number, number]>} poly Closed polygon.
 * @returns {boolean} true when inside.
 */
function pointInPolygon(px, py, poly) {
  let inside = false;
  // i walks each vertex; j trails one behind (the previous vertex), so (j,i)
  // is one edge. Starting j at the last vertex closes the loop (last→first).
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // First test: does this edge straddle the ray's height py? Second test:
    // is the crossing point to the right of px? If both, the ray crosses this
    // edge, so flip inside/outside. (a !== b on booleans is "exclusive or".)
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Signed distance from a point to the shield boundary (negative inside).
 *
 * @param {number} px X in 0..1.
 * @param {number} py Y in 0..1.
 * @returns {number} Signed distance in normalized units.
 */
function shieldDistance(px, py) {
  // Distance to the outline = the smallest distance to any of its edges.
  let min = Infinity;
  for (let i = 0, j = SHIELD.length - 1; i < SHIELD.length; j = i, i += 1) {
    const d = segmentDistance(px, py, SHIELD[j][0], SHIELD[j][1], SHIELD[i][0], SHIELD[i][1]);
    if (d < min) min = d;
  }
  // Inside → negative, outside → positive. Ternary: cond ? ifTrue : ifFalse.
  return pointInPolygon(px, py, SHIELD) ? -min : min;
}

/**
 * Coverage (0..1) for a signed distance, antialiased over one pixel.
 *
 * WHY: a pixel right on the shape's edge should be half-filled, not a hard
 * on/off — that is what makes edges look smooth instead of jagged. Well
 * inside the shape coverage is 1 (fully painted); well outside it is 0; and
 * within a one-pixel band around the edge it ramps between the two. The
 * Math.max/Math.min pair just clamps the result to the 0..1 range.
 *
 * @param {number} distance Signed distance (negative = inside).
 * @param {number} pixel Size of one pixel in normalized units.
 * @returns {number} Alpha coverage.
 */
function coverage(distance, pixel) {
  return Math.max(0, Math.min(1, 0.5 - distance / pixel));
}

/**
 * Render one icon as an RGBA buffer.
 *
 * Layers, back to front: transparent canvas -> gradient shield silhouette ->
 * soft top-left highlight -> white "v" glyph seated in the shield.
 *
 * The mark says what the product is: a shield (protection / filtering) that
 * carries the brand "v" — which, seated point-down inside the crest, also
 * reads as a checkmark: vetted, safe, this passed the filter.
 *
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} size*size*4 RGBA bytes.
 */
function renderIcon(size) {
  // A Buffer is Node's fixed-length array of raw bytes (0..255). We need 4
  // bytes per pixel — Red, Green, Blue, Alpha — so size*size*4 in all.
  // Buffer.alloc zero-fills, which conveniently means "transparent black".
  const out = Buffer.alloc(size * size * 4);
  const px = 1 / size; // width of one pixel in the 0..1 normalized space

  // The v: two strokes meeting at the bottom vertex, round caps, sized to sit
  // in the upper body of the shield with its point echoing the crest's point.
  const strokeWidth = 0.072;
  const vTopY = 0.32;
  const vBottomY = 0.62;
  const vSpread = 0.155;

  // Visit every pixel (row y, column x) and decide its colour.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Normalized pixel-CENTRE coordinates in 0..1 (the +0.5 samples the
      // middle of the pixel, which is where anti-aliasing wants to measure).
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;

      // Shield silhouette with the brand gradient.
      const bgAlpha = coverage(shieldDistance(nx, ny), px);
      if (bgAlpha <= 0) {
        // Fully outside the shield — leave the pixel transparent.
        continue;
      }

      // Diagonal top-left → bottom-right brand gradient. t goes 0→1 as we move
      // toward the bottom-right; each colour channel is linearly interpolated
      // (a "lerp": from + (to - from) * t) between the two gradient endpoints.
      const t = (nx + ny) / 2;
      let r = GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t;
      let g = GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t;
      let b = GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t;

      // Gentle highlight toward the top-left so the crest reads as lit metal
      // rather than a flat fill, even at 16px.
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.36, ny - 0.24) * 1.7) * 0.2;
      r += (255 - r) * glow;
      g += (255 - g) * glow;
      b += (255 - b) * glow;

      // White "v" glyph: distance to the nearer of the two strokes. Subtracting
      // strokeWidth turns the centre-line distance into a "fat" stroke, and
      // coverage() gives a soft anti-aliased edge just like the shield.
      const leftStroke = segmentDistance(nx, ny, 0.5 - vSpread, vTopY, 0.5, vBottomY);
      const rightStroke = segmentDistance(nx, ny, 0.5 + vSpread, vTopY, 0.5, vBottomY);
      const glyphAlpha = coverage(Math.min(leftStroke, rightStroke) - strokeWidth, px);

      // Blend toward white by the glyph coverage (another lerp, target = 255).
      r = r + (255 - r) * glyphAlpha;
      g = g + (255 - g) * glyphAlpha;
      b = b + (255 - b) * glyphAlpha;

      // Write the 4 bytes for this pixel. Rows are stored top-to-bottom, left
      // to right, so pixel (x,y) starts at byte (y*size + x)*4. Math.round
      // because colour channels are whole numbers 0..255.
      const offset = (y * size + x) * 4;
      out[offset] = Math.round(r);
      out[offset + 1] = Math.round(g);
      out[offset + 2] = Math.round(b);
      out[offset + 3] = Math.round(bgAlpha * 255); // alpha: shield edge fades out
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * PNG container                                                       *
 * ------------------------------------------------------------------ */

// A PNG file is: an 8-byte signature, then a sequence of "chunks". Each chunk
// is [4-byte length][4-byte type like "IHDR"][data][4-byte CRC checksum].
// The CRC lets a reader detect corruption. Below we build the tooling to
// compute that checksum and to assemble chunks, then the file itself.

/**
 * CRC-32 lookup table, built once (standard PNG polynomial 0xEDB88320).
 *
 * WHY a table: CRC-32 processes data one byte at a time doing 8 bit-shifts
 * each; precomputing the result for all 256 possible byte values makes the
 * real loop a single lookup per byte instead of 8 operations. This is an
 * IIFE — "(() => { ... })()" — a function defined and immediately called, a
 * common JS idiom to run setup code and capture its result into a constant.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256); // typed array of 256 signed 32-bit ints
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      // Bitwise CRC step. `c & 1` tests the lowest bit; `>>> 1` is an unsigned
      // right shift (divide by 2, dropping the bit); `^` is XOR. If the low
      // bit was set, XOR in the polynomial constant.
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 as PNG specifies it (ISO 3309), over type + data bytes.
 *
 * @param {Buffer} buf Bytes to checksum.
 * @returns {number} Unsigned 32-bit CRC.
 */
function crc32(buf) {
  let c = 0xffffffff; // CRC starts as all 1-bits, per the spec
  for (let i = 0; i < buf.length; i += 1) {
    // Fold the next byte into the running CRC via the lookup table.
    // `& 0xff` keeps only the low 8 bits (one byte) as the table index.
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  // Final XOR with all 1-bits; `>>> 0` forces the result to an unsigned 32-bit
  // integer (JS bit ops otherwise yield a signed number).
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble one PNG chunk: length + type + data + CRC(type+data).
 *
 * @param {string} type Four-character chunk type.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} Complete chunk.
 */
function chunk(type, data) {
  // 8-byte header = 4-byte length + 4-byte type. "BE" = big-endian byte order
  // (most-significant byte first), which is what the PNG spec mandates.
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); // length at byte offset 0
  head.write(type, 4, "ascii"); // 4 ASCII chars of the type at offset 4
  // The CRC covers the type bytes AND the data bytes (not the length).
  // Buffer.concat glues buffers together into one.
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encode an RGBA buffer as a PNG file.
 *
 * @param {Buffer} rgba size*size*4 pixel bytes.
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} Complete PNG file contents.
 */
function encodePng(rgba, size) {
  // IHDR is the mandatory first chunk: a 13-byte header describing the image.
  // Width and height are 4 bytes each; then depth/colour-type/etc.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth: 8 bits per channel
  ihdr[9] = 6; // colour type RGBA (6 = truecolour + alpha)
  // bytes 10-12: compression 0, filter 0, interlace 0
  // (Buffer.alloc already zero-filled them, so the defaults are correct.)

  // Raw image data before compression. PNG requires each row ("scanline") to
  // begin with a filter-type byte; 0 means "None" (store the pixels as-is).
  // stride = bytes per row of pixels; +1 per row for that filter byte.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter byte for this row = None
    // Copy this row's pixels in right after the filter byte. buffer.copy(
    // target, targetStart, sourceStart, sourceEnd).
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  // The finished file: signature + the three chunks. IDAT holds the pixel data
  // compressed with zlib deflate (level 9 = maximum compression). IEND is the
  // empty end-marker chunk.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // 8-byte PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render and write every icon size into icons/.
 *
 * @param {string} outDir Destination directory.
 * @returns {string[]} Paths written.
 */
function main(outDir) {
  // Create the output directory if missing ({recursive:true} also makes any
  // parent dirs and does not error if it already exists).
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const size of SIZES) {
    // path.join builds "outDir/icon<size>.png" with the right separator.
    const file = path.join(outDir, `icon${size}.png`); // backtick template string
    fs.writeFileSync(file, encodePng(renderIcon(size), size)); // render → encode → save
    written.push(file);
  }
  return written;
}

// `module.exports` is how a CommonJS module makes values importable by other
// files. Here we expose the internals so the unit tests can call them directly.
/* Exported for the unit tests; executed directly as a CLI. */
module.exports = {
  SIZES,
  renderIcon,
  encodePng,
  crc32,
  segmentDistance,
  roundedSquareDistance,
  shieldOutline,
  shieldDistance,
  pointInPolygon,
};

// `require.main === module` is true only when this file was run directly
// (`node scripts/make-icons.js`), and false when another file `require`d it
// (like the tests). So this block is the command-line entry point.
// `__dirname` is the folder this script lives in; ".." steps up to the repo
// root, then into "icons".
if (require.main === module) {
  const out = main(path.join(__dirname, "..", "icons"));
  for (const file of out) console.log(`wrote ${file}`);
}
