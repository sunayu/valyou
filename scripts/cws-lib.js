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
 * Shared plumbing for the Chrome Web Store scripts: the .cws.env credentials
 * file, OAuth token refresh, and thin wrappers over the v2 REST API.
 *
 * Nothing here is imported by the extension; it runs only on a developer's
 * machine. Zero dependencies — Node 20's built-in fetch is enough.
 *
 * API reference: https://developer.chrome.com/docs/webstore/api/reference/rest
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
/** Credentials live here, git-ignored. Environment variables override it. */
const ENV_FILE = path.join(ROOT, ".cws.env");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
/** The valyou item in the store (chromewebstore.google.com/detail/valyou/<id>). */
const DEFAULT_ITEM_ID = "jileiaojeklemggbieacomlbbnmhpdgd";

const KEYS = ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_ITEM_ID"];

/**
 * Read .cws.env (KEY=value lines) and let real environment variables win.
 *
 * @returns {Object<string,string>}
 */
function loadConfig() {
  const cfg = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const k of KEYS) if (process.env[k]) cfg[k] = process.env[k];
  if (!cfg.CWS_ITEM_ID) cfg.CWS_ITEM_ID = DEFAULT_ITEM_ID;
  return cfg;
}

/**
 * Write the credentials file with owner-only permissions.
 *
 * @param {Object<string,string>} cfg
 * @returns {string} The file written.
 */
function saveConfig(cfg) {
  const lines = ["# Chrome Web Store publishing credentials — never commit this file."];
  for (const k of KEYS) if (cfg[k]) lines.push(`${k}=${cfg[k]}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  return ENV_FILE;
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * @param {Object<string,string>} cfg
 * @returns {Promise<string>}
 */
async function accessToken(cfg) {
  for (const k of ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"]) {
    if (!cfg[k]) throw new Error(`${k} is missing — run: npm run release:chrome:auth`);
  }
  const body = new URLSearchParams({
    client_id: cfg.CWS_CLIENT_ID,
    client_secret: cfg.CWS_CLIENT_SECRET,
    refresh_token: cfg.CWS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

/**
 * @param {Object<string,string>} cfg
 * @returns {string} "publishers/{publisherId}/items/{itemId}"
 */
function itemName(cfg) {
  if (!cfg.CWS_PUBLISHER_ID) {
    throw new Error("CWS_PUBLISHER_ID is missing — it is shown under Account in the developer dashboard");
  }
  return `publishers/${cfg.CWS_PUBLISHER_ID}/items/${cfg.CWS_ITEM_ID}`;
}

/**
 * One authenticated call; throws with the API's own error text on failure.
 *
 * @param {string} token Access token.
 * @param {string} method HTTP method.
 * @param {string} url Full URL.
 * @param {{body?: any, contentType?: string}} [opts]
 * @returns {Promise<any>} Parsed JSON response.
 */
async function call(token, method, url, opts) {
  const o = opts || {};
  const headers = { Authorization: `Bearer ${token}` };
  if (o.contentType) headers["Content-Type"] = o.contentType;
  const res = await fetch(url, { method, headers, body: o.body });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Upload a zip as the item's new package. */
function upload(token, cfg, zipBuffer) {
  return call(token, "POST", `${API}/upload/v2/${itemName(cfg)}:upload`, {
    body: zipBuffer,
    contentType: "application/zip",
  });
}

/** Current published/submitted revisions and the last async upload state. */
function fetchStatus(token, cfg) {
  return call(token, "GET", `${API}/v2/${itemName(cfg)}:fetchStatus`);
}

/**
 * Submit the uploaded package for review and publication.
 *
 * @param {string} token Access token.
 * @param {Object<string,string>} cfg
 * @param {number} [percent] Staged rollout percentage; omitted = 100%.
 */
function publish(token, cfg, percent) {
  const body = { publishType: "DEFAULT_PUBLISH" };
  if (typeof percent === "number" && percent > 0 && percent < 100) {
    body.deployInfos = [{ deployPercentage: percent }];
  }
  return call(token, "POST", `${API}/v2/${itemName(cfg)}:publish`, {
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}

/** Raise the rollout percentage of the published revision. */
function setDeployPercentage(token, cfg, percent) {
  return call(token, "POST", `${API}/v2/${itemName(cfg)}:setPublishedDeployPercentage`, {
    body: JSON.stringify({ deployPercentage: percent }),
    contentType: "application/json",
  });
}

module.exports = {
  ROOT,
  ENV_FILE,
  SCOPE,
  KEYS,
  DEFAULT_ITEM_ID,
  loadConfig,
  saveConfig,
  accessToken,
  itemName,
  upload,
  fetchStatus,
  publish,
  setDeployPercentage,
};
