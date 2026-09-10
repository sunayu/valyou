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

  var W = 1080, H = 1920;
  var DUR = 36;
  var CX = W / 2;

  var C = {
    ground: "#0a0c11", ground2: "#0c0f16",
    surface: "#12151d", surface2: "#171b25",
    ink: "#eef1f7", soft: "#9aa3b4", faint: "#6b7486",
    accent: "#6b8cff", accent2: "#a082ff", safe: "#56e0b0", flag: "#ff8095",
    line: "rgba(255,255,255,0.10)", lineS: "rgba(255,255,255,0.17)"
  };

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(t, a, b) { if (t <= a) return 0; if (t >= b) return 1; var u = (t - a) / (b - a); return u * u * (3 - 2 * u); }
  function easeOut(u) { u = clamp(u, 0, 1); return 1 - Math.pow(1 - u, 3); }
  function easeInOut(u) { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function alphaOf(t, s, e, fi, fo) { fi = fi || 0.5; fo = fo || 0.5; return smooth(t, s, s + fi) * (1 - smooth(t, e - fo, e)); }
  function rnd(seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  function brandGrad(ctx, x0, y0, x1, y1) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "#4f7cff"); g.addColorStop(1, "#8b6cff"); return g;
  }
  function withAlpha(hex, a) {
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

  // Word-wrap a string to a max width, returning the lines.
  function wrapLines(ctx, str, font, maxWidth) {
    ctx.save(); ctx.font = font;
    var words = str.split(" "), lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    ctx.restore();
    return lines;
  }
  // Draw centered, wrapped, multi-line text centred vertically on cy.
  function centerWrap(ctx, str, cy, font, color, lineH, alpha, maxW) {
    var lines = wrapLines(ctx, str, font, maxW || (W - 150));
    var startY = cy - ((lines.length - 1) * lineH) / 2;
    for (var i = 0; i < lines.length; i++) {
      text(ctx, lines[i], CX, startY + i * lineH, font, color, "center", 0, alpha);
    }
  }

  function shield(ctx, cx, cy, s, opts) {
    opts = opts || {};
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s / 100, s / 100);
    ctx.translate(-50, -52);
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
    var vp = opts.vProgress == null ? 1 : opts.vProgress;
    if (vp > 0) {
      ctx.lineWidth = 9.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(35, 37);
      var p1 = 0.5, u = vp;
      if (u <= p1) { var uu = u / p1; ctx.lineTo(lerp(35, 50, uu), lerp(37, 61, uu)); }
      else { ctx.lineTo(50, 61); var uu2 = (u - p1) / 0.5; ctx.lineTo(lerp(50, 65, uu2), lerp(61, 37, uu2)); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function background(ctx, t) {
    ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
    var gx = W * 0.72 + Math.sin(t * 0.12) * 80, gy = H * 0.08 + Math.cos(t * 0.1) * 60;
    var glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, W * 1.05);
    var warm = 0.20 + 0.10 * smooth(t, 7, 12);
    glow.addColorStop(0, withAlpha(C.accent, warm));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    var g2 = ctx.createRadialGradient(W * 0.15, H * 0.86, 0, W * 0.15, H * 0.86, W);
    g2.addColorStop(0, withAlpha(C.accent2, 0.14));
    g2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
  }

  function overlays(ctx, t) {
    var v = ctx.createRadialGradient(CX, H / 2, W * 0.55, CX, H / 2, H * 0.7);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = 0.035;
    var fi = Math.floor(t * 30);
    for (var i = 0; i < 1500; i++) {
      var x = rnd(i * 1.7 + fi * 0.013) * W;
      var y = rnd(i * 3.1 + fi * 0.019) * H;
      ctx.fillStyle = rnd(i + fi) > 0.5 ? "#fff" : "#000";
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.restore();
    var k = (1 - smooth(t, 0, 0.6)) + smooth(t, 35.4, 36);
    if (k > 0) { ctx.fillStyle = "rgba(0,0,0," + clamp(k, 0, 1) + ")"; ctx.fillRect(0, 0, W, H); }
  }

  function scanLine(ctx, x, alpha, wide) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    var w = wide || 200;
    var g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, "rgba(107,140,255,0)");
    g.addColorStop(0.5, withAlpha(C.accent, 0.85));
    g.addColorStop(1, "rgba(160,130,255,0)");
    ctx.fillStyle = g; ctx.fillRect(x - w, 0, w * 2, H);
    ctx.fillStyle = withAlpha("#c7d2ff", 0.9); ctx.fillRect(x - 1.5, 0, 3, H);
    ctx.restore();
  }

  var FRAGS = ["RAGE", "HATE", "LIES", "FEAR", "ANGRY", "OUTRAGE", "!!!", "SHAME", "BAIT", "NOISE", "FURY", "SCREAM"];
  function noiseField(ctx, t) {
    var dissolve = smooth(t, 7.0, 9.8);
    var appear = smooth(t, 0.3, 2.2);
    var rage = smooth(t, 3.2, 6.5);
    var master = appear * (1 - dissolve);
    if (master <= 0.001) return;
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var i = 0; i < 54; i++) {
      var bx = rnd(i * 2.3) * W;
      var by = 160 + rnd(i * 5.7) * (H - 320);
      var vx = (rnd(i * 1.1) - 0.5) * 24;
      var vy = (rnd(i * 9.2) - 0.5) * 22;
      var push = dissolve * (rnd(i * 4.4) - 0.5) * 900;
      var x = bx + vx * t + push;
      var y = by + vy * t + push * 0.5;
      x = ((x % W) + W) % W; y = clamp(y, 80, H - 80);
      var sz = 18 + rnd(i * 7.7) * 34;
      var a = master * (0.10 + 0.30 * rnd(i * 3.3)) * (1 - 0.3 * dissolve);
      ctx.font = "600 " + sz + "px " + SANS;
      ctx.fillStyle = i % 3 === 0 ? withAlpha(C.flag, a * (0.5 + rage)) : withAlpha("#8f9bb3", a);
      ctx.fillText(FRAGS[i % FRAGS.length], x, y);
    }
    ctx.restore();
  }

  function feedCard(ctx, x, y, w, card, local) {
    var h = 150;
    var caught = card.flagged ? smooth(local, card.filterAt + 0.55, card.filterAt + 0.95) : 0;
    var collapsed = card.flagged ? smooth(local, card.filterAt + 0.95, card.filterAt + 1.35) : 0;
    var ch = lerp(h, 66, collapsed);
    ctx.save();
    roundRect(ctx, x, y, w, ch, 20);
    ctx.fillStyle = C.surface2; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.stroke();

    if (collapsed < 0.99) {
      ctx.save();
      roundRect(ctx, x, y, w, ch, 20); ctx.clip();
      ctx.globalAlpha = 1 - collapsed;
      if (caught > 0) ctx.filter = "blur(" + (caught * 11).toFixed(1) + "px)";
      var av = ctx.createLinearGradient(x + 28, y + 28, x + 70, y + 70);
      av.addColorStop(0, "#4f7cff"); av.addColorStop(1, "#8b6cff");
      ctx.fillStyle = av; ctx.beginPath(); ctx.arc(x + 50, y + 46, 20, 0, 7); ctx.fill();
      ctx.filter = "none";
      if (caught > 0) ctx.filter = "blur(" + (caught * 11).toFixed(1) + "px)";
      text(ctx, card.who, x + 86, y + 44, "600 26px " + SANS, C.ink, "left");
      text(ctx, card.when, x + 86 + ctx.measureText(card.who).width + 16, y + 44, "22px " + SANS, C.faint, "left");
      text(ctx, card.text, x + 32, y + 96, "25px " + SANS, C.soft, "left");
      if (!card.flagged) text(ctx, "✓ KEPT", x + 32, y + 132, "600 15px " + MONO, C.safe, "left", 1.5);
      ctx.filter = "none";
      ctx.restore();
    }
    if (card.flagged) {
      var sc = smooth(local, card.filterAt, card.filterAt + 0.55);
      if (sc > 0 && sc < 1) {
        ctx.save(); roundRect(ctx, x, y, w, ch, 20); ctx.clip();
        var sx = x + sc * w;
        var g = ctx.createLinearGradient(sx - 130, 0, sx + 130, 0);
        g.addColorStop(0, "rgba(107,140,255,0)"); g.addColorStop(0.5, withAlpha(C.accent, 0.8)); g.addColorStop(1, "rgba(160,130,255,0)");
        ctx.fillStyle = g; ctx.fillRect(x, y, w, ch);
        ctx.restore();
      }
    }
    if (collapsed > 0.02) {
      ctx.save(); ctx.globalAlpha = collapsed;
      shield(ctx, x + 40, y + 33, 28);
      text(ctx, "Hidden by valyou", x + 68, y + 42, "24px " + SANS, C.soft, "left");
      var lw = ctx.measureText("Hidden by valyou").width;
      text(ctx, card.cat.toUpperCase(), x + 68 + lw + 22, y + 41, "600 15px " + MONO, C.flag, "left", 1);
      roundRect(ctx, x + w - 108, y + 20, 84, 34, 17); ctx.strokeStyle = C.lineS; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, "Show", x + w - 66, y + 43, "600 17px " + SANS, C.accent, "center");
      ctx.restore();
    }
    ctx.restore();
    return ch;
  }

  /* ---------------- scenes (portrait layout) ---------------- */

  function sceneOpen(ctx, t) {
    var a1 = alphaOf(t, 0.8, 3.4, 1.0, 0.5);
    var a2 = alphaOf(t, 3.4, 7.0, 0.6, 0.6);
    if (a1 > 0) {
      centerWrap(ctx, "The feed was never built for you.", 940, "italic 600 66px " + SERIF, C.ink, 84, a1, W - 150);
    }
    if (a2 > 0) {
      // "It was built to keep you" then "angry." on its own coloured line.
      centerWrap(ctx, "It was built to keep you", 900, "italic 600 66px " + SERIF, C.ink, 84, a2, W - 150);
      text(ctx, "angry.", CX, 1040, "italic 600 66px " + SERIF, C.flag, "center", 0, a2);
    }
  }

  function sceneReveal(ctx, t) {
    var scanX = lerp(-220, W + 220, easeInOut(smooth(t, 6.8, 8.2)));
    scanLine(ctx, scanX, smooth(t, 6.8, 7.0) * (1 - smooth(t, 8.0, 8.3)), 220);

    var appear = smooth(t, 7.6, 9.2) * (1 - smooth(t, 10.8, 11.6));
    if (appear > 0) {
      var scale = lerp(0.82, 1, easeOut(smooth(t, 7.6, 9.2)));
      var yc = 860;
      var bloom = Math.max(0, 1 - Math.abs(t - 8.05) / 0.5);
      if (bloom > 0) {
        var bg = ctx.createRadialGradient(CX, yc, 0, CX, yc, 460 * bloom + 120);
        bg.addColorStop(0, withAlpha("#9fb4ff", 0.5 * bloom)); bg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      }
      ctx.save(); ctx.globalAlpha = appear;
      shield(ctx, CX, yc, 210 * scale, { vProgress: easeOut(smooth(t, 8.3, 9.4)) });
      ctx.restore();
    }
    var wa = alphaOf(t, 9.4, 11.4, 0.7, 0.7);
    if (wa > 0) text(ctx, "valyou", CX, 1120, "650 96px " + SANS, C.ink, "center", -1, wa);
  }

  var CARDS = [
    { who: "Maya R.", when: "· 2m", text: "made the best carbonara tonight", flagged: false },
    { who: "@ragefarm", when: "· now", text: "you won't believe what they did", flagged: true, cat: "Rage bait", filterAt: 1.1 },
    { who: "Trailhead", when: "· 9m", text: "golden hour from the ridge", flagged: false },
    { who: "unknown", when: "· 1m", text: "█████ ██████ ████", flagged: true, cat: "Harassment", filterAt: 2.0 },
    { who: "Dev Chen", when: "· 14m", text: "shipped the thing. small win.", flagged: false }
  ];
  function sceneProduct(ctx, t) {
    var a = alphaOf(t, 11.2, 18.2, 0.7, 0.7);
    if (a <= 0) return;
    var local = t - 11.2;
    ctx.save(); ctx.globalAlpha = a;
    var pw = 900, px = CX - pw / 2, py = 470;
    var drift = -easeInOut(smooth(local, 0, 6.5)) * 60;
    text(ctx, "YOUR FEED", px + 8, py - 22, "600 18px " + MONO, C.faint, "left", 4);
    text(ctx, "valyou on", px + pw - 8, py - 22, "600 18px " + MONO, C.accent, "right", 2);
    var y = py + drift;
    for (var i = 0; i < CARDS.length; i++) {
      var cardLocal = local - i * 0.5;
      if (cardLocal < 0) continue;
      var slide = (1 - easeOut(smooth(cardLocal, 0, 0.5))) * 44;
      ctx.save(); ctx.globalAlpha = a * smooth(cardLocal, 0, 0.4);
      var ch = feedCard(ctx, px, y + slide, pw, CARDS[i], cardLocal);
      ctx.restore();
      y += ch + 18;
    }
    ctx.restore();
    var ta = alphaOf(t, 12.6, 18.0, 0.7, 0.8);
    if (ta > 0) centerWrap(ctx, "Filter the feed. Automatically.", 1660, "italic 600 54px " + SERIF, C.ink, 66, ta, W - 130);
  }

  var CHIPS = [
    { label: "Racial hate", act: "HIDDEN", col: "#6b8cff" },
    { label: "Gendered hate", act: "HIDDEN", col: "#6b8cff" },
    { label: "Violence & threats", act: "HIDDEN", col: "#6b8cff" },
    { label: "Harassment", act: "BLURRED", col: "#a082ff" },
    { label: "Rage bait", act: "BLURRED", col: "#a082ff" }
  ];
  function sceneFeatures(ctx, t) {
    var a = alphaOf(t, 18.2, 24.2, 0.6, 0.7);
    if (a <= 0) return;
    var local = t - 18.2;
    ctx.save(); ctx.globalAlpha = a;
    centerWrap(ctx, "FIVE THINGS YOU DIDN'T ASK TO SEE", 560, "600 22px " + MONO, C.accent, 34, 1, W - 140);
    var cy = 720, cw = 860, cx = CX - cw / 2;
    for (var i = 0; i < CHIPS.length; i++) {
      var st = 0.4 + i * 0.45;
      var ca = easeOut(smooth(local, st, st + 0.4));
      if (ca <= 0) continue;
      var pop = lerp(0.9, 1, ca);
      var yy = cy + i * 128;
      ctx.save();
      ctx.globalAlpha = a * ca;
      ctx.translate(CX, yy); ctx.scale(pop, pop); ctx.translate(-CX, -yy);
      roundRect(ctx, cx, yy - 44, cw, 84, 42); ctx.fillStyle = C.surface; ctx.fill();
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, CHIPS[i].label, cx + 40, yy + 10, "600 32px " + SANS, C.ink, "left");
      var tag = CHIPS[i].act;
      ctx.font = "600 18px " + MONO;
      var tw = ctx.measureText(tag).width + 34;
      roundRect(ctx, cx + cw - tw - 24, yy - 19, tw, 38, 19);
      ctx.fillStyle = withAlpha(CHIPS[i].col, 0.16); ctx.fill();
      text(ctx, tag, cx + cw - tw / 2 - 24, yy + 8, "600 18px " + MONO, CHIPS[i].col, "center", 1);
      ctx.restore();
    }
    var ha = alphaOf(t, 20.0, 24.0, 0.8, 0.8);
    if (ha > 0) centerWrap(ctx, "Hide, blur, or tag — your call.", 1560, "italic 600 50px " + SERIF, C.ink, 62, ha, W - 130);
    ctx.restore();
  }

  function scenePrivacy(ctx, t) {
    var a = alphaOf(t, 24.4, 29.2, 0.7, 0.7);
    if (a <= 0) return;
    var bloom = Math.max(0, 1 - Math.abs(t - 25.0) / 0.6);
    if (bloom > 0) {
      var bg = ctx.createRadialGradient(CX, 640, 0, CX, 640, 540 * bloom + 100);
      bg.addColorStop(0, withAlpha("#9fb4ff", 0.4 * bloom)); bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    }
    ctx.save(); ctx.globalAlpha = a;
    shield(ctx, CX, 640, 168);
    text(ctx, "PRIVATE BY DESIGN", CX, 850, "600 22px " + MONO, C.accent, "center", 4);
    text(ctx, "Nothing you browse", CX, 970, "600 62px " + SERIF, C.ink, "center");
    ctx.save();
    ctx.font = "italic 600 62px " + SERIF; ctx.textAlign = "center";
    ctx.fillStyle = brandGrad(ctx, CX - 380, 0, CX + 380, 0);
    ctx.globalAlpha = a;
    ctx.fillText("ever leaves your device.", CX, 1052);
    ctx.restore();
    var specA = alphaOf(t, 25.4, 29.0, 0.6, 0.7);
    if (specA > 0) {
      var specs = ["On-device", "AES-256", "Zero network", "No tracking"];
      ctx.save(); ctx.globalAlpha = a * specA;
      ctx.font = "600 24px " + MONO; ctx.textAlign = "left";
      // two rows of two, centred, so it fits the narrow frame comfortably
      for (var row = 0; row < 2; row++) {
        var items = specs.slice(row * 2, row * 2 + 2);
        var gap = 70, parts = items.map(function (s) { return ctx.measureText(s).width; });
        var totalW = parts.reduce(function (p, c) { return p + c; }, 0) + gap * (items.length - 1) + 44;
        var sx = CX - totalW / 2 + 22;
        var yy = 1180 + row * 54;
        for (var i = 0; i < items.length; i++) {
          ctx.fillStyle = C.safe; ctx.beginPath(); ctx.arc(sx - 20, yy - 8, 4.5, 0, 7); ctx.fill();
          ctx.fillStyle = C.soft; if ("letterSpacing" in ctx) ctx.letterSpacing = "1px";
          ctx.fillText(items[i], sx, yy);
          sx += parts[i] + gap;
        }
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function scenePlatforms(ctx, t) {
    var a = alphaOf(t, 29.2, 33.2, 0.6, 0.6);
    if (a <= 0) return;
    var local = t - 29.2;
    ctx.save(); ctx.globalAlpha = a;
    centerWrap(ctx, "ONE FILTER. EVERY SCREEN.", 560, "600 22px " + MONO, C.accent, 34, 1, W - 140);
    // three stacked horizontal cards
    var names = ["Chrome", "iOS", "Android"];
    var cw = 720, cx = CX - cw / 2, chh = 240, top = 720;
    for (var i = 0; i < 3; i++) {
      var st = 0.3 + i * 0.35;
      var ca = easeOut(smooth(local, st, st + 0.5));
      if (ca <= 0) continue;
      ctx.save(); ctx.globalAlpha = a * ca;
      var yy = top + i * (chh + 40), lift = (1 - ca) * 30;
      roundRect(ctx, cx, yy + lift, cw, chh, 34);
      ctx.fillStyle = C.surface; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      shield(ctx, cx + 150, yy + chh / 2 + lift, 150);
      text(ctx, names[i], cx + 300, yy + chh / 2 + 16 + lift, "600 46px " + SANS, C.ink, "left", -0.5);
      ctx.restore();
    }
    ctx.restore();
  }

  function sceneLogo(ctx, t) {
    var a = alphaOf(t, 33.2, 36.0, 0.7, 0.9);
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a;
    var pop = easeOut(smooth(t, 33.2, 34.0));
    shield(ctx, CX, 830, lerp(170, 190, pop));
    text(ctx, "valyou", CX, 1080, "650 112px " + SANS, C.ink, "center", -1);
    var ta = alphaOf(t, 34.0, 36.0, 0.6, 0.9);
    if (ta > 0) text(ctx, "Calm your social feed.", CX, 1180, "italic 500 44px " + SERIF, C.soft, "center", 0, ta);
    ctx.restore();
  }

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
