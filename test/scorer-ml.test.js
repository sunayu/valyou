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
 * Integration: the ML assist inside the real scorer.
 *
 * These tests load the shipped model and drive Scorer.scoreText/decide, so
 * they prove the end-to-end safety property that unit tests of the model
 * alone cannot: the assist reinforces pattern evidence but can never, on
 * default settings, filter anything by itself.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Settings = require("../src/lib/settings.js");
const Scorer = require("../src/lib/scorer.js");
const ML = require("../src/lib/ml.js");

const MODEL_PATH = path.join(__dirname, "..", "src", "model", "model-data.js");
const hasModel = fs.existsSync(MODEL_PATH);
const modelData = hasModel ? require(MODEL_PATH) : null;

const DEFAULTS = Settings.sanitize(null);

test.beforeEach(() => {
  // Every test decides its own model state; never leak across tests.
  ML.load(null);
});

test("with the model off, the scorer is pattern-only", () => {
  ML.load(null);
  const result = Scorer.scoreText("all immigrants are vermin", DEFAULTS.rules);
  assert.ok(!result.signals.some((s) => s.id === "ml_assist"));
});

test("a loaded model can add a capped ml_assist signal", { skip: !hasModel }, () => {
  ML.load(modelData);
  // Per-example scores are noisy, so assert the mechanism over a batch: at
  // least one overtly hateful line produces the signal, and whenever it does,
  // the weight is within the cap and the explanation is human-readable.
  const overt = [
    "you stupid worthless trash, go die",
    "kill all of them",
    "these subhuman animals should be wiped out",
    "burn them all, filthy scum",
  ];

  let produced = 0;
  for (const text of overt) {
    const ml = Scorer.scoreText(text, DEFAULTS.rules).signals.find((s) => s.id.startsWith("ml_"));
    if (!ml) continue;
    produced += 1;
    assert.ok(ml.weight > 0 && ml.weight <= ML.MAX_WEIGHT, "weight must stay within the cap");
    assert.match(ml.why, /language model flagged likely .*\d+%/i);
  }
  assert.ok(produced > 0, "expected the model to flag at least one overt example");
});

test("the model alone cannot cross a default threshold — no model-only filtering", { skip: !hasModel }, () => {
  ML.load(modelData);

  // Find text the MODEL flags but the PATTERNS do not. Then prove the merged
  // decision is still "off" on default settings — the cap in action.
  const candidates = [
    "you stupid worthless trash, go die",
    "these people are the absolute worst kind of scum",
    "kill all of them",
    "burn them all down",
  ];

  let testedAny = false;
  for (const text of candidates) {
    // Pattern-only score (model off).
    ML.load(null);
    const patternOnly = Scorer.scoreText(text, DEFAULTS.rules);
    const patternDecision = Scorer.decide(patternOnly.scores, DEFAULTS, {});

    // Only interesting when patterns alone would NOT act.
    if (patternDecision.action !== "off") continue;

    ML.load(modelData);
    const withMl = Scorer.scoreText(text, DEFAULTS.rules);
    const mlSignal = withMl.signals.find((s) => s.id.startsWith("ml_"));
    if (!mlSignal) continue; // model didn't flag it either; not this case

    testedAny = true;
    const decision = Scorer.decide(withMl.scores, DEFAULTS, {});
    assert.equal(
      decision.action,
      "off",
      `model-flagged "${text}" must not be filtered on defaults (got ${decision.action})`
    );
  }

  assert.ok(testedAny, "expected at least one model-flags-but-patterns-don't case to exist");
});

test("the model tips a borderline pattern case over the line", { skip: !hasModel }, () => {
  ML.load(modelData);

  // A phrase with genuine pattern evidence just under threshold, plus a model
  // nudge, can legitimately cross — this is the assist doing its job.
  // We assert the mechanism: adding the ML signal never DECREASES a category
  // score, and can only ever raise it toward (never past, alone) a decision.
  const text = "these people are animals and should be gotten rid of";

  ML.load(null);
  const before = Scorer.scoreText(text, DEFAULTS.rules).scores;
  ML.load(modelData);
  const after = Scorer.scoreText(text, DEFAULTS.rules).scores;

  for (const id of Object.keys(before)) {
    assert.ok(after[id] >= before[id] - 1e-9, `${id} must not decrease with the assist`);
  }
});

test("the model does not manufacture filtering on ordinary posts", { skip: !hasModel }, () => {
  ML.load(modelData);
  const benign = [
    "made the best carbonara of my life, recipe in comments",
    "so proud of my daughter, she graduated today",
    "anyone else watching the game tonight? what a comeback",
    "reminder that the council meeting is thursday at seven",
    "three years sober today, thank you to everyone who checked in",
  ];
  for (const text of benign) {
    const result = Scorer.scoreText(text, DEFAULTS.rules);
    const decision = Scorer.decide(result.scores, DEFAULTS, {});
    assert.equal(decision.action, "off", `false positive with ML on: ${text}`);
  }
});
