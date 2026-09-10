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
 * The moderation taxonomy and the shape of user settings.
 *
 * This module is the single source of truth for what valyou can detect and
 * what the defaults are. The scorer, the settings validation, and every UI
 * surface are generated from CATEGORIES, so adding a category here propagates
 * everywhere instead of drifting.
 */

/*
 * UMD / IIFE WRAPPER (for beginners).
 *
 * The whole file is a function that is DEFINED and immediately CALLED (an
 * "Immediately Invoked Function Expression"). This keeps the data below out of
 * the global scope and lets one file load in both a browser and Node — the
 * "Universal Module Definition" (UMD) pattern. See src/lib/text.js for a longer
 * walk-through; this file uses the exact same wrapper.
 *
 *   - `root`    = the global object (chosen on the last line: `self` in a
 *                 browser/worker, else `globalThis`).
 *   - `factory` = the second function, which builds and returns the module.
 */
(function (root, factory) {
  const mod = factory(); // run the factory once to build the module object
  // "Get-or-create" the shared namespace: `||` keeps an existing VALYOU object
  // if one is there, otherwise starts a fresh `{}` — so sibling modules coexist.
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Taxonomy = mod;
  // In Node, `module`/`module.exports` exist and this makes `require()` work.
  // The `typeof module !== "undefined"` guard avoids a crash in the browser,
  // where `module` is not defined.
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  // Arguments passed to the wrapper above: pick the global object, then the
  // factory. `a ? b : c` is the ternary (inline if/else) operator.
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict"; // stricter parsing: turns silent mistakes into thrown errors

  /**
   * Categories of content valyou can act on.
   *
   * `id`          stable key used in settings and stats records.
   * `label`       human-facing name in the options and popup UI.
   * `description` the written definition of the category, shown in the UI.
   */
  // An array `[ ... ]` of objects `{ ... }`. Each object is one category record.
  // Order matters: it is the display order used throughout the UI.
  const CATEGORIES = [
    {
      id: "hate_racial",
      label: "Racism & ethnic/religious hate",
      description:
        "Content attacking, dehumanizing, demeaning, or promoting hatred toward people because of race, ethnicity, national origin, immigration status, or religion. Includes racial slurs used as attacks, dehumanizing comparisons, and racial conspiracy narratives.",
    },
    {
      id: "hate_gender",
      label: "Sexism & gender-based hate",
      description:
        "Content demeaning, objectifying, or promoting hatred toward people because of sex, gender, gender identity, or sexual orientation. Includes misogynistic and homophobic/transphobic slurs, and claims that a gender is inherently inferior.",
    },
    {
      id: "violence",
      label: "Violence & threats",
      description:
        "Threats of violence, calls for violence, glorification or celebration of violence against people or groups, and graphic descriptions of violence presented approvingly. Includes incitement framed as a joke.",
    },
    {
      id: "harassment",
      label: "Harassment & targeted abuse",
      description:
        "Sustained insults, degradation, mockery, or intimidation aimed at a specific person, including pile-ons, sexual harassment, and demeaning name-calling.",
    },
    {
      id: "rage_bait",
      label: "Rage bait & outrage farming",
      description:
        "Content engineered primarily to provoke anger or tribal hostility rather than to inform: inflammatory framing of out-groups, manufactured outrage, engagement-bait demands to share/react out of anger, and deliberately divisive provocation.",
    },
  ];

  /** Convenience: the category id strings, in display order. */
  // `.map` builds a NEW array by running the given function on every element.
  // `(c) => c.id` is an arrow function that takes one category object `c` and
  // returns just its `id`, so we get e.g. ["hate_racial", "hate_gender", ...].
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

  /**
   * What valyou does when a unit trips a threshold.
   *
   * hide    - collapse the unit to a one-line bar with an "undo" link.
   * blur    - keep layout, blur the content behind a click-to-reveal shield.
   * tag     - leave content visible, attach a small labelled badge.
   * off     - never act on this category.
   */
  const ACTIONS = ["hide", "blur", "tag", "off"];

  /**
   * Page surfaces valyou scans. Each can be toggled independently, because
   * users often want aggressive filtering on the public feed but a lighter
   * touch on messages from people they chose to talk to.
   */
  const SURFACES = ["feed", "comments", "ads", "messages", "reels"];

  /**
   * Default settings. Deliberately conservative: harassment and rage bait —
   * the two most subjective categories — default to `blur` rather than `hide`
   * so nothing silently disappears until the user has seen how the filter
   * performs and tuned it.
   */
  const DEFAULT_SETTINGS = {
    enabled: true,

    /** Per-category action and sensitivity. */
    categories: {
      hate_racial: { action: "hide", threshold: 0.55 },
      hate_gender: { action: "hide", threshold: 0.55 },
      violence: { action: "hide", threshold: 0.55 },
      harassment: { action: "blur", threshold: 0.6 },
      rage_bait: { action: "blur", threshold: 0.7 },
    },

    /** Which parts of the page to scan. */
    surfaces: {
      feed: true,
      comments: true,
      ads: true,
      messages: true,
      reels: true,
    },

    /**
     * The on-device ML assist. A small linear model (see lib/ml.js) that
     * generalizes past the pattern lexicon. Capped so it can never filter
     * anything on its own — it only reinforces pattern evidence — which is
     * why it is safe to default on. Purely local; no network, as ever.
     */
    ml: {
      enabled: true,
    },

    /**
     * How to treat videos.
     *
     * A text-only classifier cannot see what a video shows, so a hateful
     * video under a clean caption would otherwise autoplay in your face.
     * These modes control that directly:
     *
     *   "allow" — videos autoplay; filtered only on their text signals.
     *   "block" — no video autoplays. The video stays visible but paused and
     *             muted until you click it to play (a real user click is
     *             always honoured). Posts are still filtered on text.
     *   "hide"  — every video is covered behind a click-to-play, treating all
     *             video as suspect: nothing plays, and nothing is even shown,
     *             until you deliberately select it. DEFAULT — the user asked
     *             for all videos blocked until chosen, and one click reveals
     *             and plays the selected video.
     *
     * Both "block" and "hide" guarantee nothing autoplays; "hide" additionally
     * covers the video so you must choose it before it (or its still frame)
     * appears.
     */
    media: {
      video: "hide",
      /**
       * When a video post is flagged by the classifier, present it as a
       * frosted click-to-reveal blur rather than obeying the category's action
       * (which for hate/violence is a collapse-to-bar "hide"). Blur is the
       * natural treatment for media — you see something is there and choose to
       * reveal it — and it still requires a click. Default on.
       */
      flaggedVideoBlur: true,
    },

    /** User-authored rules, applied before anything else. */
    rules: {
      /** Authors whose content is never filtered (case-insensitive). */
      allowAuthors: [],
      /** Extra terms that force a match, one per line in the UI. */
      blockTerms: [],
      /** Terms that suppress a match, for reclaiming false positives. */
      allowTerms: [],
    },

    /** Storage-at-rest configuration. See lib/crypto.js. */
    security: {
      /**
       * "device"     - data key lives non-extractable in IndexedDB; no prompt.
       * "passphrase" - data key is wrapped by a PBKDF2 key derived from a
       *                passphrase and must be unlocked each browser session.
       */
      keyMode: "device",
      /** PBKDF2 iteration count used in passphrase mode. */
      kdfIterations: 600000,
    },

    /** Show a small counter badge on the toolbar icon. */
    showBadge: true,
  };

  /**
   * Storage record identifiers. Also used as AAD when encrypting.
   *
   * SECRETS is reserved for the subscription license key: the encrypted
   * storage path for it already exists and is tested, so wiring up license
   * activation later is a UI task, not a security one.
   */
  // "AAD" = Additional Authenticated Data: a label mixed into encryption so a
  // record encrypted as (say) "settings" cannot be silently swapped in for
  // "secrets". These constant strings are that label AND the storage key name.
  const RECORDS = {
    SETTINGS: "settings",
    SECRETS: "secrets",
    STATS: "stats",
    INSTALL: "install",
    WRAPPED_KEY: "wrappedKey",
  };

  // The factory returns this module's PUBLIC API. Only these names are exposed
  // to the rest of the extension. `{ CATEGORIES }` is shorthand for
  // `{ CATEGORIES: CATEGORIES }` (ES2015 object property shorthand).
  return {
    CATEGORIES,
    CATEGORY_IDS,
    ACTIONS,
    SURFACES,
    DEFAULT_SETTINGS,
    RECORDS,
  };
});
