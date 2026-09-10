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
 * One-time Chrome Web Store authorisation.
 *
 * Mints the long-lived refresh token that scripts/publish-chrome.js uses, via
 * the OAuth "desktop app" loopback flow: this script listens on 127.0.0.1,
 * opens Google's consent page, receives the authorisation code on the
 * redirect, exchanges it for tokens and writes everything to .cws.env.
 *
 * Before running it you need, once, in the Google Cloud console:
 *   1. A project with the "Chrome Web Store API" enabled.
 *   2. An OAuth consent screen (External is fine) with your Google account
 *      added as a test user.
 *   3. Credentials -> OAuth client ID -> application type "Desktop app".
 *      That gives the client ID and secret this script asks for.
 * And from the Chrome Web Store developer dashboard, under Account, your
 * Publisher ID.
 *
 * Usage:
 *   npm run release:chrome:auth
 * or, non-interactively:
 *   CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_PUBLISHER_ID=... node scripts/cws-auth.js
 */
"use strict";

const http = require("http");
const readline = require("readline");
const { execFile } = require("child_process");
const lib = require("./cws-lib");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Ask on the terminal unless the value is already known.
 *
 * @param {readline.Interface} rl
 * @param {string} label
 * @param {string|undefined} existing
 * @returns {Promise<string>}
 */
function ask(rl, label, existing) {
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => rl.question(`${label}: `, (a) => resolve(a.trim())));
}

/** Open a URL in the default browser; falls back to printing it. */
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], (err) => {
    if (err) console.log(`Open this URL in your browser:\n\n${url}\n`);
  });
}

/**
 * Listen once on a loopback port for Google's redirect carrying ?code=.
 *
 * @returns {Promise<{port: number, code: Promise<string>}>}
 */
function awaitRedirect() {
  return new Promise((resolve, reject) => {
    let settle;
    const code = new Promise((res, rej) => { settle = { res, rej }; });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (c) {
        res.end("<p style='font-family:system-ui'>valyou: authorised. You can close this tab.</p>");
        settle.res(c);
      } else {
        res.end(`<p style='font-family:system-ui'>valyou: authorisation failed (${err || "no code"}).</p>`);
        settle.rej(new Error(err || "no authorisation code in redirect"));
      }
      server.close();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, code }));
  });
}

(async () => {
  const cfg = lib.loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  cfg.CWS_CLIENT_ID = await ask(rl, "OAuth client ID", cfg.CWS_CLIENT_ID);
  cfg.CWS_CLIENT_SECRET = await ask(rl, "OAuth client secret", cfg.CWS_CLIENT_SECRET);
  cfg.CWS_PUBLISHER_ID = await ask(rl, "Publisher ID (developer dashboard -> Account)", cfg.CWS_PUBLISHER_ID);
  rl.close();
  for (const k of ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_PUBLISHER_ID"]) {
    if (!cfg[k]) throw new Error(`${k} is required`);
  }

  const { port, code } = await awaitRedirect();
  const redirectUri = `http://127.0.0.1:${port}`;
  const consent = new URL(AUTH_URL);
  consent.search = new URLSearchParams({
    client_id: cfg.CWS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: lib.SCOPE,
    access_type: "offline", // this is what yields a refresh token
    prompt: "consent", // and this makes Google issue one even on re-auth
  }).toString();
  console.log("Waiting for you to approve access in the browser...");
  openBrowser(consent.toString());

  const authCode = await code;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      code: authCode,
      client_id: cfg.CWS_CLIENT_ID,
      client_secret: cfg.CWS_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(json)}`);
  }
  cfg.CWS_REFRESH_TOKEN = json.refresh_token;
  const file = lib.saveConfig(cfg);
  console.log(`Saved credentials to ${file} (owner-only, git-ignored).`);

  // Prove the token works end to end before declaring victory.
  const token = await lib.accessToken(cfg);
  const status = await lib.fetchStatus(token, cfg);
  const pub = status.publishedItemRevisionStatus || {};
  const ch = (pub.distributionChannels || [])[0] || {};
  console.log(`Store says: item ${status.itemId}, published ${ch.crxVersion || "?"} (${pub.state || "unknown"}).`);
  console.log("You can now publish with: npm run release:chrome");
})().catch((err) => {
  console.error(`cws-auth: ${err.message}`);
  process.exit(1);
});
