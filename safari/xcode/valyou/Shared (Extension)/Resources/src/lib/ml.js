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
 * The ML assist: a linear text classifier with zero dependencies.
 *
 * WHAT KIND OF MODEL, AND WHY THIS KIND
 * A logistic regression over hashed word- and character-n-gram features —
 * the fastText / Vowpal-Wabbit family. It is the only class of model that
 * fits every product constraint at once:
 *
 *   - inference is one sparse dot product: microseconds, no libraries,
 *     comfortably inside the scan path's 0.25 ms budget
 *   - the whole model is a small quantized weight vector shipped with the
 *     extension — no downloads, no WASM, no GPU, nothing to break offline
 *   - it is auditable: every prediction decomposes into per-feature
 *     contributions, in keeping with a product that explains its decisions
 *
 * What it buys over the lexicon: generalization. Character n-grams catch
 * morphology and misspellings no regex anticipates; word n-grams catch
 * hostile phrasing with no slur in it. What it does NOT buy: reading
 * sarcasm, novel dogwhistles, or context — see docs/ML.md for the honest
 * boundary and the training/bias discussion.
 *
 * ROLE IN SCORING — assist, never a judge
 * The model's probability becomes one more signal in the scorer's noisy-OR,
 * with its weight CAPPED BELOW every default action threshold. On default
 * settings the model alone can never hide or blur anything; it can only tip
 * a decision where pattern evidence already exists, or surface in the
 * "Try it" breakdown. This cap is the product's answer to the known biases
 * of hate-speech corpora (see docs/ML.md): a biased nudge is bounded, a
 * biased verdict would not be.
 *
 * This module owns the FEATURE DEFINITION, and the trainer
 * (scripts/train-model.js) imports it from here — one implementation, so
 * training and inference can never drift apart.
 */

/*
 * ---------------------------------------------------------------------------
 * BEGINNER PRIMER — the concepts this file uses, in plain language
 * ---------------------------------------------------------------------------
 * If you are new to machine learning, here is everything you need to follow
 * the code below. Nothing here is exotic; it is arithmetic on arrays.
 *
 * WHAT A CLASSIFIER DOES
 *   Given a piece of text, we want a single number between 0 and 1 that says
 *   "how likely is this to be hateful?" (0 = almost certainly not, 1 = almost
 *   certainly yes). That number is a *probability*. Producing it is called
 *   *inference* or *scoring*.
 *
 * FEATURES
 *   A model cannot look at raw text; it works with numbers. So first we turn
 *   the text into a list of yes/no facts about it called *features*. Here a
 *   feature is simply "does this snippet of text appear?". See N-GRAMS below
 *   for the snippets we use.
 *
 * N-GRAMS  (the snippets)
 *   An n-gram is a run of n consecutive items.
 *     - A *word unigram* is one word:            "you"
 *     - A *word bigram* is two words in a row:    "you people"
 *     - A *character 3-gram* is 3 letters in a row inside a word: "hat", "ate"
 *   Word n-grams capture phrasing; character n-grams capture spelling and
 *   catch deliberate misspellings ("h8", "ha.te") that fixed word lists miss.
 *
 * HASHING (the "hashing trick")
 *   There are millions of possible n-grams, but our weight table has only
 *   DIM = 65536 slots. So instead of keeping a giant dictionary mapping each
 *   n-gram to a slot, we run each n-gram through a *hash function* (fnv1a
 *   below). A hash function turns any string into a number; we take that
 *   number modulo DIM to pick a slot. Two different n-grams can occasionally
 *   land in the same slot (a "collision"), but for this kind of model that
 *   only adds a little noise and is a fine trade for using no dictionary.
 *
 * LOGISTIC REGRESSION (the actual model)
 *   The model is just a big list of numbers called *weights* — one weight per
 *   slot — plus a single extra number called the *bias*. Each weight says how
 *   much that feature pushes toward "hateful" (positive weight) or away from
 *   it (negative weight). To score a text we:
 *     1. find which slots its features land in,
 *     2. add up the weights in those slots (this sum is called `z`),
 *     3. squash `z` into the 0..1 range with the *sigmoid* function
 *        1 / (1 + e^-z). Big positive z -> near 1; big negative z -> near 0.
 *   That final 0..1 number is the probability. "Regression" here just means
 *   we learned those weights by fitting them to labeled examples during
 *   training; this file only *uses* them, it does not train them.
 *
 * QUANTIZATION (int8 weights)
 *   Storing 65536 weights as normal 32-bit floats would be 256 KB. Instead the
 *   trainer squeezes each weight into a single byte (an 8-bit integer, -128..
 *   127) plus one shared `scale` number. That is *quantization*. To use a
 *   weight we multiply the stored byte by the scale to recover an approximate
 *   float — see decodeWeights(). It roughly quarters the model size for a
 *   negligible loss in accuracy.
 * ---------------------------------------------------------------------------
 */

/*
 * MODULE WRAPPER (the "UMD" pattern). This immediately-invoked function makes
 * the same file work in two worlds: a browser extension (where globals live on
 * `self`/`globalThis`) and Node.js (where code is shared via `module.exports`,
 * used by the tests and the trainer). `factory()` builds the module object
 * once; the wrapper then publishes it as `VALYOU.ML` for the browser AND as
 * `module.exports` for Node, so callers in either environment find it.
 */
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.ML = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // "use strict" opts into stricter JS error checking (e.g. assigning to an
  // undeclared variable throws instead of silently creating a global).
  "use strict";

  // `scope` is the global object: `self` inside a browser/worker, `globalThis`
  // in Node. `req` is a safe wrapper around Node's require() that returns null
  // in the browser (where require does not exist) instead of crashing.
  const scope = typeof self !== "undefined" ? self : globalThis;
  const req = (p) => (typeof require === "function" ? require(p) : null);
  // Pull in the shared text helpers (normalize/tokenize/deobfuscate/base64),
  // preferring the already-loaded browser global and falling back to require.
  const Text = (scope.VALYOU && scope.VALYOU.Text) || req("./text.js");

  /**
   * Feature-space size. 2^16 buckets is generous for a ~25k-document corpus
   * (hash collisions in linear models degrade gracefully anyway) and keeps
   * the int8 weight vector at 64 KB.
   */
  const DIM = 65536;

  /** Feature-schema version. Bump when extraction changes; the trainer
   * stamps it into the model and score() refuses a mismatched model, so a
   * stale weights file fails loudly instead of scoring garbage.
   * v2: added character 5-grams (stronger obfuscation coverage) and moved to
   * a MULTI-HEAD model — one logistic head per category, sharing this one
   * feature extraction. */
  const FEATURE_VERSION = 2;

  /**
   * FNV-1a 32-bit hash — tiny, fast, and completely deterministic across
   * platforms, which is the property that matters: the trainer (Node) and
   * the runtime (Chrome) must bucket identically forever.
   *
   * How it works: start from a fixed "seed" number, then for each character
   * mix its code into the running value with two operations — XOR, then
   * multiply by a fixed prime. Mixing every character makes tiny input changes
   * produce completely different outputs, which spreads features evenly across
   * the DIM buckets. It is NOT cryptographic (easy to reverse) — we only need
   * speed and determinism, not secrecy.
   *
   * @param {string} str Feature string.
   * @returns {number} Unsigned 32-bit hash.
   */
  function fnv1a(str) {
    // 0x811c9dc5 is the FNV "offset basis", the standard starting value.
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      // charCodeAt(i) is this character's numeric code. `^=` is bitwise XOR:
      // it flips bits of `hash` wherever the character's bits are 1, folding
      // the character into the running value.
      hash ^= str.charCodeAt(i);
      // FNV then multiplies by the prime 16777619. JavaScript numbers are
      // 64-bit floats and lose precision above 2^53, so we cannot just write
      // `hash * 16777619` and stay exact in 32 bits. Instead we express the
      // multiply as a sum of bit-shifts, because x * 16777619 equals
      // x*(2^24 + 2^8 + 2^7 + 2^4 + 2^1 + 2^0). `<<` shifts bits left, i.e.
      // multiplies by a power of two: (hash << 8) == hash * 256, and so on.
      // The final `>>> 0` is an unsigned right shift by 0: it does not move any
      // bits but forces the result back into an unsigned 32-bit integer,
      // discarding overflow so the math stays in "32-bit space".
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    // One more `>>> 0` so the returned value is a clean unsigned 32-bit number.
    return hash >>> 0;
  }

  /**
   * Extract the sparse feature set for one text.
   *
   * Three families, each namespaced so identical strings from different
   * families cannot collide by construction:
   *   w:  word unigrams        (normalized text)   — topical signal
   *   b:  word bigrams         (normalized text)   — phrasing signal
   *   c:  char 3- and 4-grams  (de-obfuscated text) — morphology signal,
   *       robust to misspelling and the same evasions the lexicon defeats
   *
   * Features are binary (presence), later scaled by 1/√n so long rants and
   * one-liners produce comparably-scaled inputs.
   *
   * @param {string} raw Text as it appeared on the page.
   * @returns {Uint32Array} Sorted, de-duplicated bucket indices.
   */
  function features(raw) {
    // A Set holds each bucket index at most once, so a feature that occurs
    // twice still counts once (features are "present or not", not counted).
    const buckets = new Set();

    // Word features: clean up the text, split it into word tokens, then hash
    // each word (prefix "w:") and each adjacent pair of words (prefix "b:").
    // The "% DIM" folds the 32-bit hash down into a valid bucket index 0..DIM-1.
    const normalized = Text.normalize(raw);
    const tokens = Text.tokenize(normalized);
    for (let i = 0; i < tokens.length; i += 1) {
      buckets.add(fnv1a("w:" + tokens[i]) % DIM);
      // Only form a bigram when there is a next word to pair with.
      if (i + 1 < tokens.length) {
        buckets.add(fnv1a("b:" + tokens[i] + " " + tokens[i + 1]) % DIM);
      }
    }

    // Character features: deobfuscate() undoes tricks like "h.a.t.e" so the
    // letters read normally. `padded` wraps the text in invisible boundary
    // markers so n-grams at the very start/end of the text are distinct from
    // ones in the middle. We then slide a window of length 3 and then 4 across
    // the string, hashing each window (prefix "c:"). slice(i, i+n) grabs the n
    // characters starting at position i.
    const folded = Text.deobfuscate(raw);
    const padded = "" + folded + ""; // boundary markers
    // v2: n runs 3..5 — 5-grams capture whole short words with their
    // boundaries, a strong signal for slurs and common misspellings.
    for (let n = 3; n <= 5; n += 1) {
      for (let i = 0; i + n <= padded.length; i += 1) {
        buckets.add(fnv1a("c:" + padded.slice(i, i + n)) % DIM);
      }
    }

    // Return the bucket indices as a sorted, typed integer array. Uint32Array
    // is a compact fixed-type array of unsigned 32-bit ints (faster and smaller
    // than a normal Array); sorting keeps the order deterministic.
    return Uint32Array.from(buckets).sort();
  }

  /**
   * Decode a base64 int8 weight blob into a Float32Array using its scale.
   *
   * This reverses the "quantization" described in the primer: the trainer
   * stored each weight as one signed byte plus a shared `scale`. Here we
   * multiply each byte back by `scale` to recover an approximate float weight.
   *
   * @param {{weights: string, scale: number, bias: number, dim: number}} data
   * @returns {Float32Array} Dequantized weights.
   */
  function decodeWeights(data) {
    // The weights arrive base64-encoded (a text-safe way to carry raw bytes).
    // fromBase64Url turns that text back into a byte array (values 0..255).
    const bytes = Text.fromBase64Url(data.weights);
    // Float32Array is a fixed-size array of 32-bit floats — the numeric form
    // we score with. One slot per stored byte.
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      // The bytes are really signed 8-bit values (-128..127) but a byte array
      // reports them unsigned (0..255). Anything above 127 is a negative
      // number that "wrapped around", so subtract 256 to recover its sign.
      const signed = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
      // Multiply by the shared scale to turn the small integer back into the
      // real-valued weight the model was trained with.
      out[i] = signed * data.scale;
    }
    return out;
  }

  /**
   * Lazily-decoded model cache. v2 models are MULTI-HEAD: one logistic head
   * per category, all sharing the single feature extraction above. `live` is
   * null when unusable, else {heads: [{cat, weights, bias, minProb}]}.
   */
  let live = null;

  /**
   * Load a model object (as emitted by the trainer) for scoring.
   *
   * WHY: decoding the weights is a little work, so we do it once here and cache
   * the result in `live`; every later score() call reuses it. The guard checks
   * that the model actually matches this code's feature schema and dimensions
   * before trusting it — a mismatched or missing model is rejected (returns
   * false) instead of silently producing nonsense scores.
   *
   * @param {object} data Model data (`VALYOU.ModelData` when bundled).
   * @returns {boolean} true when the model is usable.
   */
  function load(data) {
    if (
      !data ||
      data.featureVersion !== FEATURE_VERSION ||
      data.dim !== DIM ||
      !data.heads ||
      typeof data.heads !== "object"
    ) {
      live = null;
      return false;
    }
    // Decode every head up front; reject the whole model if any head is
    // malformed (a partly-usable model would score inconsistently).
    const heads = [];
    for (const cat of Object.keys(data.heads)) {
      const h = data.heads[cat];
      if (!h || typeof h.weights !== "string" || typeof h.bias !== "number") {
        live = null;
        return false;
      }
      heads.push({
        cat,
        weights: decodeWeights(h),
        bias: h.bias,
        // Per-head operating point tuned on held-out data by the trainer;
        // fall back to the global default for older/hand-built fixtures.
        minProb: typeof h.minProb === "number" ? h.minProb : MIN_PROB,
      });
    }
    if (heads.length === 0) {
      live = null;
      return false;
    }
    live = { heads };
    return true;
  }

  /** @returns {boolean} Whether a usable model is loaded. */
  function ready() {
    return live !== null;
  }

  /**
   * Score one text under EVERY head with a single feature pass.
   *
   * Feature extraction dominates the cost; the per-head dot products share it,
   * so five heads cost barely more than one.
   *
   * @param {string} raw Text as it appeared on the page.
   * @returns {Object<string, {p: number, minProb: number}>} Per-category
   *   probability + that head's tuned floor. Empty object when no model.
   */
  function scoreAll(raw) {
    const out = {};
    if (!live) return out;
    const idx = features(raw);
    if (idx.length === 0) return out;

    // Every present feature contributes the same `value`. Dividing by the
    // square root of the feature count normalizes the input so a long rant and
    // a short one-liner produce comparably-scaled sums (otherwise longer text
    // would pile up more weights and always look more extreme).
    const value = 1 / Math.sqrt(idx.length); // L2 norm of a binary vector
    for (let h = 0; h < live.heads.length; h += 1) {
      const head = live.heads[h];
      // `z` is the running weighted sum from the primer: start at the bias,
      // then add the weight of each feature slot (scaled by `value`).
      let z = head.bias;
      for (let i = 0; i < idx.length; i += 1) z += head.weights[idx[i]] * value;
      // The sigmoid: 1 / (1 + e^-z) squashes any real number z into (0, 1) so
      // we can read it as a probability.
      out[head.cat] = { p: 1 / (1 + Math.exp(-z)), minProb: head.minProb };
    }
    return out;
  }

  /**
   * Score one text: the STRONGEST head's probability. Kept for callers (and
   * the "Try it" panel) that want a single how-bad-is-this number.
   *
   * @param {string} raw Text as it appeared on the page.
   * @returns {number} Probability in (0, 1); 0 when no model is loaded.
   */
  function score(raw) {
    const all = scoreAll(raw);
    let max = 0;
    for (const cat in all) {
      if (all[cat].p > max) max = all[cat].p;
    }
    return max;
  }

  /**
   * Map a model probability to a scorer signal weight.
   *
   * Dead zone below MIN_PROB (an uncertain model says nothing), then a
   * linear ramp to MAX_WEIGHT. MAX_WEIGHT = 0.5 sits below every default
   * action threshold (0.55/0.6/0.7) BY DESIGN: on defaults, the model can
   * strengthen pattern evidence but can never act alone. Users who lower a
   * threshold under 0.5 are explicitly choosing to let it.
   *
   * @param {number} p Model probability.
   * @param {number} [minProb] Per-head floor (from the trainer's held-out
   *   tuning); defaults to the global MIN_PROB.
   * @returns {number} Evidence weight in [0, MAX_WEIGHT].
   */
  function signalWeight(p, minProb) {
    const floor = typeof minProb === "number" ? minProb : MIN_PROB;
    // Below the floor the model is too unsure to say anything.
    if (p < floor) return 0;
    // Linearly rescale p from the range [floor, 1] onto [0, MAX_WEIGHT]:
    // (p - floor) / (1 - floor) is 0 at the floor and 1 at p = 1, then
    // multiplying by MAX_WEIGHT caps the model's influence at that ceiling.
    return ((p - floor) / (1 - floor)) * MAX_WEIGHT;
  }

  /**
   * Probabilities below this contribute nothing.
   *
   * Chosen from the shipped model's held-out ROC (see docs/ML.md): 0.6 is
   * where overt hate mostly clears while ordinary posts almost never do. It
   * is a per-model operating point — retune it when retraining, and keep the
   * "clean text rarely clears the floor" test honest.
   */
  const MIN_PROB = 0.6;

  /** Ceiling on the model's evidence — below every default threshold. */
  const MAX_WEIGHT = 0.5;

  // The module's public surface: the constants and functions above are
  // returned here so callers reach them as VALYOU.ML.score(...), etc.
  return {
    DIM,
    FEATURE_VERSION,
    MIN_PROB,
    MAX_WEIGHT,
    fnv1a,
    features,
    decodeWeights,
    load,
    ready,
    score,
    scoreAll,
    signalWeight,
  };
});
