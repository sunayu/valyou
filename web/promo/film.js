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
(function (global) {
  "use strict";

  var W = 1920, H = 1080;
  var DUR = 36;

  // ---- palette ----
  var C = {
    ground: "#0a0c11", ground2: "#0c0f16",
    surface: "#12151d", surface2: "#171b25",
    ink: "#eef1f7", soft: "#9aa3b4", faint: "#6b7486",
    accent: "#6b8cff", accent2: "#a082ff", safe: "#56e0b0", flag: "#ff8095",
    line: "rgba(255,255,255,0.10)", lineS: "rgba(255,255,255,0.17)"
  };

  // ---- easing / helpers ----
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(t, a, b) { if (t <= a) return 0; if (t >= b) return 1; var u = (t - a) / (b - a); return u * u * (3 - 2 * u); }
  function easeOut(u) { u = clamp(u, 0, 1); return 1 - Math.pow(1 - u, 3); }
  function easeInOut(u) { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function alphaOf(t, s, e, fi, fo) { fi = fi || 0.5; fo = fo || 0.5; return smooth(t, s, s + fi) * (1 - smooth(t, e - fo, e)); }
  // seeded deterministic pseudo-random
  function rnd(seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // gradient helper (the brand scanner gradient)
  function brandGrad(ctx, x0, y0, x1, y1) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "#4f7cff"); g.addColorStop(1, "#8b6cff"); return g;
  }
  function withAlpha(hex, a) {
    // hex #rrggbb -> rgba
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var SERIF = 'Georgia, "New York", "Times New Roman", serif';
  var SANS = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
  var MONO = '"SF Mono", Menlo, "Consolas", monospace';

  function text(ctx, str, x, y, font, color, align, ls, alpha) {
    ctx.save();
    ctx.globalAlpha *= (alpha == null ? 1 : alpha);
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    if (ls != null && "letterSpacing" in ctx) ctx.letterSpacing = ls + "px";
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  // ---- the shield mark ----
  function shield(ctx, cx, cy, s, opts) {
    opts = opts || {};
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s / 100, s / 100);
    ctx.translate(-50, -52);
    // body path (matches the SVG on the site)
    ctx.beginPath();
    ctx.moveTo(18, 24);
    ctx.quadraticCurveTo(18, 14, 28, 14);
    ctx.lineTo(72, 14);
    ctx.quadraticCurveTo(82, 14, 82, 24);
    ctx.lineTo(82, 50);
    ctx.quadraticCurveTo(82, 75, 50, 90);
    ctx.quadraticCurveTo(18, 75, 18, 50);
    ctx.closePath();
    if (opts.fill !== false) {
      var g = brandGrad(ctx, 18, 14, 82, 90);
      ctx.fillStyle = g; ctx.globalAlpha *= (opts.alpha == null ? 1 : opts.alpha); ctx.fill();
      ctx.globalAlpha /= (opts.alpha == null ? 1 : opts.alpha);
    }
    if (opts.stroke) { ctx.lineWidth = opts.strokeW || 2.5; ctx.strokeStyle = opts.stroke; ctx.stroke(); }
    // the "v" / check
    var vp = opts.vProgress == null ? 1 : opts.vProgress; // 0..1 draw-on
    if (vp > 0) {
      ctx.lineWidth = 9.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#fff";
      ctx.globalAlpha *= (opts.vAlpha == null ? 1 : opts.vAlpha);
      // full path length approx; draw two segments proportionally
      ctx.beginPath();
      ctx.moveTo(35, 37);
      // segment 1 to (50,61), segment 2 to (65,37)
      var p1 = 0.5, p2 = 0.5, u = vp;
      if (u <= p1) { var uu = u / p1; ctx.lineTo(lerp(35, 50, uu), lerp(37, 61, uu)); }
      else { ctx.lineTo(50, 61); var uu2 = (u - p1) / p2; ctx.lineTo(lerp(50, 65, uu2), lerp(61, 37, uu2)); }
      ctx.stroke();
    }
    ctx.restore();
  }

  // =========================================================
  //  Background — continuous, evolving, drawn every frame
  // =========================================================
  function background(ctx, t) {
    // base
    ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
    // two slow radial glows that drift
    var gx = 1350 + Math.sin(t * 0.12) * 120, gy = 120 + Math.cos(t * 0.1) * 60;
    var glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 1000);
    var warm = 0.20 + 0.10 * smooth(t, 7, 12);
    glow.addColorStop(0, withAlpha(C.accent, warm));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    var g2 = ctx.createRadialGradient(200, 950, 0, 200, 950, 900);
    g2.addColorStop(0, withAlpha(C.accent2, 0.14));
    g2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
  }

  // grain + vignette + letterbox — cinematic overlays, always on top
  function overlays(ctx, t) {
    // vignette
    var v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    // fine grain (deterministic per frame index)
    ctx.save();
    ctx.globalAlpha = 0.035;
    var fi = Math.floor(t * 30);
    for (var i = 0; i < 1400; i++) {
      var x = rnd(i * 1.7 + fi * 0.013) * W;
      var y = rnd(i * 3.1 + fi * 0.019) * H;
      var sh = rnd(i + fi) > 0.5 ? "#fff" : "#000";
      ctx.fillStyle = sh; ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.restore();
    // letterbox bars
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, 54); ctx.fillRect(0, H - 54, W, 54);
    // global fade to black at very start/end
    var k = (1 - smooth(t, 0, 0.6)) + smooth(t, 35.4, 36);
    if (k > 0) { ctx.fillStyle = "rgba(0,0,0," + clamp(k, 0, 1) + ")"; ctx.fillRect(0, 0, W, H); }
  }

  // a moving scan line (transition + motif) — used across scenes
  function scanLine(ctx, x, alpha, wide) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    var w = wide || 220;
    var g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, "rgba(107,140,255,0)");
    g.addColorStop(0.5, withAlpha(C.accent, 0.85));
    g.addColorStop(1, "rgba(160,130,255,0)");
    ctx.fillStyle = g; ctx.fillRect(x - w, 0, w * 2, H);
    ctx.fillStyle = withAlpha("#c7d2ff", 0.9); ctx.fillRect(x - 1.5, 0, 3, H);
    ctx.restore();
  }

  // =========================================================
  //  Noise particles (the hostile feed) — scenes 1–3
  // =========================================================
  var FRAGS = ["RAGE", "HATE", "LIES", "FEAR", "ANGRY", "OUTRAGE", "!!!", "SHAME", "BAIT", "NOISE", "FURY", "SCREAM"];
  function noiseField(ctx, t) {
    var dissolve = smooth(t, 7.0, 9.8);         // pushed away as the shield forms
    var appear = smooth(t, 0.3, 2.2);
    var rage = smooth(t, 3.2, 6.5);             // reddens / intensifies
    var master = appear * (1 - dissolve);
    if (master <= 0.001) return;
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var i = 0; i < 46; i++) {
      var bx = rnd(i * 2.3) * W;
      var by = 120 + rnd(i * 5.7) * (H - 240);
      var vx = (rnd(i * 1.1) - 0.5) * 26;
      var vy = (rnd(i * 9.2) - 0.5) * 18;
      var push = dissolve * (rnd(i * 4.4) - 0.5) * 900;
      var x = bx + vx * t + push;
      var y = by + vy * t + push * 0.4;
      x = ((x % W) + W) % W; y = clamp(y, 60, H - 60);
      var sz = 16 + rnd(i * 7.7) * 30;
      var a = master * (0.10 + 0.30 * rnd(i * 3.3)) * (1 - 0.3 * dissolve);
      var col = i % 3 === 0 ? withAlpha(C.flag, a * (0.5 + rage)) : withAlpha("#8f9bb3", a);
      ctx.font = "600 " + sz + "px " + SANS;
      ctx.fillStyle = col;
      ctx.fillText(FRAGS[i % FRAGS.length], x, y);
    }
    ctx.restore();
  }

  // =========================================================
  //  Feed card (used in the product-hero scene)
  // =========================================================
  function feedCard(ctx, x, y, w, card, local) {
    // local: seconds since this card entered; card has {who, when, text, flagged, cat, filterAt}
    var h = 132;
    var caught = card.flagged ? smooth(local, card.filterAt + 0.55, card.filterAt + 0.95) : 0;
    var collapsed = card.flagged ? smooth(local, card.filterAt + 0.95, card.filterAt + 1.35) : 0;
    var ch = lerp(h, 58, collapsed);
    ctx.save();
    // card bg
    roundRect(ctx, x, y, w, ch, 18);
    ctx.fillStyle = C.surface2; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.stroke();

    if (collapsed < 0.99) {
      ctx.save();
      roundRect(ctx, x, y, w, ch, 18); ctx.clip();
      ctx.globalAlpha = 1 - collapsed;
      if (caught > 0) ctx.filter = "blur(" + (caught * 10).toFixed(1) + "px)";
      // avatar
      var av = ctx.createLinearGradient(x + 26, y + 26, x + 62, y + 62);
      av.addColorStop(0, "#4f7cff"); av.addColorStop(1, "#8b6cff");
      ctx.fillStyle = av; ctx.beginPath(); ctx.arc(x + 44, y + 42, 18, 0, 7); ctx.fill();
      ctx.filter = "none";
      if (caught > 0) ctx.filter = "blur(" + (caught * 10).toFixed(1) + "px)";
      text(ctx, card.who, x + 74, y + 40, "600 22px " + SANS, C.ink, "left");
      text(ctx, card.when, x + 74 + ctx.measureText(card.who).width + 14, y + 40, "18px " + SANS, C.faint, "left");
      text(ctx, card.text, x + 28, y + 84, "22px " + SANS, C.soft, "left");
      if (!card.flagged) {
        text(ctx, "✓ KEPT", x + 28, y + 116, "600 13px " + MONO, C.safe, "left", 1.5);
      }
      ctx.filter = "none";
      ctx.restore();
    }
    // scan sweep as it's caught
    if (card.flagged) {
      var sc = smooth(local, card.filterAt, card.filterAt + 0.55);
      if (sc > 0 && sc < 1) {
        ctx.save(); roundRect(ctx, x, y, w, ch, 18); ctx.clip();
        var sx = x + sc * w;
        var g = ctx.createLinearGradient(sx - 120, 0, sx + 120, 0);
        g.addColorStop(0, "rgba(107,140,255,0)"); g.addColorStop(0.5, withAlpha(C.accent, 0.8)); g.addColorStop(1, "rgba(160,130,255,0)");
        ctx.fillStyle = g; ctx.fillRect(x, y, w, ch);
        ctx.restore();
      }
    }
    // collapsed veil label
    if (collapsed > 0.02) {
      ctx.save(); ctx.globalAlpha = collapsed;
      shield(ctx, x + 34, y + 29, 26);
      text(ctx, "Hidden by valyou", x + 58, y + 36, "20px " + SANS, C.soft, "left");
      var lw = ctx.measureText("Hidden by valyou").width;
      text(ctx, card.cat.toUpperCase(), x + 58 + lw + 20, y + 35, "600 13px " + MONO, C.flag, "left", 1);
      // show pill
      roundRect(ctx, x + w - 92, y + 17, 74, 30, 15); ctx.strokeStyle = C.lineS; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, "Show", x + w - 55, y + 37, "600 15px " + SANS, C.accent, "center");
      ctx.restore();
    }
    ctx.restore();
    return ch;
  }

  // =========================================================
  //  SCENES
  // =========================================================
  function sceneOpen(ctx, t) {
    // 0–6.8 : cold open, tension text over noise
    var a1 = alphaOf(t, 0.8, 3.4, 1.0, 0.5);
    var a2 = alphaOf(t, 3.4, 7.0, 0.6, 0.6);
    if (a1 > 0) {
      text(ctx, "The feed was never built for you.", W / 2, H / 2 + 10, "italic 600 74px " + SERIF, C.ink, "center", 0, a1);
    }
    if (a2 > 0) {
      ctx.save();
      // "angry" in flag color, rest in ink — measured + laid out so it centers
      var full = "It was built to keep you angry.";
      ctx.font = "italic 600 74px " + SERIF; ctx.textAlign = "left";
      var pre = "It was built to keep you ";
      var wpre = ctx.measureText(pre).width, wfull = ctx.measureText(full).width;
      var startX = W / 2 - wfull / 2;
      ctx.globalAlpha = a2;
      ctx.fillStyle = C.ink; ctx.fillText(pre, startX, H / 2 + 10);
      ctx.fillStyle = C.flag; ctx.fillText("angry.", startX + wpre, H / 2 + 10);
      ctx.restore();
    }
  }

  function sceneReveal(ctx, t) {
    // 6.8–11 : shield forms, scan sweep dissolves noise, wordmark resolves
    var s0 = 6.8;
    var scanX = lerp(-260, W + 260, easeInOut(smooth(t, 6.8, 8.2)));
    scanLine(ctx, scanX, (smooth(t, 6.8, 7.0) * (1 - smooth(t, 8.0, 8.3))), 260);

    var appear = smooth(t, 7.6, 9.2) * (1 - smooth(t, 10.8, 11.6)); // fade out into the product scene
    if (appear > 0) {
      var scale = lerp(0.82, 1, easeOut(smooth(t, 7.6, 9.2)));
      var yc = H / 2 - 40;
      // impact bloom at ~8s
      var bloom = Math.max(0, 1 - Math.abs(t - 8.05) / 0.5);
      if (bloom > 0) {
        var bg = ctx.createRadialGradient(W / 2, yc, 0, W / 2, yc, 420 * bloom + 120);
        bg.addColorStop(0, withAlpha("#9fb4ff", 0.5 * bloom)); bg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      }
      ctx.save();
      ctx.globalAlpha = appear;
      var vProg = easeOut(smooth(t, 8.3, 9.4));
      shield(ctx, W / 2, yc, 190 * scale, { vProgress: vProg });
      ctx.restore();
    }
    // wordmark + tagline resolve
    var wa = alphaOf(t, 9.4, 11.4, 0.7, 0.7);
    if (wa > 0) {
      text(ctx, "valyou", W / 2, H / 2 + 150, "650 92px " + SANS, C.ink, "center", -1, wa);
    }
  }

  var CARDS = [
    { who: "Maya R.", when: "· 2m", text: "made the best carbonara of my life tonight", flagged: false },
    { who: "@ragefarm", when: "· now", text: "you won't believe what they did this time", flagged: true, cat: "Rage bait", filterAt: 1.1 },
    { who: "Trailhead", when: "· 9m", text: "golden hour from the ridge — worth the climb", flagged: false },
    { who: "unknown", when: "· 1m", text: "█████ ██████ ████", flagged: true, cat: "Harassment", filterAt: 2.0 },
    { who: "Dev Chen", when: "· 14m", text: "shipped the thing. small win, I'll take it", flagged: false }
  ];
  function sceneProduct(ctx, t) {
    // 11–18 : the feed, filtering itself
    var a = alphaOf(t, 11.2, 18.2, 0.7, 0.7);
    if (a <= 0) return;
    var local = t - 11.2;
    ctx.save(); ctx.globalAlpha = a;
    // device panel
    var pw = 720, px = W / 2 - pw / 2, py = 150;
    var drift = -easeInOut(smooth(local, 0, 6.5)) * 60;
    // header
    text(ctx, "YOUR FEED", px + 8, py - 18, "600 15px " + MONO, C.faint, "left", 4);
    text(ctx, "valyou on", px + pw - 8, py - 18, "600 15px " + MONO, C.accent, "right", 2);
    // cards
    var y = py + drift;
    for (var i = 0; i < CARDS.length; i++) {
      var entered = i * 0.5;
      var cardLocal = local - entered;
      if (cardLocal < 0) continue;
      var slide = (1 - easeOut(smooth(cardLocal, 0, 0.5))) * 40;
      var ca = smooth(cardLocal, 0, 0.4);
      ctx.save(); ctx.globalAlpha = a * ca;
      var ch = feedCard(ctx, px, y + slide, pw, CARDS[i], cardLocal);
      ctx.restore();
      y += ch + 16;
    }
    ctx.restore();
    // lower-third tagline
    var ta = alphaOf(t, 12.6, 18.0, 0.7, 0.8);
    if (ta > 0) {
      text(ctx, "Filter the feed. Automatically.", W / 2, H - 110, "italic 600 56px " + SERIF, C.ink, "center", 0, ta);
    }
  }

  var CHIPS = [
    { label: "Racial hate", act: "HIDDEN", col: "#6b8cff" },
    { label: "Gendered hate", act: "HIDDEN", col: "#6b8cff" },
    { label: "Violence & threats", act: "HIDDEN", col: "#6b8cff" },
    { label: "Harassment", act: "BLURRED", col: "#a082ff" },
    { label: "Rage bait", act: "BLURRED", col: "#a082ff" }
  ];
  function sceneFeatures(ctx, t) {
    // 18–24 : category chips stamp in, headline
    var a = alphaOf(t, 18.2, 24.2, 0.6, 0.7);
    if (a <= 0) return;
    var local = t - 18.2;
    ctx.save(); ctx.globalAlpha = a;
    text(ctx, "FIVE THINGS YOU DIDN'T ASK TO SEE", W / 2, 300, "600 20px " + MONO, C.accent, "center", 4);
    // stacked chips center
    var cy = 420;
    for (var i = 0; i < CHIPS.length; i++) {
      var st = 0.4 + i * 0.45;
      var ca = easeOut(smooth(local, st, st + 0.4));
      if (ca <= 0) continue;
      var pop = lerp(0.9, 1, ca);
      var yy = cy + i * 88;
      ctx.save();
      ctx.globalAlpha = a * ca;
      ctx.translate(W / 2, yy); ctx.scale(pop, pop); ctx.translate(-W / 2, -yy);
      var cw = 560, cx = W / 2 - cw / 2;
      roundRect(ctx, cx, yy - 34, cw, 64, 32); ctx.fillStyle = C.surface; ctx.fill();
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, CHIPS[i].label, cx + 34, yy + 8, "600 27px " + SANS, C.ink, "left");
      // action tag
      var tag = CHIPS[i].act;
      ctx.font = "600 15px " + MONO;
      var tw = ctx.measureText(tag).width + 28;
      roundRect(ctx, cx + cw - tw - 20, yy - 15, tw, 30, 15);
      ctx.fillStyle = withAlpha(CHIPS[i].col, 0.16); ctx.fill();
      text(ctx, tag, cx + cw - tw / 2 - 20, yy + 6, "600 15px " + MONO, CHIPS[i].col, "center", 1);
      ctx.restore();
    }
    // headline
    var ha = alphaOf(t, 20.0, 24.0, 0.8, 0.8);
    if (ha > 0) text(ctx, "Hide, blur, or tag — your call.", W / 2, 960, "italic 600 52px " + SERIF, C.ink, "center", 0, ha);
    ctx.restore();
  }

  function scenePrivacy(ctx, t) {
    // 24–29 : privacy peak
    var a = alphaOf(t, 24.4, 29.2, 0.7, 0.7);
    if (a <= 0) return;
    // impact flash at 25
    var bloom = Math.max(0, 1 - Math.abs(t - 25.0) / 0.6);
    if (bloom > 0) {
      var bg = ctx.createRadialGradient(W / 2, 470, 0, W / 2, 470, 500 * bloom + 100);
      bg.addColorStop(0, withAlpha("#9fb4ff", 0.4 * bloom)); bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    }
    ctx.save(); ctx.globalAlpha = a;
    shield(ctx, W / 2, 400, 150);
    text(ctx, "PRIVATE BY DESIGN", W / 2, 560, "600 20px " + MONO, C.accent, "center", 4);
    // two-line serif
    text(ctx, "Nothing you browse", W / 2, 660, "600 68px " + SERIF, C.ink, "center");
    // gradient second line
    ctx.save();
    ctx.font = "italic 600 68px " + SERIF; ctx.textAlign = "center";
    ctx.fillStyle = brandGrad(ctx, W / 2 - 400, 0, W / 2 + 400, 0);
    ctx.globalAlpha = a;
    ctx.fillText("ever leaves your device.", W / 2, 740);
    ctx.restore();
    // spec line
    var specA = alphaOf(t, 25.4, 29.0, 0.6, 0.7);
    if (specA > 0) {
      var specs = ["On-device", "AES-256", "Zero network", "No tracking"];
      ctx.save(); ctx.globalAlpha = a * specA;
      ctx.font = "600 22px " + MONO; ctx.textAlign = "left";
      var gap = 60, parts = specs.map(function (s) { return ctx.measureText(s).width; });
      var totalW = parts.reduce(function (p, c) { return p + c; }, 0) + gap * (specs.length - 1);
      var sx = W / 2 - totalW / 2;
      for (var i = 0; i < specs.length; i++) {
        ctx.fillStyle = C.safe; ctx.beginPath(); ctx.arc(sx - 18, 862, 4, 0, 7); ctx.fill();
        ctx.fillStyle = C.soft; if ("letterSpacing" in ctx) ctx.letterSpacing = "1px";
        ctx.fillText(specs[i], sx, 870);
        sx += parts[i] + gap;
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function scenePlatforms(ctx, t) {
    // 29–33 : platforms
    var a = alphaOf(t, 29.2, 33.2, 0.6, 0.6);
    if (a <= 0) return;
    var local = t - 29.2;
    ctx.save(); ctx.globalAlpha = a;
    text(ctx, "ONE FILTER. EVERY SCREEN.", W / 2, 340, "600 20px " + MONO, C.accent, "center", 4);
    var names = ["Chrome", "iOS", "Android"];
    var xs = [W / 2 - 460, W / 2, W / 2 + 460];
    for (var i = 0; i < 3; i++) {
      var st = 0.3 + i * 0.35;
      var ca = easeOut(smooth(local, st, st + 0.5));
      if (ca <= 0) continue;
      ctx.save(); ctx.globalAlpha = a * ca;
      var yy = 560, lift = (1 - ca) * 30;
      // tile
      roundRect(ctx, xs[i] - 150, yy - 150 + lift, 300, 300, 32);
      ctx.fillStyle = C.surface; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      shield(ctx, xs[i], yy - 20 + lift, 118);
      text(ctx, names[i], xs[i], yy + 100 + lift, "600 34px " + SANS, C.ink, "center", -0.5);
      ctx.restore();
    }
    ctx.restore();
  }

  function sceneLogo(ctx, t) {
    // 33–36 : logo sting
    var a = alphaOf(t, 33.2, 36.0, 0.7, 0.9);
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a;
    var pop = easeOut(smooth(t, 33.2, 34.0));
    shield(ctx, W / 2, H / 2 - 70, lerp(150, 168, pop));
    text(ctx, "valyou", W / 2, H / 2 + 110, "650 104px " + SANS, C.ink, "center", -1);
    var ta = alphaOf(t, 34.0, 36.0, 0.6, 0.9);
    if (ta > 0) text(ctx, "Calm your social feed.", W / 2, H / 2 + 190, "italic 500 40px " + SERIF, C.soft, "center", 0, ta);
    ctx.restore();
  }

  // =========================================================
  //  Master frame
  // =========================================================
  function frame(ctx, t) {
    t = clamp(t, 0, DUR);
    background(ctx, t);
    noiseField(ctx, t);
    sceneOpen(ctx, t);
    sceneReveal(ctx, t);
    sceneProduct(ctx, t);
    sceneFeatures(ctx, t);
    scenePrivacy(ctx, t);
    scenePlatforms(ctx, t);
    sceneLogo(ctx, t);
    overlays(ctx, t);
  }

  global.VALYOU_FILM = { W: W, H: H, DUR: DUR, frame: frame };
})(typeof window !== "undefined" ? window : globalThis);
