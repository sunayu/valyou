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
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { renderIcon, encodePng, crc32 } = require("../scripts/make-icons.js");

const HERE = __dirname;
const ICONSET = path.join(HERE, "xcode/valyou/Shared (App)/Assets.xcassets/AppIcon.appiconset");
const RES_ICON = path.join(HERE, "xcode/valyou/Shared (App)/Resources/Icon.png");
const BG = [14, 16, 21]; // #0e1015 — matches the mobile app icon backdrop

/** Composite the transparent gradient shield onto the opaque dark backdrop. */
function opaqueIcon(size) {
  const shield = renderIcon(size);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    const a = shield[o + 3] / 255;
    out[o] = Math.round(BG[0] * (1 - a) + shield[o] * a);
    out[o + 1] = Math.round(BG[1] * (1 - a) + shield[o + 1] * a);
    out[o + 2] = Math.round(BG[2] * (1 - a) + shield[o + 2] * a);
    out[o + 3] = 255;
  }
  return out;
}

/** One PNG chunk (length + type + data + CRC). */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode opaque RGBA as a 24-bit RGB PNG (colour type 2, no alpha channel). */
function encodeRgb(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour, no alpha
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const s = (y * size + x) * 4;
      const d = row + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIconset(name, size) {
  fs.writeFileSync(path.join(ICONSET, name), encodeRgb(opaqueIcon(size), size));
}

function main() {
  // iOS marketing icon (must have no alpha channel).
  writeIconset("universal-icon-1024@1x.png", 1024);

  // macOS icon set: [point-size, scale] -> pixels.
  const macSlots = [
    [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
    [256, 1], [256, 2], [512, 1], [512, 2],
  ];
  for (const [pt, scale] of macSlots) {
    writeIconset(`mac-icon-${pt}@${scale}x.png`, pt * scale);
  }

  // Container-app UI icon (transparent shield, shown at 128px on the page).
  fs.writeFileSync(RES_ICON, encodePng(renderIcon(256), 256));

  process.stdout.write("wrote iOS 1024 + 10 macOS icons + container Icon.png\n");
}

if (require.main === module) main();
