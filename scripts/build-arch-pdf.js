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
 * Render docs/architecture/how-valyou-works.html to PDF.
 *
 * Uses the Chrome already installed on the machine (via puppeteer-core, the
 * same dependency the promo films use) so nothing extra is downloaded. The
 * light theme is forced regardless of the machine's appearance setting —
 * otherwise a developer on dark mode would produce a dark, ink-hungry PDF.
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "architecture", "how-valyou-works.html");
const OUT = path.join(ROOT, "docs", "architecture", "how-valyou-works.pdf");

// Chrome for Testing if present (CI), else the installed Google Chrome.
const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("No Chrome found — set CHROME_PATH to a Chrome/Chromium binary");
}

async function main() {
  const puppeteer = require(path.join(ROOT, "web", "promo", "node_modules", "puppeteer-core"));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: "new",
    args: ["--no-first-run"],
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto("file://" + SRC, { waitUntil: "networkidle0" });
  await page.pdf({
    path: OUT,
    format: "Letter",
    printBackground: true,
    margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="width:100%;font-size:8px;color:#8b94a8;padding:0 14mm;' +
      'font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:space-between">' +
      '<span>valyou — How It Works</span><span class="pageNumber"></span></div>',
  });
  await browser.close();
  console.log("wrote " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB)");
}

main();
