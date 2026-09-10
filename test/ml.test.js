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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ML = require("../src/lib/ml.js");

const MODEL_PATH = path.join(__dirname, "..", "src", "model", "model-data.js");
const hasModel = fs.existsSync(MODEL_PATH);
const modelData = hasModel ? require(MODEL_PATH) : null;

/* ------------------------------------------------------------------ *
 * Feature extraction — deterministic, the training/serving contract  *
 * ------------------------------------------------------------------ */

test("fnv1a is deterministic and unsigned", () => {
  const a = ML.fnv1a("hello");
  assert.equal(a, ML.fnv1a("hello"));
  assert.notEqual(a, ML.fnv1a("hellp"));
  assert.ok(a >= 0 && a <= 0xffffffff);
});

test("features are sorted, unique bucket indices in range", () => {
  const idx = ML.features("all immigrants are vermin");
  assert.ok(idx.length > 0);
  for (let i = 0; i < idx.length; i += 1) {
    assert.ok(idx[i] >= 0 && idx[i] < ML.DIM);
    if (i > 0) assert.ok(idx[i] > idx[i - 1], "must be strictly sorted + unique");
  }
});

test("feature extraction is stable across calls (training/serving parity)", () => {
  // If this ever differs, a model trained under one extraction is being
  // served under another — silent, corrupting skew.
  const a = ML.features("the quick brown fox");
  const b = ML.features("the quick brown fox");
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("obfuscated text shares character-gram features with its clean form", () => {
  // Char n-grams run on the de-obfuscated text, so evasion should not fully
  // detach a phrase from its features.
  const clean = new Set(ML.features("kill them"));
  const evaded = new Set(ML.features("k1ll them"));
  const shared = [...clean].filter((f) => evaded.has(f));
  assert.ok(shared.length > 0, "leetspeak variant should share features");
});

test("empty and tiny text yield no features", () => {
  assert.equal(ML.features("").length, 0);
});

/* ------------------------------------------------------------------ *
 * Signal weight mapping — the safety cap                              *
 * ------------------------------------------------------------------ */

test("signal weight is zero below the confidence floor", () => {
  assert.equal(ML.signalWeight(0), 0);
  assert.equal(ML.signalWeight(0.5), 0);
  assert.equal(ML.signalWeight(ML.MIN_PROB - 0.001), 0);
});

test("signal weight ramps from the floor to the cap", () => {
  assert.ok(ML.signalWeight(ML.MIN_PROB) >= 0);
  assert.ok(ML.signalWeight(0.85) > ML.signalWeight(0.75));
  assert.ok(Math.abs(ML.signalWeight(1) - ML.MAX_WEIGHT) < 1e-9);
});

test("the model can never reach a default action threshold on its own", () => {
  // The core safety property: MAX_WEIGHT sits below every default threshold
  // (0.55 / 0.6 / 0.7), so a model-only signal cannot cross any of them.
  const Settings = require("../src/lib/settings.js");
  const defaults = Settings.sanitize(null);
  for (const id of Object.keys(defaults.categories)) {
    assert.ok(
      ML.MAX_WEIGHT < defaults.categories[id].threshold,
      `${id} threshold (${defaults.categories[id].threshold}) must exceed the ML cap (${ML.MAX_WEIGHT})`
    );
  }
});

/* ------------------------------------------------------------------ *
 * Load / score contract                                               *
 * ------------------------------------------------------------------ */

test("with no model loaded, score is zero and ready is false", () => {
  ML.load(null);
  assert.equal(ML.ready(), false);
  assert.equal(ML.score("all immigrants are vermin"), 0);
});

test("load rejects a mismatched feature version, dimension, or head shape", () => {
  assert.equal(ML.load({ featureVersion: 999, dim: ML.DIM, heads: {} }), false);
  assert.equal(ML.load({ featureVersion: ML.FEATURE_VERSION, dim: 1, heads: {} }), false);
  // v1 single-head shape (no `heads`) must be rejected loudly, not scored.
  assert.equal(ML.load({ featureVersion: ML.FEATURE_VERSION, dim: ML.DIM, weights: "AAAA" }), false);
  // A malformed head poisons the whole model.
  assert.equal(
    ML.load({ featureVersion: ML.FEATURE_VERSION, dim: ML.DIM, heads: { violence: { bias: 0 } } }),
    false
  );
  assert.equal(ML.load({}), false);
  assert.equal(ML.load(null), false);
  assert.equal(ML.ready(), false);
});

test("scoreAll reports every head with its own floor", { skip: !hasModel }, () => {
  ML.load(modelData);
  const all = ML.scoreAll("kill all of them, every last one");
  const cats = Object.keys(all);
  assert.ok(cats.length >= 2, "expected multiple heads");
  for (const cat of cats) {
    assert.ok(all[cat].p >= 0 && all[cat].p <= 1, `${cat} p out of range`);
    assert.ok(all[cat].minProb >= 0.5 && all[cat].minProb <= 0.9, `${cat} floor out of range`);
  }
  // score() is the strongest head — consistent with scoreAll.
  const max = Math.max(...cats.map((c) => all[c].p));
  assert.ok(Math.abs(ML.score("kill all of them, every last one") - max) < 1e-9);
});

/* ------------------------------------------------------------------ *
 * Against the shipped model (skipped if not yet trained)             *
 * ------------------------------------------------------------------ */

test("the shipped model loads and matches the feature schema", { skip: !hasModel }, () => {
  assert.equal(ML.load(modelData), true);
  assert.equal(ML.ready(), true);
  assert.equal(modelData.featureVersion, ML.FEATURE_VERSION);
  assert.equal(modelData.dim, ML.DIM);
});

test("the shipped model scores hateful text above clean text on average", { skip: !hasModel }, () => {
  ML.load(modelData);

  const hateful = [
    "all these immigrants are subhuman vermin and should be exterminated",
    "kill all of them, every last one",
    "you stupid worthless piece of trash, nobody wants you here",
    "these people are animals and don't deserve to live",
  ];
  const clean = [
    "made the best carbonara of my life, recipe in the comments",
    "so proud of my daughter, she graduated today",
    "anyone else watching the game tonight, what a comeback",
    "looking for a plumber recommendation in the north end",
  ];

  const avg = (xs) => xs.reduce((s, t) => s + ML.score(t), 0) / xs.length;
  const hateAvg = avg(hateful);
  const cleanAvg = avg(clean);

  // The defensible claim: a clear separation on average, not that every
  // hateful phrasing clears a fixed bar. The corpus is slur/threat-heavy
  // Twitter data, so polished hate ("women belong in the kitchen") scores
  // weaker than overt abuse — a documented bias (docs/ML.md), and precisely
  // why the model only ASSISTS the pattern rules rather than deciding.
  assert.ok(
    hateAvg > cleanAvg + 0.15,
    `hateful (${hateAvg.toFixed(2)}) should clearly outscore clean (${cleanAvg.toFixed(2)})`
  );
});

test("the assist clears its confidence floor on a majority of overt hate", { skip: !hasModel }, () => {
  ML.load(modelData);
  // Per-example scores from a small linear model are noisy, so the honest
  // claim is a majority over a batch — not that any single string clears the
  // floor. This is where signalWeight actually contributes to the scorer.
  const overt = [
    "kill all of them",
    "these subhuman animals should be exterminated",
    "you stupid worthless trash, go die",
    "exterminate every last one of them",
    "they are vermin and deserve to be wiped out",
    "burn them all, filthy scum",
  ];
  const cleared = overt.filter((t) => ML.score(t) > ML.MIN_PROB).length;
  assert.ok(
    cleared >= Math.ceil(overt.length / 2),
    `only ${cleared}/${overt.length} cleared the ${ML.MIN_PROB} floor`
  );
});

test("clean everyday posts rarely clear the confidence floor", { skip: !hasModel }, () => {
  ML.load(modelData);
  const clean = [
    "made the best carbonara of my life",
    "so proud of my daughter today",
    "what a comeback in the game tonight",
    "looking for a plumber recommendation",
    "three years sober today, thank you all",
    "the council meeting is thursday at seven",
  ];
  // What matters at runtime is whether any HEAD crosses ITS OWN tuned floor
  // (that is the exact condition that emits a scorer signal) — not the
  // legacy global MIN_PROB, which v2 heads intentionally exceed.
  const flagged = clean.filter((t) => {
    const all = ML.scoreAll(t);
    return Object.keys(all).some((cat) => ML.signalWeight(all[cat].p, all[cat].minProb) > 0);
  }).length;
  // A few false positives are tolerable because the assist is capped and
  // cannot act alone; a flood would mean the model is miscalibrated.
  assert.ok(flagged <= 1, `${flagged}/${clean.length} clean posts crossed their head floors`);
});

test("the shipped model runs within the scan-path budget", { skip: !hasModel }, () => {
  ML.load(modelData);
  const post =
    "Went to the farmers market this morning and came back with more tomatoes " +
    "than any two people could eat. Message me if you want some.";

  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) ML.score(post);
  const per = (performance.now() - started) / 1000;

  // Well inside the 0.25 ms/unit budget the scorer must hold overall.
  assert.ok(per < 0.15, `ML score took ${per.toFixed(4)} ms, expected < 0.15 ms`);
});

test("score returns a probability in (0,1) for the shipped model", { skip: !hasModel }, () => {
  ML.load(modelData);
  for (const t of ["anything at all", "another string", "kill"]) {
    const p = ML.score(t);
    assert.ok(p > 0 && p < 1, `p=${p} out of range for "${t}"`);
  }
});
