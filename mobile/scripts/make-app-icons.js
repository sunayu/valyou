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
 * Native app-icon generator for iOS and Android.
 *
 * Reuses the exact brand mark from the extension's icon generator
 * (scripts/make-icons.js — the gradient shield with the white "v") and dresses
 * it for the two mobile platforms, with zero dependencies (same hand-rolled PNG
 * encoder). Run after any change to the mark:
 *
 *     node mobile/scripts/make-app-icons.js
 *
 * It writes, in place:
 *   - iOS  : every size in AppIcon.appiconset (opaque — App Store forbids alpha),
 *            plus the 1024 marketing icon, and rewrites the set's Contents.json.
 *   - Android: legacy raster mipmaps (ic_launcher / ic_launcher_round) at all
 *            five densities, AND a modern adaptive icon (background colour +
 *            foreground shield) so it renders crisply on Android 8+.
 *
 * ── For a reader new to this codebase ──────────────────────────────────
 * The actual drawing lives in scripts/make-icons.js (the extension icon
 * generator). This file IMPORTS its renderer and PNG encoder and only adds the
 * mobile-specific packaging: compositing the transparent shield onto an opaque
 * background, clipping it to a circle, centring it in a "safe zone", writing an
 * alpha-free PNG variant iOS demands, and emitting the platform metadata files
 * (Contents.json, adaptive-icon XML, colour resources).
 */
"use strict";

const fs = require("node:fs"); // write image + metadata files
const path = require("node:path"); // OS-independent paths
const zlib = require("node:zlib"); // deflate compression for the RGB PNG encoder below
// Reuse the extension icon generator's internals so the mark is IDENTICAL
// across web and mobile. Destructuring pulls the three exported functions out.
const { renderIcon, encodePng, crc32 } = require("../../scripts/make-icons.js");

const REPO = path.join(__dirname, "..", ".."); // repo root (this file is in mobile/scripts)
const APP = path.join(REPO, "mobile", "app");

/** App-icon backdrop — the app's own dark chrome colour (#0e1015), opaque. */
const BG = [14, 16, 21]; // [r, g, b] — the three colour channels, 0..255

/* ------------------------------------------------------------------ *
 * Compositing helpers                                                 *
 * ------------------------------------------------------------------ */

/**
 * Composite the transparent gradient shield over an opaque background, so the
 * result has no alpha channel variation (every pixel fully opaque). This is the
 * form iOS requires — an App Store icon with alpha is rejected.
 *
 * @param {number} size Edge length in pixels.
 * @param {number[]} bg Background [r,g,b].
 * @returns {Buffer} size*size*4 opaque RGBA.
 */
function opaqueIcon(size, bg) {
  const shield = renderIcon(size); // transparent RGBA shield from make-icons.js
  const out = Buffer.alloc(size * size * 4); // destination pixels (4 bytes each)
  for (let i = 0; i < size * size; i += 1) { // loop over every pixel
    const o = i * 4; // byte offset of this pixel (R at o, G at o+1, B o+2, A o+3)
    const a = shield[o + 3] / 255; // this pixel's alpha as a 0..1 fraction
    // Standard "over" alpha compositing: result = bg*(1-a) + foreground*a.
    // Where the shield is transparent (a=0) you get pure bg; where opaque
    // (a=1) you get the shield colour; edges blend smoothly.
    out[o] = Math.round(bg[0] * (1 - a) + shield[o] * a);
    out[o + 1] = Math.round(bg[1] * (1 - a) + shield[o + 1] * a);
    out[o + 2] = Math.round(bg[2] * (1 - a) + shield[o + 2] * a);
    out[o + 3] = 255; // force fully opaque
  }
  return out;
}

/**
 * Same as opaqueIcon, then clip to the inscribed circle (alpha 0 outside) — for
 * Android's `ic_launcher_round` on launchers that request a circular icon.
 *
 * @param {number} size Edge length in pixels.
 * @param {number[]} bg Background [r,g,b].
 * @returns {Buffer} size*size*4 RGBA, circular.
 */
function roundIcon(size, bg) {
  const out = opaqueIcon(size, bg); // start from the square opaque icon
  const r = size / 2; // circle radius = half the tile; centre is (r, r)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Distance of this pixel's centre from the tile centre.
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d = Math.hypot(dx, dy);
      if (d > r) {
        // Outside the circle → make this pixel transparent (alpha = 0). The
        // alpha byte is the 4th of the pixel, hence "* 4 + 3".
        out[(y * size + x) * 4 + 3] = 0;
      } else if (d > r - 1) {
        // one-pixel antialiased edge: fade alpha from 255 (at r-1) to 0 (at r)
        out[(y * size + x) * 4 + 3] = Math.round((r - d) * 255);
      }
    }
  }
  return out;
}

/**
 * The shield alone on a transparent canvas, scaled to `fill` of the tile and
 * centred — the foreground layer of an Android adaptive icon (the launcher
 * supplies the background and the mask). `fill` keeps the mark inside the 66%
 * adaptive safe zone.
 *
 * @param {number} size Full tile edge in pixels.
 * @param {number} fill Fraction of the tile the mark occupies (0..1).
 * @returns {Buffer} size*size*4 transparent-background RGBA.
 */
function foregroundIcon(size, fill) {
  // Render the shield at the smaller "inner" size, then centre it on a full
  // transparent tile so the launcher's mask/zoom has margin to work with.
  const inner = Math.max(1, Math.round(size * fill));
  const shield = renderIcon(inner);
  const out = Buffer.alloc(size * size * 4); // transparent
  const off = Math.floor((size - inner) / 2); // pixels of margin on each side
  for (let y = 0; y < inner; y += 1) { // copy the shield row by row
    const srcRow = y * inner * 4; // byte offset of row y in the shield
    const dstRow = ((y + off) * size + off) * 4; // where it lands in the padded tile
    // buffer.copy(target, targetStart, sourceStart, sourceEnd) copies one row.
    shield.copy(out, dstRow, srcRow, srcRow + inner * 4);
  }
  return out;
}

// Small helper: make sure the folder exists, encode the RGBA pixels as a PNG
// (with alpha), and write it. Returns the path for logging.
function write(file, rgba, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(rgba, size));
  return file;
}

/**
 * Build one PNG chunk (length + type + data + CRC), same as the base encoder.
 * (Re-declared here because make-icons.js doesn't export `chunk`, and the RGB
 * encoder below needs it.) See make-icons.js for the full PNG-format notes.
 */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); // 4-byte big-endian length
  head.write(type, 4, "ascii"); // 4-byte chunk type ("IHDR", "IDAT", ...)
  const crc = Buffer.alloc(4);
  // CRC checksum over type+data, so readers can detect corruption.
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encode an OPAQUE icon as a 24-bit RGB PNG (colour type 2 — no alpha channel).
 * The App Store rejects icons that carry an alpha channel at all, even when
 * every pixel is fully opaque, so iOS icons must be written without one.
 *
 * @param {Buffer} rgba size*size*4 source (alpha is dropped).
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} PNG file bytes, RGB.
 */
function encodePngRgbOpaque(rgba, size) {
  // IHDR header, same as the base encoder but colour type 2 (RGB, no alpha).
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour, no alpha
  // stride is now 3 bytes per pixel (no alpha channel), plus 1 filter byte/row.
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      // Read R,G,B from the 4-byte source pixel and copy only those three,
      // dropping the alpha byte entirely.
      const src = (y * size + x) * 4;
      const dst = rowStart + 1 + x * 3;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
    }
  }
  // Signature + chunks, exactly like the RGBA encoder (IDAT is the deflated
  // pixel data at max compression).
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Write an opaque icon as an alpha-free RGB PNG (for iOS). */
function writeRgb(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Composite onto BG, then encode WITHOUT an alpha channel (iOS requirement).
  fs.writeFileSync(file, encodePngRgbOpaque(opaqueIcon(size, BG), size));
  return file;
}

/* ------------------------------------------------------------------ *
 * iOS                                                                 *
 * ------------------------------------------------------------------ */

// iOS icon sizes are given in POINTS plus a SCALE factor; actual pixels =
// pt * scale (e.g. 20pt @3x = 60px). The 1024@1x is the App Store listing icon.
/** The AppIcon slots RN's template declares: [size-pt, scale]. */
const IOS_SLOTS = [
  [20, 2], [20, 3],
  [29, 2], [29, 3],
  [40, 2], [40, 3],
  [60, 2], [60, 3],
  [1024, 1],
];

function buildIos() {
  const set = path.join(APP, "ios", "valyou", "Images.xcassets", "AppIcon.appiconset");
  const images = []; // entries for the catalog's Contents.json
  // A Set is a collection of unique values; here it dedupes filenames so we
  // don't render the same pixel size twice.
  const done = new Set();
  for (const [pt, scale] of IOS_SLOTS) { // destructure each [pt, scale] pair
    const px = pt * scale; // pixel size to actually render
    const filename = `Icon-${pt}@${scale}x.png`;
    if (!done.has(filename)) {
      writeRgb(path.join(set, filename), px); // iOS: alpha-free RGB
      done.add(filename);
    }
    // Record the metadata Xcode's asset catalog needs to map each file.
    images.push({
      idiom: pt === 1024 ? "ios-marketing" : "iphone",
      size: `${pt}x${pt}`,
      scale: `${scale}x`,
      filename,
    });
  }
  // Write the catalog index. JSON.stringify(obj, null, 2) pretty-prints with a
  // 2-space indent; the trailing "\n" keeps the file newline-terminated.
  const contents = { images, info: { author: "valyou", version: 1 } };
  fs.writeFileSync(path.join(set, "Contents.json"), JSON.stringify(contents, null, 2) + "\n");
  return set;
}

/* ------------------------------------------------------------------ *
 * Android                                                             *
 * ------------------------------------------------------------------ */

// Android ships one icon per screen-density "bucket" (mdpi is the baseline;
// each step up is a higher-resolution screen, so a bigger pixel size).
/** Launcher-icon edge (px) per density bucket. */
const ANDROID_DENSITIES = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

function buildAndroid() {
  const res = path.join(APP, "android", "app", "src", "main", "res");

  // Object.entries turns the map into [key, value] pairs we can loop over.
  for (const [density, size] of Object.entries(ANDROID_DENSITIES)) {
    const dir = path.join(res, `mipmap-${density}`);
    // Legacy square + round rasters (pre-Android-8 and fallbacks).
    write(path.join(dir, "ic_launcher.png"), opaqueIcon(size, BG), size);
    write(path.join(dir, "ic_launcher_round.png"), roundIcon(size, BG), size);
    // Adaptive foreground layer (Android 8+): shield on transparent, safe-zoned.
    // 0.62 = keep the mark within the ~66% "safe zone" the launcher may crop to.
    write(path.join(dir, "ic_launcher_foreground.png"), foregroundIcon(size, 0.62), size);
  }

  // Adaptive-icon descriptors: an XML file telling Android to combine a
  // background colour with the foreground shield drawable. `adaptive` is an
  // arrow function that builds that XML text for a given foreground name.
  const adaptive = (fg) =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/ic_launcher_background" />\n' +
    `    <foreground android:drawable="@mipmap/${fg}" />\n` +
    "</adaptive-icon>\n";
  // "anydpi-v26" is the density-independent folder Android 8+ (API 26) reads.
  const anydpi = path.join(res, "mipmap-anydpi-v26");
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, "ic_launcher.xml"), adaptive("ic_launcher_foreground"));
  fs.writeFileSync(path.join(anydpi, "ic_launcher_round.xml"), adaptive("ic_launcher_foreground"));

  // Background colour resource. Convert each [r,g,b] value to a 2-digit hex
  // string (.toString(16) = base-16; padStart(2,"0") ensures two digits) and
  // join into a #rrggbb colour, then write it as an Android colour resource.
  const hex = "#" + BG.map((c) => c.toString(16).padStart(2, "0")).join("");
  const colors =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    "<resources>\n" +
    `    <color name="ic_launcher_background">${hex}</color>\n` +
    "</resources>\n";
  fs.writeFileSync(path.join(res, "values", "ic_launcher_background.xml"), colors);
  return res;
}

function buildStoreAssets() {
  const dir = path.join(REPO, "mobile", "store", "assets");
  // Google Play requires a 512×512 hi-res icon; App Store marketing icon is the
  // 1024 already in the asset catalog. Both opaque (no alpha channel).
  writeRgb(path.join(dir, "play-icon-512.png"), 512);
  return dir;
}

function main() {
  // Run all three generators and log where each wrote its files.
  const ios = buildIos();
  process.stdout.write("iOS  : wrote AppIcon.appiconset -> " + ios + "\n");
  const android = buildAndroid();
  process.stdout.write("Android: wrote mipmaps + adaptive icon -> " + android + "\n");
  const store = buildStoreAssets();
  process.stdout.write("Store: wrote hi-res store icon -> " + store + "\n");
}

// Exported for the unit tests; run directly as a CLI otherwise.
module.exports = { opaqueIcon, roundIcon, foregroundIcon, IOS_SLOTS, ANDROID_DENSITIES };

// Only run when invoked directly, not when `require`d by a test.
if (require.main === module) main();
