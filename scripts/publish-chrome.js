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
 * Publish the extension to the Chrome Web Store from the terminal.
 *
 * Packages exactly what docs/RELEASE.md says ships (manifest, icons, src),
 * refuses to proceed if the tests fail or the manifest and package.json
 * versions disagree, uploads the zip, waits for the store to finish
 * processing it, and submits it for review.
 *
 * Usage:
 *   npm run release:chrome                 build, upload, submit at 100%
 *   npm run release:chrome -- --percent 10 staged rollout (raise later with --rollout N)
 *   npm run release:chrome -- --upload-only upload without submitting
 *   npm run release:chrome -- --zip valyou-1.0.1.zip   use an existing package
 *   npm run release:chrome -- --status      just print what the store holds
 *   npm run release:chrome -- --rollout 100 raise the published revision's rollout
 *   npm run release:chrome -- --dry-run     build and check, touch nothing remote
 *
 * Credentials come from .cws.env — mint them once with npm run release:chrome:auth.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require("./cws-lib");

const ROOT = lib.ROOT;

/** @returns {{[flag: string]: string|boolean}} Parsed --flags. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function log(msg) { console.log(`publish-chrome: ${msg}`); }

/** Ensure the two version sources agree and return the version. */
function releaseVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest.json is ${manifest.version} but package.json is ${pkg.version} — bump both`);
  }
  if (!/^\d+(\.\d+){1,3}$/.test(manifest.version)) {
    throw new Error(`"${manifest.version}" is not a Chrome version (strictly numeric dotted)`);
  }
  return manifest.version;
}

/** Run the suite; the store is no place to find out it was red. */
function runTests() {
  log("running the test suite");
  execFileSync("node", ["--test", ...fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f))], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

/**
 * Build the curated zip exactly as the release doc prescribes.
 *
 * @param {string} version
 * @returns {string} Path to the zip.
 */
function buildZip(version) {
  const out = path.join(ROOT, `valyou-${version}.zip`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  execFileSync("zip", ["-qr", out, "manifest.json", "icons", "src", "-x", "*.DS_Store"], { cwd: ROOT, stdio: "inherit" });
  const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
  if (/\b(test|training-data|node_modules)\//.test(listing)) {
    throw new Error("the package contains files that must never ship");
  }
  log(`packaged ${path.basename(out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  return out;
}

/**
 * Print what the store currently holds for the item.
 *
 * @returns {Promise<object>} The raw status.
 */
async function showStatus(token, cfg) {
  const s = await lib.fetchStatus(token, cfg);
  const describe = (rev) => {
    if (!rev) return "none";
    const ch = (rev.distributionChannels || [])[0] || {};
    const pct = ch.deployPercentage !== undefined ? ` at ${ch.deployPercentage}%` : "";
    return `${ch.crxVersion || "?"} (${rev.state || "unknown"}${pct})`;
  };
  log(`published: ${describe(s.publishedItemRevisionStatus)}`);
  log(`submitted: ${describe(s.submittedItemRevisionStatus)}`);
  if (s.lastAsyncUploadState) log(`last upload: ${s.lastAsyncUploadState}`);
  if (s.takenDown) log("WARNING: the item is taken down");
  if (s.warned) log("WARNING: the item carries a store warning");
  return s;
}

/**
 * Poll until the store has finished ingesting the upload.
 *
 * @returns {Promise<string>} The final upload state.
 */
async function waitForUpload(token, cfg) {
  const started = Date.now();
  for (;;) {
    const s = await lib.fetchStatus(token, cfg);
    const st = String(s.lastAsyncUploadState || "");
    if (/FAIL|ERROR|REJECT/i.test(st)) throw new Error(`upload processing failed: ${st}`);
    if (st && !/PROGRESS|PENDING|UNSPECIFIED/i.test(st)) return st;
    if (Date.now() - started > 10 * 60 * 1000) throw new Error(`upload still ${st || "pending"} after 10 minutes`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = lib.loadConfig();

  if (args.status || args.rollout) {
    const token = await lib.accessToken(cfg);
    if (args.rollout) {
      const pct = Number(args.rollout);
      if (!(pct > 0 && pct <= 100)) throw new Error("--rollout needs a percentage from 1 to 100");
      await lib.setDeployPercentage(token, cfg, pct);
      log(`rollout of the published revision set to ${pct}%`);
    }
    await showStatus(token, cfg);
    return;
  }

  const version = releaseVersion();
  let zip;
  if (args.zip) {
    zip = path.resolve(String(args.zip));
    if (!fs.existsSync(zip)) throw new Error(`no such file: ${zip}`);
    log(`using existing package ${path.basename(zip)}`);
  } else {
    runTests();
    zip = buildZip(version);
  }

  if (args["dry-run"]) {
    const missing = lib.KEYS.filter((k) => !cfg[k]);
    const target = cfg.CWS_PUBLISHER_ID ? lib.itemName(cfg) : `item ${cfg.CWS_ITEM_ID}`;
    log(`dry run: would upload ${path.basename(zip)} as ${version} to ${target}`);
    if (missing.length) log(`not configured yet: ${missing.join(", ")} — run: npm run release:chrome:auth`);
    return;
  }

  const token = await lib.accessToken(cfg);
  const before = await showStatus(token, cfg);
  const pubCh = ((before.publishedItemRevisionStatus || {}).distributionChannels || [])[0] || {};
  if (pubCh.crxVersion && pubCh.crxVersion === version) {
    throw new Error(`${version} is already the published version — bump the version first`);
  }
  if (before.submittedItemRevisionStatus && before.submittedItemRevisionStatus.state) {
    log(`note: a submission is already pending (${before.submittedItemRevisionStatus.state}); the upload will replace it`);
  }

  log(`uploading ${path.basename(zip)}`);
  const up = await lib.upload(token, cfg, fs.readFileSync(zip));
  log(`upload accepted${up.crxVersion ? ` as ${up.crxVersion}` : ""}; state ${up.uploadState || "pending"}`);
  const finalState = await waitForUpload(token, cfg);
  log(`store finished processing the package: ${finalState}`);

  if (args["upload-only"]) {
    log("upload only — not submitted. Submit later with: npm run release:chrome -- --zip <file>");
    return;
  }

  const percent = args.percent !== undefined ? Number(args.percent) : undefined;
  if (percent !== undefined && !(percent > 0 && percent <= 100)) {
    throw new Error("--percent needs a percentage from 1 to 100");
  }
  const res = await lib.publish(token, cfg, percent);
  log(`submitted ${version} for review${percent && percent < 100 ? ` at ${percent}% rollout` : ""}: ${res.state || JSON.stringify(res)}`);
  if (res.warningInfo && Object.keys(res.warningInfo).length) {
    log(`store warnings: ${JSON.stringify(res.warningInfo)}`);
  }
  await showStatus(token, cfg);
})().catch((err) => {
  console.error(`publish-chrome: ${err.message}`);
  process.exit(1);
});
