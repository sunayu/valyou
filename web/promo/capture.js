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
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 30;
const DUR = 36;
const TOTAL = Math.round(FPS * DUR);

// Optional args let this render either orientation:
//   node capture.js                                  -> landscape 1920x1080 (default)
//   node capture.js film-portrait.html frames-portrait 1080 1920
const HARNESS = process.argv[2] || "film.html";
const OUTDIR = process.argv[3] || "frames";
const WIDTH = Number(process.argv[4]) || 1920;
const HEIGHT = Number(process.argv[5]) || 1080;
const DIR = path.join(__dirname, OUTDIR);
const FILM = "file://" + path.join(__dirname, HARNESS) + "?capture=1";

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  // clear any stale frames
  for (const f of fs.readdirSync(DIR)) if (f.endsWith(".png")) fs.unlinkSync(path.join(DIR, f));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.goto(FILM, { waitUntil: "load" });
  await page.waitForFunction("window.VALYOU_FILM && window.__frame");

  const t0 = Date.now();
  for (let i = 0; i < TOTAL; i++) {
    const t = i / FPS;
    await page.evaluate((tt) => window.__frame(tt), t);
    const name = "frame-" + String(i + 1).padStart(5, "0") + ".png";
    await page.screenshot({
      path: path.join(DIR, name),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      optimizeForSpeed: true,
    });
    if ((i + 1) % 60 === 0 || i === TOTAL - 1) {
      const pct = (((i + 1) / TOTAL) * 100).toFixed(0);
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`  ${i + 1}/${TOTAL} frames (${pct}%)  ${el}s\n`);
    }
  }
  await browser.close();
  console.log("done: " + TOTAL + " frames in " + DIR);
})().catch((e) => { console.error(e); process.exit(1); });
