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
 * Trainer for the valyou v2 MULTI-HEAD ML assist.
 *
 * v1 shipped one binary "hate" head trained on a single 25k-tweet corpus.
 * v2 trains FIVE independent logistic-regression heads — one per product
 * category — over the SAME shared feature extraction (imported from
 * src/lib/ml.js so training and inference can never drift apart):
 *
 *   hate_racial  — civil_comments identity_attack + HateXplain (racial/
 *                  ethnic/religious targets) + Davidson hate
 *   hate_gender  — EDOS sexism (SemEval-2023 Task 10) + HateXplain
 *                  (women/LGBTQ targets)
 *   violence     — civil_comments threat + EDOS "threats" subclass
 *   harassment   — civil_comments insult/toxicity + Davidson offensive
 *   rage_bait    — Stop Clickbait corpus (Chakraborty et al. 2016)
 *
 * ~530k labeled rows total (~20x v1). Each head learns its own weights and
 * its own held-out operating point (minProb), so the runtime can route
 * "racist language" evidence to the racial-hate category instead of smearing
 * one blurry score across three categories the way v1 had to.
 *
 * ── For a reader new to machine learning ───────────────────────────────
 * Training = starting from all-zero weights and repeatedly nudging them:
 * for each example, predict, compare to the label, and shift each active
 * feature's weight a little in the direction that would have made the
 * prediction better (stochastic gradient descent on logistic loss). The
 * nudge size (learning rate) decays across epochs so the model settles.
 * Positive examples are rarer than negatives, so their nudges are weighted
 * up (class weighting) to stop the model from just predicting "clean" for
 * everything.
 *
 * Input CSVs (label,text — one per head, built by the corpus-prep step from
 * the public datasets above) live in training-data/v2/. They are NOT
 * committed (training-data/ is gitignored); regenerate with the fetch +
 * prep pipeline documented in docs/ML.md.
 *
 * Output: src/model/model-data.js (auto-synced into the extension, the
 * mobile inject bundle, and the Safari payload by their build scripts).
 */

"use strict";

const fs = require("node:fs"); // read the corpora, write the model file
const path = require("node:path"); // OS-independent file paths

// The runtime module IS the feature definition — import it so the features
// used to train are byte-for-byte the features used to score.
const ML = require(path.join(__dirname, "..", "src", "lib", "ml.js"));

const DATA_DIR = process.env.VALYOU_TRAIN_DIR || path.join(__dirname, "..", "training-data", "v2");
const OUT_DIR = path.join(__dirname, "..", "src", "model");
const OUT_FILE = path.join(OUT_DIR, "model-data.js");

/** The heads to train, in the order they are stored. Names ARE taxonomy
 * category ids — the scorer routes each head's evidence to its category. */
const HEADS = ["hate_racial", "hate_gender", "violence", "harassment", "rage_bait"];

/* Training hyper-parameters (per head). */
const EPOCHS = 8; // full passes over the data
const LR0 = 0.3; // initial learning rate = size of each weight nudge
const L2 = 1e-6; // regularization: gently pulls weights toward 0 against overfitting
const SEED = 1234567; // fixed seed -> identical model every run
const POS_WEIGHT_CAP = 8; // cap on the rare-class upweighting

/** mulberry32 — tiny deterministic PRNG so shuffles are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parse a label,text CSV (RFC-4180-ish). The text column may contain commas,
 * quotes, and newlines when quoted, so this is a small state machine rather
 * than a split(","): walk character by character, tracking whether we are
 * inside a quoted field ("" inside quotes = one literal quote).
 *
 * @param {string} csv Raw file contents.
 * @returns {{text: string, label: number}[]}
 */
function parseCsv(csv) {
  const rows = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  const push = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    push();
    if (record.length >= 2 && record[0] !== "label") {
      const label = Number(record[0]);
      // Everything after the first comma is the text (re-joined in case the
      // text itself was unquoted and contained commas).
      const text = record.slice(1).join(",");
      if ((label === 0 || label === 1) && text) rows.push({ text, label });
    }
    record = [];
  };
  for (let i = 0; i < csv.length; i += 1) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1; // "" -> literal quote
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") push();
    else if (c === "\n") endRecord();
    else if (c !== "\r") field += c;
  }
  if (field || record.length) endRecord();
  return rows;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Featurize a list of rows once, up front. Extraction is the expensive part
 * of training, so paying it once per row (instead of once per row per epoch)
 * makes the 8-epoch run ~8x faster at the cost of holding the indices in
 * memory (a few hundred MB at the largest head — fine for a build machine).
 */
function featurize(rows) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    out[i] = { idx: ML.features(rows[i].text), y: rows[i].label };
  }
  return out;
}

/**
 * Train one logistic head with SGD.
 *
 * @param {{idx: Uint32Array, y: number}[]} samples Featurized training rows.
 * @returns {{weights: Float32Array, bias: number}}
 */
function train(samples) {
  const weights = new Float32Array(ML.DIM);
  let bias = 0;

  // Class weighting: multiply the learning nudge for positive examples by
  // (negatives / positives), capped, so rare positives are not drowned out.
  let pos = 0;
  for (const s of samples) pos += s.y;
  const posWeight = Math.min(POS_WEIGHT_CAP, (samples.length - pos) / (pos || 1));

  const random = rng(SEED);
  const order = samples.map((_, i) => i);
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    // Fisher–Yates shuffle so each epoch sees the data in a fresh order.
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    // Learning-rate decay: later epochs make smaller nudges so weights settle.
    const lr = LR0 / (1 + epoch);
    for (let n = 0; n < order.length; n += 1) {
      const s = samples[order[n]];
      if (s.idx.length === 0) continue;
      const value = 1 / Math.sqrt(s.idx.length); // same scaling as inference
      let z = bias;
      for (let k = 0; k < s.idx.length; k += 1) z += weights[s.idx[k]] * value;
      const p = sigmoid(z);
      // Gradient of logistic loss: (label - prediction), scaled by the class
      // weight for positives so the rare class pulls its full weight.
      const g = (s.y - p) * (s.y === 1 ? posWeight : 1) * lr;
      bias += g;
      for (let k = 0; k < s.idx.length; k += 1) {
        const i = s.idx[k];
        // The L2 term (1 - lr*L2) leaks a tiny fraction of each weight away
        // every update — the "gentle pull toward zero".
        weights[i] = weights[i] * (1 - lr * L2) + g * value;
      }
    }
  }
  return { weights, bias };
}

/** Probability of one featurized sample under a head. */
function predict(model, s) {
  if (s.idx.length === 0) return 0;
  const value = 1 / Math.sqrt(s.idx.length);
  let z = model.bias;
  for (let k = 0; k < s.idx.length; k += 1) z += model.weights[s.idx[k]] * value;
  return sigmoid(z);
}

/**
 * Area under the ROC curve — the standard threshold-free quality number.
 * 0.5 = coin flip, 1.0 = perfect ranking of positives above negatives.
 * Computed by ranking all val scores and counting correctly-ordered pairs.
 */
function auc(samples, model) {
  const scored = samples.map((s) => ({ p: predict(model, s), y: s.y }));
  scored.sort((a, b) => a.p - b.p);
  let rank = 1;
  let sumPosRanks = 0;
  let nPos = 0;
  let nNeg = 0;
  for (const s of scored) {
    if (s.y === 1) {
      sumPosRanks += rank;
      nPos += 1;
    } else nNeg += 1;
    rank += 1;
  }
  if (!nPos || !nNeg) return 0.5;
  return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Pick the head's operating floor (minProb): the probability that 99.5% of
 * held-out NEGATIVES stay under. Anything the model says below this floor is
 * ignored at runtime, so "clean text almost never moves the needle" is a
 * measured property, not a hope. Clamped to [0.5, 0.9] so a weak head cannot
 * set an absurd floor.
 */
function pickMinProb(valSamples, model) {
  const negProbs = valSamples.filter((s) => s.y === 0).map((s) => predict(model, s));
  negProbs.sort((a, b) => a - b);
  if (!negProbs.length) return 0.6;
  const q = negProbs[Math.min(negProbs.length - 1, Math.floor(negProbs.length * 0.995))];
  return Math.max(0.5, Math.min(0.9, Math.round(q * 100) / 100));
}

/** Precision/recall at a threshold on the held-out split. */
function evaluate(samples, model, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of samples) {
    const pred = predict(model, s) >= threshold ? 1 : 0;
    if (pred === 1 && s.y === 1) tp += 1;
    else if (pred === 1 && s.y === 0) fp += 1;
    else if (pred === 0 && s.y === 1) fn += 1;
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  return { precision, recall };
}

/** int8-quantize a weight vector: bytes + one shared scale. */
function quantize(weights) {
  let maxAbs = 0;
  for (const w of weights) maxAbs = Math.max(maxAbs, Math.abs(w));
  const scale = maxAbs / 127 || 1;
  const bytes = new Uint8Array(weights.length);
  for (let i = 0; i < weights.length; i += 1) {
    const q = Math.max(-127, Math.min(127, Math.round(weights[i] / scale)));
    bytes[i] = q < 0 ? q + 256 : q; // int8 stored as uint8 (two's complement)
  }
  return { bytes, scale };
}

/** Base64url-encode a byte array (matches Text.fromBase64Url in the runtime). */
function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function main() {
  const heads = {};
  const meta = {};
  for (const head of HEADS) {
    const trainFile = path.join(DATA_DIR, `${head}.train.csv`);
    const valFile = path.join(DATA_DIR, `${head}.val.csv`);
    if (!fs.existsSync(trainFile)) {
      throw new Error(`missing ${trainFile} — run the corpus prep pipeline (docs/ML.md)`);
    }
    const t0 = Date.now();
    const trainRows = featurize(parseCsv(fs.readFileSync(trainFile, "utf8")));
    const valRows = featurize(parseCsv(fs.readFileSync(valFile, "utf8")));
    const model = train(trainRows);
    const a = auc(valRows, model);
    const minProb = pickMinProb(valRows, model);
    const { precision, recall } = evaluate(valRows, model, minProb);
    const { bytes, scale } = quantize(model.weights);
    heads[head] = {
      weights: toBase64Url(bytes),
      scale,
      bias: model.bias,
      minProb,
    };
    meta[head] = {
      train: trainRows.length,
      val: valRows.length,
      auc: Math.round(a * 10000) / 10000,
      minProb,
      precisionAtFloor: Math.round(precision * 1000) / 1000,
      recallAtFloor: Math.round(recall * 1000) / 1000,
    };
    console.log(
      `${head}: n=${trainRows.length} AUC=${a.toFixed(4)} floor=${minProb} ` +
        `P@floor=${precision.toFixed(3)} R@floor=${recall.toFixed(3)} ` +
        `(${((Date.now() - t0) / 1000).toFixed(0)}s)`
    );
  }

  const data = {
    featureVersion: ML.FEATURE_VERSION,
    dim: ML.DIM,
    corpus:
      "civil_comments(CC0) + EDOS/SemEval2023(sexism) + HateXplain + " +
      "Davidson-2017 + StopClickbait-2016 — see docs/ML.md",
    heads,
    meta,
  };

  const banner =
    "/* Generated by scripts/train-model.js — do not edit by hand.\n" +
    " * v2 multi-head model. Reproduce: corpus prep (docs/ML.md) then\n" +
    " * `node scripts/train-model.js`. See docs/ML.md for bias notes. */\n\n" +
    "/*\n" +
    " * ============================================================================\n" +
    " * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n" +
    " * ============================================================================\n" +
    " *\n" +
    " * This file is the *output* of training the ML assist. Each entry in\n" +
    " * `heads` is one trained logistic-regression head (weights packed as a\n" +
    " * base64 int8 blob) for one product category; `meta` records held-out\n" +
    " * quality numbers for honesty and regression tracking. Editing anything\n" +
    " * here by hand would corrupt the model — retrain instead.\n" +
    " * ============================================================================\n" +
    " */\n";

  const body =
    "(function (root, factory) {\n" +
    "  var mod = factory();\n" +
    "  root.VALYOU = root.VALYOU || {};\n" +
    "  root.VALYOU.ModelData = mod;\n" +
    "  if (typeof module !== 'undefined' && module.exports) module.exports = mod;\n" +
    "})(typeof self !== 'undefined' ? self : globalThis, function () {\n" +
    "  return " + JSON.stringify(data) + ";\n" +
    "});\n";

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, banner + body);
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`wrote ${OUT_FILE} (${kb} KB, ${HEADS.length} heads)`);
}

main();
