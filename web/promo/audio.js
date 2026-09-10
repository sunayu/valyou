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

const SR = 44100;
const DUR = 36.0;
const N = Math.floor(SR * DUR);

// ---- note helpers ----
const A4 = 440;
function n(semisFromA4) { return A4 * Math.pow(2, semisFromA4 / 12); }
// frequencies we use
const F = {
  A2: n(-24), C3: n(-21), E3: n(-17), F2: n(-28), G2: n(-26),
  A3: n(-12), B3: n(-10), C4: n(-9), D4: n(-7), E4: n(-5), F3: n(-16), G3: n(-14),
  G4: n(-2), A4: n(0), C5: n(3), E5: n(7),
};

// Chord progression Am – F – C – G (i VI III VII), 3s each, looped x3 = 36s
const CHORDS = [
  { root: F.A2, notes: [F.A3, F.C4, F.E4], arp: [F.A3, F.E4, F.A4, F.C5] },
  { root: F.F2, notes: [F.A3, F.C4, F.F3], arp: [F.F3, F.C4, F.A4, F.C5] },
  { root: F.C3, notes: [F.C4, F.E4, F.G4], arp: [F.C4, F.G4, F.C5, F.E5] },
  { root: F.G2, notes: [F.B3, F.D4, F.G3], arp: [F.G3, F.D4, F.G4, F.B3] },
];
const BAR = 3.0; // seconds per chord

// ---- utilities ----
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(t, a, b) { // smoothstep ramp 0..1 over [a,b]
  if (t <= a) return 0; if (t >= b) return 1;
  const u = (t - a) / (b - a); return u * u * (3 - 2 * u);
}
// exponential-ish percussive envelope
function penv(t, t0, attack, decay) {
  if (t < t0) return 0;
  const dt = t - t0;
  if (dt < attack) return dt / attack;
  return Math.exp(-(dt - attack) / decay);
}

// one-pole lowpass state per channel for the pad
function makeLP() { let y = 0; return (x, a) => (y = y + a * (x - y)); }

// ---- buffers ----
const L = new Float32Array(N);
const R = new Float32Array(N);

// section gain envelopes (the arc)
function padGain(t) {
  // fades in over 1.5s, present throughout, small dip at the 24s riser, ring-out
  const inn = smooth(t, 0.0, 3.0);
  const out = 1 - smooth(t, 34.0, 36.0);
  const body = 0.55 + 0.25 * smooth(t, 7.0, 10.0); // blooms at the resolve
  return inn * out * body;
}
function arpGain(t) {
  // enters at the theme (10.5s), rides through, softens at the lift, returns
  const inn = smooth(t, 10.5, 12.0);
  const dip = 1 - 0.7 * (smooth(t, 24.0, 25.5) - smooth(t, 28.5, 30.0));
  const out = 1 - smooth(t, 34.5, 36.0);
  return inn * dip * out;
}
function pulseGain(t) {
  const inn = smooth(t, 11.0, 13.0);
  const out = 1 - smooth(t, 28.0, 29.5); // drops out for the privacy beat
  return inn * out;
}

const lpL = makeLP(), lpR = makeLP();

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const bar = Math.floor((t % (BAR * 4)) / BAR); // 0..3 within the loop
  const chord = CHORDS[bar];
  const tin = (t % BAR); // time within current chord

  let l = 0, r = 0;

  // ---- PAD: detuned stacked sines per chord note, slow, warm ----
  const pg = padGain(t);
  if (pg > 0.001) {
    let s = 0;
    // sub / root
    s += 0.5 * Math.sin(2 * Math.PI * chord.root * t);
    s += 0.5 * Math.sin(2 * Math.PI * chord.root * 2 * t) * 0.3;
    for (let k = 0; k < chord.notes.length; k++) {
      const f = chord.notes[k];
      // three slightly detuned partials → chorused pad
      s += 0.33 * Math.sin(2 * Math.PI * f * t);
      s += 0.20 * Math.sin(2 * Math.PI * f * 1.003 * t);
      s += 0.20 * Math.sin(2 * Math.PI * f * 0.997 * t);
    }
    s *= 0.18 * pg;
    // gentle per-chord swell
    s *= 0.85 + 0.15 * Math.sin(2 * Math.PI * (tin / BAR));
    // brightness opens as the piece develops
    const cutoff = 0.05 + 0.10 * smooth(t, 6, 12);
    const lo = lpL(s, cutoff);
    l += lo; r += lpR(s * 1.0, cutoff);
    // subtle stereo shimmer
    l += 0.03 * pg * Math.sin(2 * Math.PI * chord.notes[2] * 1.5 * t + 0.6);
    r += 0.03 * pg * Math.sin(2 * Math.PI * chord.notes[2] * 1.5 * t - 0.6);
  }

  // ---- ARP: bell motif, eighth notes ----
  const ag = arpGain(t);
  if (ag > 0.001) {
    const step = BAR / 4;            // 4 arp notes per chord
    const idx = Math.floor(tin / step) % chord.arp.length;
    const t0 = Math.floor(t / step) * step;
    const f = chord.arp[idx];
    const e = penv(t, t0, 0.004, 0.28);
    // bell = fundamental + shimmering upper partial
    let b = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2.01 * t) + 0.25 * Math.sin(2 * Math.PI * f * 3.0 * t);
    b *= e * 0.11 * ag;
    // ping-pong stereo by step parity
    if (idx % 2 === 0) { l += b * 1.0; r += b * 0.6; }
    else { l += b * 0.6; r += b * 1.0; }
  }

  // ---- soft PULSE (kick-ish heartbeat) on the beat ----
  const kg = pulseGain(t);
  if (kg > 0.001) {
    const beat = BAR / 2;           // two per chord (slow, ~80bpm feel)
    const t0 = Math.floor(t / beat) * beat;
    const e = penv(t, t0, 0.002, 0.13);
    const pitch = 90 * Math.exp(-(t - t0) * 22) + 45;
    const k = Math.sin(2 * Math.PI * pitch * (t - t0)) * e * 0.5 * kg;
    l += k; r += k;
  }

  // ---- RISER into the privacy beat (~22.5–25s) + a small pre-logo lift (~33s) ----
  function riser(a, b, amp) {
    if (t < a || t > b) return 0;
    const u = (t - a) / (b - a);
    // filtered noise sweeping up
    const noise = Math.random() * 2 - 1;
    const env = Math.sin(Math.PI * u) * amp; // swell in/out
    // crude bandpass emphasis rising with u via a fast osc gate
    const gate = 0.5 + 0.5 * Math.sin(2 * Math.PI * (200 + 3000 * u) * t);
    return noise * gate * env;
  }
  const rs = riser(22.5, 25.0, 0.10) + riser(32.5, 34.0, 0.05);
  if (rs) { l += rs; r += rs * -1; } // wide stereo noise

  // ---- impacts: a soft boom at the shield-resolve (8s) and privacy hit (25s) ----
  function boom(t0) {
    const e = penv(t, t0, 0.003, 0.6);
    const f = 60 * Math.exp(-(t - t0) * 3) + 38;
    return Math.sin(2 * Math.PI * f * (t - t0)) * e;
  }
  const bm = 0.6 * boom(8.0) + 0.5 * boom(25.0) + 0.55 * boom(33.0);
  l += bm; r += bm;

  L[i] = l; R[i] = r;
}

// ---- simple stereo feedback-delay reverb for space ----
function reverb(buf, delaySec, fb, mix) {
  const d = Math.floor(delaySec * SR);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const wet = i >= d ? out[i - d] * fb : 0;
    out[i] = buf[i] + wet;
  }
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * (1 - mix) + out[i] * mix;
}
reverb(L, 0.223, 0.32, 0.22);
reverb(R, 0.241, 0.32, 0.22);

// ---- master: soft saturation, master fade, normalize ----
let peak = 0;
for (let i = 0; i < N; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const norm = peak > 0 ? 0.89 / peak : 1;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = smooth(t, 0, 0.6) * (1 - smooth(t, 35.2, 36.0));
  L[i] = Math.tanh(L[i] * norm * 1.1) * fade;
  R[i] = Math.tanh(R[i] * norm * 1.1) * fade;
}

// ---- write 16-bit PCM WAV ----
function writeWav(file, l, r) {
  const num = l.length;
  const bytesPerSample = 2, ch = 2;
  const dataLen = num * ch * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * ch * bytesPerSample, 28); buf.writeUInt16LE(ch * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < num; i++) {
    buf.writeInt16LE(clamp(l[i], -1, 1) * 32767 | 0, o); o += 2;
    buf.writeInt16LE(clamp(r[i], -1, 1) * 32767 | 0, o); o += 2;
  }
  fs.writeFileSync(file, buf);
}

const out = path.join(__dirname, "soundtrack.wav");
writeWav(out, L, R);

// tiny report: RMS per 3s block, to sanity-check the arc
let report = [];
for (let s = 0; s < DUR; s += 3) {
  let sum = 0, c = 0;
  for (let i = s * SR; i < Math.min((s + 3) * SR, N); i++) { sum += L[i] * L[i]; c++; }
  report.push((s).toFixed(0) + "s:" + Math.sqrt(sum / c).toFixed(3));
}
console.log("wrote", out, `(${DUR}s, ${SR}Hz stereo)`);
console.log("RMS arc:", report.join("  "));
