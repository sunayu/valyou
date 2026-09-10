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
 * The on-device classifier and the decision rules built on top of it.
 *
 * This runs synchronously on every candidate unit before anything is painted,
 * which is what makes valyou feel instant: a post that trips a signal is
 * hidden in the same frame it appears. There is no network round trip
 * anywhere in the product — this classifier IS the product.
 *
 * SCORE COMBINATION
 * Hits are combined with a noisy-OR:  score = 1 - Π(1 - wᵢ)
 * rather than a sum. Summing lets three weak signals (0.4 each) manufacture a
 * false certainty of 1.2 → clamped to 1.0. Noisy-OR gives 0.78, which reads
 * correctly as "quite likely, not certain" and keeps a single strong signal
 * dominant over a pile of weak ones.
 *
 * NOISY-OR IN PLAIN WORDS. Read each weight wᵢ as "the probability THIS signal
 * alone is right". Then `1 - wᵢ` is the chance it is wrong, `Π(1 - wᵢ)` (Π is
 * "multiply them all together") is the chance EVERY signal is wrong at once,
 * and `1 - that` is the chance at least one is right — the combined score. Two
 * consequences worth internalizing:
 *   - The score can only ever climb toward 1, never past it, so it always stays
 *     a valid 0..1 confidence no matter how many signals pile on.
 *   - One strong signal dominates: a single 0.9 already forces the score to at
 *     least 0.9, whereas a heap of 0.3s creeps up only slowly. That is exactly
 *     the behavior we want from "evidence".
 *
 * WHAT THIS FILE EXPORTS. Two jobs, cleanly separated:
 *   1. scoreText() — run the lexicon patterns over a post and produce a per-
 *      category confidence score plus a list of which signals fired.
 *   2. decide()    — turn those scores into an ACTION (off / tag / blur / hide)
 *      by comparing them against the user's per-category thresholds and settings.
 * Keeping "how likely is this bad" separate from "what should we do about it"
 * means the same scores can drive different policies without rescoring.
 */

// UMD/IIFE wrapper — identical in spirit to the one atop lexicon.js: run the
// factory once and publish the result as `VALYOU.Scorer` (for browser/worker
// script tags) and as `module.exports` (for Node's require). See lexicon.js for
// the line-by-line breakdown of this pattern.
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Scorer = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Resolve sibling modules in BOTH worlds. In a browser/worker the sibling
  // modules have already attached themselves to `VALYOU` on the global object,
  // so we read them from `scope`. In Node there is no shared global, so we fall
  // back to `require`. `req` is a tiny helper that calls `require` only when it
  // exists (it does not in the browser), returning null otherwise.
  const scope = typeof self !== "undefined" ? self : globalThis;
  const req = (p) => (typeof require === "function" ? require(p) : null);

  // Text  — normalization/deobfuscation helpers (see text.js).
  // Lexicon — the pattern data from lexicon.js.
  // Taxonomy — the list of category ids and their display labels.
  const Text = (scope.VALYOU && scope.VALYOU.Text) || req("./text.js");
  const Lexicon = (scope.VALYOU && scope.VALYOU.Lexicon) || req("./lexicon.js");
  const Taxonomy = (scope.VALYOU && scope.VALYOU.Taxonomy) || req("./taxonomy.js");
  // Optional. Present in the worker/content-script bundles where a model is
  // loaded; absent (or model-less) is fine — the classifier is fully
  // functional on patterns alone, and the ML assist is strictly additive.
  const ML = (scope.VALYOU && scope.VALYOU.ML) || (typeof require === "function" ? req("./ml.js") : null);

  /**
   * Ranking used when several categories trip at once; higher wins.
   * The numbers give the four possible actions a strict order so decide() can
   * compare them arithmetically: "hide" (3) is stricter than "blur" (2), which
   * beats "tag" (1), which beats doing nothing, "off" (0).
   */
  const ACTION_SEVERITY = { off: 0, tag: 1, blur: 2, hide: 3 };

  /**
   * Below this many characters there is not enough signal to judge.
   * Very short strings ("lol", an emoji, a bare "no") cannot be classified
   * reliably and are far more likely to yield false positives, so scoreText
   * bails out early on them (returning tooShort: true) rather than guessing.
   */
  const MIN_LENGTH = 8;

  /**
   * Start an all-zero score object keyed by category id.
   *
   * @returns {Object<string, number>}
   */
  function emptyScores() {
    const scores = {};
    for (const id of Taxonomy.CATEGORY_IDS) scores[id] = 0;
    return scores;
  }

  /**
   * Fold one piece of evidence into a category score using noisy-OR.
   *
   * This is the noisy-OR formula from the file header applied ONE signal at a
   * time. Because `1 - (1 - old) * (1 - w)` is mathematically the same whether
   * you fold weights in one by one or multiply them all at once, scoreText can
   * just call this for each pattern that fires and the running score in
   * `scores[category]` ends up correct. The `if (!(category in scores))` guard
   * silently ignores a weight aimed at a category that does not exist, so a
   * typo in a pattern's `categories` list can never crash scoring.
   *
   * NOTE: `scores` is MUTATED IN PLACE (JavaScript objects are passed by
   * reference), so there is no return value — the caller sees the update.
   *
   * @param {Object<string, number>} scores Accumulator, mutated in place.
   * @param {string} category Category id.
   * @param {number} weight Evidence strength in 0..1.
   */
  function combine(scores, category, weight) {
    if (!(category in scores)) return;
    scores[category] = 1 - (1 - scores[category]) * (1 - weight);
  }

  /**
   * Score a single piece of text with the local classifier.
   *
   * @param {string} raw Text exactly as it appeared on the page.
   * @param {object} [rules] Optional user rules ({blockTerms, allowTerms}).
   * @returns {{scores: Object<string, number>, signals: Array<{id:string, why:string, weight:number}>, max: number, top: string|null, tooShort: boolean}}
   */
  function scoreText(raw, rules) {
    // `scores` accumulates a 0..1 confidence per category (all start at 0);
    // `signals` collects a record of every pattern that fired, for the UI/tests.
    const scores = emptyScores();
    const signals = [];

    // Two DIFFERENT preprocessed views of the same text, each suited to a job:
    //   normalized — light cleanup that PRESERVES word boundaries, so the
    //                `\b`-anchored templates and phrase patterns still work.
    //   folded     — aggressive deobfuscation (leetspeak undone, letter-spacing
    //                welded back together) used for slurs, where evasion is the
    //                whole problem. Computed lazily, only after the length gate.
    const normalized = Text.normalize(raw);
    // Early exit: too little text to judge. Returns a well-formed result with
    // tooShort:true so callers can distinguish "clean" from "not evaluated".
    if (normalized.length < MIN_LENGTH) {
      return { scores, signals, max: 0, top: null, tooShort: true };
    }
    const folded = Text.deobfuscate(raw);

    // 1. Slurs — matched against the deobfuscated form so spacing and
    //    leetspeak evasion ("n i g g e r", "f4gg0t") does not slip through.
    //
    // Loop idiom used throughout: `for (const pattern of LIST)` walks each
    // pattern object; `pattern.re.test(text)` returns true/false for a match;
    // `if (!match) continue;` skips to the next pattern when this one misses.
    // On a hit we fold the weight into EVERY category the pattern names, then
    // record a signal. `.push(...)` appends to the signals array.
    for (const pattern of Lexicon.SLUR_PATTERNS) {
      if (!pattern.re.test(folded)) continue;
      for (const category of pattern.categories) combine(scores, category, pattern.weight);
      signals.push({ id: "slur", why: "Contains a slur", weight: pattern.weight });
    }

    // 2. Structural templates — matched against the conservative form, which
    //    still has the word boundaries the phrase patterns depend on.
    for (const pattern of Lexicon.TEMPLATE_PATTERNS) {
      if (!pattern.re.test(normalized)) continue;
      for (const category of pattern.categories) combine(scores, category, pattern.weight);
      signals.push({ id: pattern.id, why: pattern.why, weight: pattern.weight });
    }

    // 2b. Dogwhistles and coded hate — checked against BOTH normalized forms,
    //     because these phrases are exactly the vocabulary people obfuscate
    //     ("wh1te p0wer") when they suspect a filter is watching.
    for (const pattern of Lexicon.DOGWHISTLE_PATTERNS) {
      if (!pattern.re.test(normalized) && !pattern.re.test(folded)) continue;
      for (const category of pattern.categories) combine(scores, category, pattern.weight);
      signals.push({ id: pattern.id, why: pattern.why, weight: pattern.weight });
    }

    // 3. Rage bait — lexical markers plus two typographic ones.
    for (const pattern of Lexicon.RAGE_BAIT_PATTERNS) {
      if (!pattern.re.test(normalized)) continue;
      combine(scores, "rage_bait", pattern.weight);
      signals.push({ id: pattern.id, why: pattern.why, weight: pattern.weight });
    }

    // Sustained shouting only counts on text long enough for it to be a
    // deliberate style choice rather than a short "OMG" or an acronym.
    const caps = Text.capsRatio(raw);
    if (raw.length > 60 && caps > 0.6) {
      combine(scores, "rage_bait", 0.3);
      signals.push({ id: "all_caps", why: "Mostly written in capitals", weight: 0.3 });
    }
    const bursts = Text.punctuationBursts(raw);
    if (bursts >= 3) {
      combine(scores, "rage_bait", 0.2);
      signals.push({ id: "punct_burst", why: "Heavy '!!!' / '???' punctuation", weight: 0.2 });
    }

    // 3b. ML assist. A loaded model contributes ONE signal, spread across the
    //     hate/harassment categories, capped below every default threshold
    //     (see ml.js#signalWeight) so it can never act alone — only reinforce
    //     pattern evidence. The on/off setting is enforced at LOAD time: when
    //     disabled the model is never loaded, so ready() is false here. That
    //     keeps the hot path a single branch with no settings plumbing.
    if (ML && ML.ready()) {
      const p = ML.score(raw);
      const w = ML.signalWeight(p);
      if (w > 0) {
        // The corpus target is "hate speech" broadly; distribute the evidence
        // to the categories the model was trained to recognize rather than
        // pretending it can tell racial from gendered hate.
        combine(scores, "hate_racial", w);
        combine(scores, "hate_gender", w);
        combine(scores, "harassment", w);
        signals.push({
          id: "ml_assist",
          why: `Language model flagged this as likely hateful (${Math.round(p * 100)}%)`,
          weight: w,
        });
      }
    }

    // 4. User-authored block terms are treated as strong, near-conclusive
    //    evidence: the user asked for these specifically.
    const blockTerms = (rules && rules.blockTerms) || [];
    for (const term of blockTerms) {
      const needle = Text.normalize(term);
      if (needle.length < 2) continue;
      if (normalized.includes(needle) || folded.includes(Text.deobfuscate(term))) {
        combine(scores, "harassment", 0.95);
        signals.push({ id: "user_block_term", why: `Matched your blocked term "${term}"`, weight: 0.95 });
      }
    }

    // 5. Mitigators. Applied multiplicatively at the end so they scale back
    //    every category at once — a post that quotes a slur in order to
    //    condemn it should not be filtered as if it authored the slur.
    //
    // `mitigation` is built up with the SAME noisy-OR combine as the harm
    // signals (several mitigators compound toward, but never past, 1.0). It is
    // then turned into a damping MULTIPLIER below. Signals from mitigators are
    // pushed with a NEGATIVE weight purely as a UI marker — the minus sign is
    // how describe()/the overlay tell "this lowered the score" from "this
    // raised it"; the actual arithmetic uses `pattern.weight` (positive) here.
    let mitigation = 0;
    for (const pattern of Lexicon.MITIGATOR_PATTERNS) {
      if (!pattern.re.test(normalized)) continue;
      mitigation = 1 - (1 - mitigation) * (1 - pattern.weight);
      signals.push({ id: pattern.id, why: pattern.why, weight: -pattern.weight });
    }
    // A user's own allow-terms act as an extra mitigator at a fixed 0.6 weight.
    // `(rules && rules.allowTerms) || []` is the common JS guard for "use this
    // array if it exists, otherwise an empty one" so the loop is always safe.
    const allowTerms = (rules && rules.allowTerms) || [];
    for (const term of allowTerms) {
      const needle = Text.normalize(term);
      // `>= 2` avoids 1-character noise; `.includes(needle)` is a plain
      // substring test (no regex) since a user term is a literal, not a pattern.
      if (needle.length >= 2 && normalized.includes(needle)) {
        mitigation = 1 - (1 - mitigation) * (1 - 0.6);
        signals.push({ id: "user_allow_term", why: `Matched your allowed term "${term}"`, weight: -0.6 });
      }
    }
    // Cap mitigation at 70%: even a well-intentioned frame around an explicit
    // slur should still leave enough score to warrant a blur.
    // `Math.min(mitigation, 0.7)` clamps to at most 0.7, so `damping` (the
    // multiplier applied to every score) never drops below 0.3 — i.e. at most
    // 70% of the score can be shaved off, never all of it.
    const damping = 1 - Math.min(mitigation, 0.7);
    // Scale every category by the same damping factor and round for clean
    // storage/comparison. This is why mitigators are computed once at the end
    // rather than per-signal: one uniform pass keeps them a true global brake.
    for (const id of Taxonomy.CATEGORY_IDS) scores[id] = round(scores[id] * damping);

    const { top, max } = peak(scores);
    return { scores, signals, max, top, tooShort: false };
  }

  /**
   * Find the highest-scoring category.
   *
   * @param {Object<string, number>} scores
   * @returns {{top: string|null, max: number}}
   */
  function peak(scores) {
    // Classic max-finding scan: walk every entry, remember the biggest seen.
    // `Object.entries(scores)` turns the {id: value} object into an array of
    // [id, value] pairs, and `for (const [id, value] of ...)` destructures each
    // pair into its two parts. Ties keep the FIRST category seen (strictly
    // greater-than), which follows Taxonomy's declared order.
    let top = null;
    let max = 0;
    for (const [id, value] of Object.entries(scores)) {
      if (value > max) {
        max = value;
        top = id;
      }
    }
    return { top, max };
  }

  /**
   * Round to three decimals so scores serialize compactly and compare cleanly.
   * `Math.round(value * 1000) / 1000` is the standard "round to N decimals"
   * trick: shift three places left, round to an integer, shift back.
   */
  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  /**
   * Turn scores into an action, honouring per-category thresholds, the author
   * allowlist, and the video-handling mode.
   *
   * When several categories exceed their thresholds the strictest action wins
   * (hide > blur > tag), and the reported category is the strictest one's
   * highest scorer — so the explanation a user sees matches what was done.
   *
   * Video: in "hide" mode a video unit that nothing else already filtered is
   * blurred behind a click, treating all video as suspect. ("block" mode does
   * not blur the post — it only stops autoplay, which is enforced in the
   * content script's play guard, not here.) Allowlisted authors bypass all of
   * this — trusting a person means trusting their videos too.
   *
   * @param {Object<string, number>} scores Category scores.
   * @param {object} settings Full settings object.
   * @param {{author?: string, signals?: Array, hasVideo?: boolean}} [context] Extra context.
   * @returns {{action: string, category: string|null, score: number, reason: string}}
   */
  function decide(scores, settings, context) {
    const ctx = context || {};

    // Allowlisted authors bypass everything. This is checked here rather than
    // at extraction time so the reason string can say why nothing happened.
    const allowAuthors = (settings.rules && settings.rules.allowAuthors) || [];
    if (ctx.author) {
      const author = Text.normalize(ctx.author);
      // `.some(fn)` returns true if ANY allow-listed name, once normalized,
      // equals this author — a case/format-insensitive membership test.
      if (allowAuthors.some((a) => Text.normalize(a) === author)) {
        return { action: "off", category: null, score: 0, reason: "Author is on your allow list" };
      }
    }

    const videoMode = (settings.media && settings.media.video) || "block";

    // `best` holds the winning decision so far; it starts as "do nothing" and is
    // only replaced by a stricter/higher-scoring category as the loop proceeds.
    let best = { action: "off", category: null, score: 0, reason: "" };

    for (const id of Taxonomy.CATEGORY_IDS) {
      const config = settings.categories[id];
      // Skip categories the user disabled entirely.
      if (!config || config.action === "off") continue;
      const score = scores[id] || 0;
      // Skip categories whose confidence did not clear the user's threshold for
      // that category — this per-category threshold is the main sensitivity dial.
      if (score < config.threshold) continue;

      // Map both actions onto the 0..3 severity scale so they can be compared.
      const severity = ACTION_SEVERITY[config.action];
      const bestSeverity = ACTION_SEVERITY[best.action];
      // Strictest action wins; ties broken by the higher score.
      if (severity > bestSeverity || (severity === bestSeverity && score > best.score)) {
        best = {
          action: config.action,
          category: id,
          score,
          reason: describe(id, ctx.signals),
        };
      }
    }

    // Flagged videos blur rather than collapse. When a video post trips a
    // category, present it as a frosted click-to-reveal shield instead of a
    // collapsed bar (hide) or a bare label (tag) — blur is the natural media
    // treatment and still requires a click to see. Keeps the category reason
    // so the user knows why. Default on; the user can turn it off to let a
    // video obey its category's action.
    // `!== false` makes this default-ON: the feature is enabled unless the
    // setting is EXPLICITLY the boolean false. Missing/undefined therefore
    // counts as "on", which is the intended default.
    const flaggedBlur = !settings.media || settings.media.flaggedVideoBlur !== false;
    if (
      ctx.hasVideo &&
      flaggedBlur &&
      best.action !== "off" &&
      best.action !== "blur"
    ) {
      best = { action: "blur", category: best.category, score: best.score, reason: best.reason };
    }

    // "hide": treat ALL video as suspect. If text signals did not already
    // filter this unit, still gate it behind a click. Blur (not hide-collapse)
    // so the user keeps a one-click way to watch it deliberately.
    if (ctx.hasVideo && videoMode === "hide" && ACTION_SEVERITY[best.action] < ACTION_SEVERITY.blur) {
      best = {
        action: "blur",
        category: best.category,
        score: best.score,
        reason: "Video hidden until you choose to play it",
      };
    }

    return best;
  }

  /**
   * Should this video's play attempt be blocked (paused) right now?
   *
   * Pure decision function so the autoplay logic is testable without a DOM.
   * The rule that makes "click to play" work in block mode is the user-
   * activation check: autoplay fires with no user gesture, a real click
   * carries one. Once approved (the user chose to watch), it plays freely.
   *
   * @param {string} videoMode The `media.video` setting.
   * @param {{approved: boolean, userActivated: boolean}} state Video state.
   * @returns {boolean} true to pause this play attempt.
   */
  function blocksAutoplay(videoMode, state) {
    if (videoMode !== "block" && videoMode !== "hide") return false;
    if (state.approved) return false; // user already chose to watch this one
    if (state.userActivated) return false; // this play came from a real click
    return true; // autoplay with no gesture — stop it
  }

  /**
   * Build the human-readable explanation shown on the shield overlay.
   *
   * @param {string} categoryId Category that triggered.
   * @param {Array<{why:string, weight:number}>} [signals] Signals from scoreText.
   * @returns {string} One-line explanation.
   */
  function describe(categoryId, signals) {
    // Look up the human label for this category id (`.find` returns the first
    // matching entry, or undefined); fall back to the raw id if none is found.
    const category = Taxonomy.CATEGORIES.find((c) => c.id === categoryId);
    const label = category ? category.label : categoryId;
    // Keep only the harm signals (positive weight); drop mitigators (negative)
    // — the user wants to know what got the post flagged, not what argued for it.
    const positive = (signals || []).filter((s) => s.weight > 0);
    if (positive.length === 0) return label;
    // Lead with the strongest signal — that is the one that actually decided it.
    // `.sort((a, b) => b.weight - a.weight)` orders by weight DESCENDING: a
    // positive result means `a` goes after `b`, so the heaviest weight lands at
    // index 0. Then quote that top signal's `why`.
    positive.sort((a, b) => b.weight - a.weight);
    return `${label} — ${positive[0].why}`;
  }

  // Public surface of the Scorer module. Constants and the smaller helpers are
  // exported alongside the two headline functions (scoreText, decide) so the
  // test suite can exercise each piece in isolation.
  return {
    MIN_LENGTH,
    ACTION_SEVERITY,
    emptyScores,
    scoreText,
    decide,
    describe,
    peak,
    blocksAutoplay,
  };
});
