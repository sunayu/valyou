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
const fs = require("fs");
const path = require("path");

const film = fs.readFileSync(path.join(__dirname, "film-portrait.js"), "utf8");
const audio = fs.readFileSync(path.join(__dirname, "promo-audio-web.m4a"));
const audioURI = "data:audio/mp4;base64," + audio.toString("base64");

const html = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>valyou — the film (vertical)</title>
<meta name="description" content="A 36-second vertical promo film for valyou, sized for phones (Stories / Reels / Shorts)." />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #05060a; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  .stage { position: fixed; inset: 0; display: grid; place-items: center; background:
    radial-gradient(80% 60% at 50% 0%, #0d1018, #05060a); }
  .frame { position: relative; height: min(94vh, calc(94vw * 16 / 9)); aspect-ratio: 9 / 16;
    box-shadow: 0 40px 120px -40px rgba(0,0,0,0.9); border-radius: 22px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.06); }
  canvas { width: 100%; height: 100%; display: block; background: #000; }
  .cover { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 18px;
    background: radial-gradient(60% 60% at 50% 45%, rgba(12,15,22,0.5), rgba(5,6,10,0.86)); backdrop-filter: blur(2px);
    transition: opacity 0.6s ease; cursor: pointer; padding: 24px; text-align: center; }
  .cover.hidden { opacity: 0; pointer-events: none; }
  .play { width: 88px; height: 88px; border-radius: 999px; display: grid; place-items: center;
    background: linear-gradient(135deg, #4f7cff, #8b6cff); box-shadow: 0 20px 50px -12px rgba(79,124,255,0.6); }
  .play::after { content: ""; border-left: 24px solid #fff; border-top: 15px solid transparent;
    border-bottom: 15px solid transparent; margin-left: 7px; }
  .brand { display: flex; align-items: center; gap: 11px; }
  .brand svg { width: 30px; height: 30px; }
  .brand b { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; color: #eef1f7; }
  .hint { font-size: 14px; color: #9aa3b4; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase; color: #6b7486; }
  .replay { position: absolute; right: 14px; bottom: 14px; display: none; align-items: center; gap: 8px;
    font-size: 13px; color: #9aa3b4; background: rgba(20,24,32,0.6); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 999px; padding: 8px 14px; cursor: pointer; backdrop-filter: blur(8px); }
  .replay.show { display: inline-flex; }
</style>

<div class="stage">
  <div class="frame">
    <canvas id="c" width="1080" height="1920"></canvas>
    <div class="cover" id="cover">
      <div class="brand">
        <svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="vg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><path d="M18 24 Q18 14 28 14 H72 Q82 14 82 24 V50 Q82 75 50 90 Q18 75 18 50 Z" fill="url(#vg)"/><path d="M35 37 L50 61 L65 37" fill="none" stroke="#fff" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <b>valyou</b>
      </div>
      <div class="play" aria-label="Play the film"></div>
      <div class="hint">Vertical film for phones — 36s, with sound</div>
      <div class="mono">Original licensed soundtrack</div>
    </div>
    <div class="replay" id="replay">↻ Replay</div>
  </div>
</div>

<audio id="au" preload="auto" src="${audioURI}"></audio>

<script>
${film}
</script>
<script>
  (function () {
    var cv = document.getElementById("c");
    var ctx = cv.getContext("2d", { alpha: false });
    var FILM = window.VALYOU_FILM;
    var au = document.getElementById("au");
    var cover = document.getElementById("cover");
    var replay = document.getElementById("replay");
    var playing = false;
    function draw(t) { ctx.clearRect(0, 0, FILM.W, FILM.H); FILM.frame(ctx, t); }
    draw(34.6);
    function loop() {
      if (!playing) return;
      var t = au.currentTime;
      draw(Math.min(t, FILM.DUR));
      if (au.ended || t >= FILM.DUR) { stop(); return; }
      requestAnimationFrame(loop);
    }
    function start() {
      cover.classList.add("hidden"); replay.classList.remove("show");
      au.currentTime = 0; playing = true;
      var p = au.play(); if (p && p.catch) p.catch(function () {});
      requestAnimationFrame(loop);
    }
    function stop() { playing = false; try { au.pause(); } catch (e) {} replay.classList.add("show"); draw(FILM.DUR); }
    cover.addEventListener("click", start);
    replay.addEventListener("click", start);
    au.addEventListener("ended", stop);
  })();
</script>
`;

fs.writeFileSync(path.join(__dirname, "valyou-promo-portrait.html"), html);
console.log("wrote valyou-promo-portrait.html (" + (Buffer.byteLength(html) / 1024).toFixed(0) + " KB)");
