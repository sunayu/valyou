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
 * Fetch the training corpus for the ML assist.
 *
 * Dataset: Davidson, Warmsley, Macy & Weber (ICWSM 2017), "Automated Hate
 * Speech Detection and the Problem of Offensive Language" — ~25k tweets,
 * each labelled by CrowdFlower majority vote as hate speech (0), offensive
 * but not hate (1), or neither (2). MIT-licensed.
 * https://github.com/t-davidson/hate-speech-and-offensive-language
 *
 * The raw data is offensive by nature (it is a hate-speech corpus) and is
 * NOT committed: training-data/ is gitignored, and this script exists so a
 * clean checkout can reproduce the model with one command. Only the trained,
 * quantized weights ship.
 *
 * This is offline TOOLING, like make-icons.js — nothing in the extension
 * ever performs a network request.
 *
 * Usage:  node scripts/fetch-training-data.js
 */
"use strict";

const fs = require("node:fs"); // write the downloaded file to disk
const path = require("node:path"); // build OS-independent paths
const https = require("node:https"); // built-in HTTPS client (no npm package needed)

// The public raw-file URL of the dataset on GitHub.
const SOURCE =
  "https://raw.githubusercontent.com/t-davidson/hate-speech-and-offensive-language/master/data/labeled_data.csv";

// Where to save it. __dirname is this script's folder; ".." is the repo root.
const OUT_DIR = path.join(__dirname, "..", "training-data");
const OUT_FILE = path.join(OUT_DIR, "davidson.csv");

/**
 * Download a URL to a string, following redirects.
 *
 * WHY a Promise: the download is asynchronous — data arrives over time in
 * pieces ("chunks"), not all at once. A Promise represents that eventual
 * result: call `resolve(value)` on success or `reject(error)` on failure, and
 * the caller can `await` it. `hops` guards against an infinite redirect loop.
 *
 * @param {string} url Source URL.
 * @param {number} [hops=0] Redirect depth guard.
 * @returns {Promise<string>} Response body.
 */
function fetchText(url, hops = 0) { // [hops=0] is a default parameter value
  return new Promise((resolve, reject) => {
    if (hops > 4) return reject(new Error("too many redirects"));
    https
      .get(url, (res) => { // callback runs when the response starts arriving
        // 3xx status + a Location header = a redirect; follow it recursively.
        // res.resume() drains/discards the redirect response body so the
        // socket can be freed.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(res.headers.location, hops + 1));
        }
        // Anything other than 200 OK is an error here.
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        // Collect the body chunks as they stream in, then join them at the end.
        const chunks = [];
        res.on("data", (c) => chunks.push(c)); // fires repeatedly, one buffer per chunk
        // "end" fires once when the download is complete: concat the buffers
        // and decode the bytes as UTF-8 text.
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject); // network-level failure → reject the promise
  });
}

// `async` lets us use `await` inside to pause for the download to finish
// without blocking the whole program.
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true }); // ensure training-data/ exists

  process.stdout.write(`fetching ${SOURCE}\n`);
  const csv = await fetchText(SOURCE); // wait for the full download

  // Sanity-check the shape before trusting it: header + row count. A bad
  // download or a changed dataset should fail loudly, not silently poison the
  // model. lines[0] is the header row.
  const lines = csv.split("\n");
  if (!lines[0].includes("class") || !lines[0].includes("tweet")) {
    throw new Error("unexpected CSV header — dataset layout changed?");
  }
  if (lines.length < 20000) {
    throw new Error(`suspiciously small dataset (${lines.length} lines)`);
  }

  fs.writeFileSync(OUT_FILE, csv); // save the raw corpus (gitignored)
  process.stdout.write(`wrote ${OUT_FILE} (${lines.length - 1} rows)\n`); // -1 for the header
}

// Run it. Because main() is async it returns a Promise; .catch handles any
// error (download failure or a failed sanity check) by printing it and exiting
// with a non-zero status.
main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
