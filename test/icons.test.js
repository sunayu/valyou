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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const Icons = require("../scripts/make-icons.js");

test("the shield outline is a closed shape reaching from top to a bottom point", () => {
  const poly = Icons.shieldOutline();
  assert.ok(poly.length > 20, "should be a smooth many-point outline");
  const ys = poly.map((p) => p[1]);
  const xs = poly.map((p) => p[0]);
  // The silhouette spans most of the tile vertically and is centred.
  assert.ok(Math.min(...ys) < 0.2 && Math.max(...ys) > 0.85, "spans top to bottom point");
  assert.ok(Math.min(...xs) > 0.1 && Math.max(...xs) < 0.9, "stays within the tile");
});

test("the shield fills the centre and its point but not its corners", () => {
  // This is what distinguishes a shield from the old square: the four corners
  // are outside the shape, the vertical centre line (crown → point) is inside.
  assert.ok(Icons.shieldDistance(0.5, 0.5) < 0, "centre is inside");
  assert.ok(Icons.shieldDistance(0.5, 0.86) < 0, "the bottom point is inside");
  for (const [x, y] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]]) {
    assert.ok(Icons.shieldDistance(x, y) > 0, `corner ${x},${y} is outside`);
  }
  // The bottom corners taper away — outside — while the point between them is in.
  assert.ok(Icons.shieldDistance(0.12, 0.9) > 0, "bottom-left corner tapers away");
  assert.ok(Icons.shieldDistance(0.88, 0.9) > 0, "bottom-right corner tapers away");
});

test("crc32 matches the PNG specification's check value", () => {
  // "123456789" -> 0xCBF43926 is the standard CRC-32 test vector.
  assert.equal(Icons.crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
});

test("renderIcon produces a full RGBA buffer with content", () => {
  const size = 32;
  const rgba = Icons.renderIcon(size);
  assert.equal(rgba.length, size * size * 4);

  // Corners are outside the rounded square: fully transparent.
  assert.equal(rgba[3], 0, "top-left corner should be transparent");

  // The centre sits on the glyph: opaque and near-white.
  const centre = ((size / 2) * size + size / 2) * 4;
  assert.equal(rgba[centre + 3], 255, "centre should be opaque");
  assert.ok(rgba[centre] > 200 && rgba[centre + 1] > 200, "centre should be the white glyph");

  // A point between the glyph strokes near the top shows the brand gradient:
  // strongly blue, not white, not transparent.
  const mid = (Math.floor(size * 0.2) * size + Math.floor(size / 2)) * 4;
  assert.equal(rgba[mid + 3], 255);
  assert.ok(rgba[mid + 2] > rgba[mid], "background should be blue-dominant");
});

test("encodePng emits a structurally valid PNG", () => {
  const size = 16;
  const png = Icons.encodePng(Icons.renderIcon(size), size);

  // Signature.
  assert.deepEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );

  // IHDR immediately follows: correct dimensions, RGBA-8.
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), size, "width");
  assert.equal(png.readUInt32BE(20), size, "height");
  assert.equal(png[24], 8, "bit depth");
  assert.equal(png[25], 6, "colour type RGBA");

  // File ends with IEND.
  assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND");
});

test("the IDAT payload inflates back to the expected scanline size", () => {
  const size = 16;
  const png = Icons.encodePng(Icons.renderIcon(size), size);

  // Locate IDAT: after signature (8) + IHDR chunk (12 + 13).
  const idatStart = 8 + 12 + 13;
  assert.equal(png.toString("ascii", idatStart + 4, idatStart + 8), "IDAT");
  const idatLength = png.readUInt32BE(idatStart);
  const inflated = zlib.inflateSync(png.subarray(idatStart + 8, idatStart + 8 + idatLength));

  // Each scanline is 1 filter byte + width * 4 channel bytes.
  assert.equal(inflated.length, size * (size * 4 + 1));
});

test("every size the manifest references exists on disk and matches", () => {
  const iconDir = path.join(__dirname, "..", "icons");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );

  for (const [declaredSize, relPath] of Object.entries(manifest.icons)) {
    const file = path.join(__dirname, "..", relPath);
    assert.ok(fs.existsSync(file), `${relPath} missing — run scripts/make-icons.js`);

    // Verify the actual pixel dimensions match the declared size.
    const png = fs.readFileSync(file);
    assert.equal(png.readUInt32BE(16), Number(declaredSize), `${relPath} width`);
    assert.equal(png.readUInt32BE(20), Number(declaredSize), `${relPath} height`);
  }

  // The action icon set should reference the same files.
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  assert.equal(fs.readdirSync(iconDir).filter((f) => f.endsWith(".png")).length, Icons.SIZES.length);
});

test("the manifest description fits the Chrome Web Store limit", () => {
  // The store rejects an upload whose description exceeds 132 characters, and
  // it does so at upload time — after the package is built and the release is
  // tagged. Catch it here instead.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.ok(
    manifest.description.length <= 132,
    `description is ${manifest.description.length} characters, limit is 132`
  );
  assert.ok(manifest.description.length > 40, "description should actually describe the extension");
});
