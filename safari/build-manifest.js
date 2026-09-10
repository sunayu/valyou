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

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "xcode/valyou/Shared (Extension)/Resources/manifest.json");

// The dependency list MUST match the importScripts() list in
// src/background/service-worker.js, in the same order, followed by the worker
// file itself. (In the background page they load top-to-bottom as <script> tags.)
const BACKGROUND_SCRIPTS = [
  "src/lib/text.js",
  "src/lib/taxonomy.js",
  "src/lib/crypto.js",
  "src/lib/store.js",
  "src/lib/lexicon.js",
  "src/lib/ml.js",
  "src/model/model-data.js",
  "src/lib/scorer.js",
  "src/lib/settings.js",
  "src/background/service-worker.js",
];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
// Swap the service worker for a non-persistent background page.
manifest.background = { scripts: BACKGROUND_SCRIPTS, persistent: false };

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log("wrote Safari manifest (non-persistent background page) -> " + OUT);
