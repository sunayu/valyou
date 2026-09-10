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
 * Settings loading, validation, and persistence.
 *
 * Settings arrive from two untrusted-ish places: a decrypted record that may
 * predate the current schema, and the options page. Both go through
 * sanitize(), which is a whitelist: unknown keys are dropped and every value
 * is range-checked against the taxonomy. A settings record can therefore
 * never put the classifier into an undefined state, whatever is in storage.
 *
 * Secrets (reserved for the subscription license key) live in a *separate*
 * record from the rest of the settings. Both are encrypted, but keeping them
 * apart means the settings record can be read, logged, and exported for
 * support without ever touching a secret.
 *
 * ---------------------------------------------------------------------------
 * BEGINNER ORIENTATION
 *
 * The central idea here is SANITIZATION. Data coming from storage or from the
 * options form is untrusted: it may be an old shape from a previous version, or
 * missing fields, or hand-edited nonsense. Rather than trust it, sanitize()
 * rebuilds a fresh, known-good settings object -- starting from the defaults
 * and copying over only recognized keys after checking each one. This is a
 * WHITELIST (allow-known-good) rather than a blacklist (block-known-bad), which
 * is the safer default: anything not explicitly allowed is simply dropped.
 *
 * Two related techniques you'll see below:
 *   - CLAMPING: forcing a number into a valid range (see clampNumber) so a bad
 *     value can never push the classifier out of bounds.
 *   - DEFAULT-MERGING: start from a clone of the defaults, then overlay valid
 *     incoming values, so the result is always fully populated.
 *
 * This module leans on lib/store.js for all encrypted reads/writes; it never
 * talks to chrome.storage directly.
 */

// UMD/IIFE wrapper -- same pattern as store.js: run this function immediately
// to keep internals private, and expose the module either on the global
// VALYOU.Settings (browser) or via module.exports (Node tests).
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Settings = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // Strict mode -- see store.js; turns silent errors into thrown ones.
  "use strict";

  const scope = typeof self !== "undefined" ? self : globalThis;
  // Tiny helper: `require` the given path in Node, but return null in the
  // browser (where require does not exist and modules arrive via globals).
  const req = (p) => (typeof require === "function" ? require(p) : null);

  // Pull in sibling modules. In the browser these were attached to the global
  // VALYOU object by earlier scripts; in tests they are required from disk.
  // Taxonomy holds the canonical defaults and the lists of valid ids/actions.
  const Taxonomy = (scope.VALYOU && scope.VALYOU.Taxonomy) || req("./taxonomy.js");
  const Store = (scope.VALYOU && scope.VALYOU.Store) || req("./store.js");
  const Crypto = (scope.VALYOU && scope.VALYOU.Crypto) || req("./crypto.js");

  /** Deep clone via structured serialization; settings are plain JSON. */
  // Round-tripping through a JSON string produces a brand-new object with no
  // shared references to the original. WHY: we start from the defaults and then
  // mutate the copy, so we must not accidentally mutate the shared defaults.
  // This trick only works because settings contain nothing but plain JSON
  // (no functions, Dates, or undefined) -- which is true here.
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Clamp a number into a range, falling back when the input is not a finite
   * number (covers null, undefined, NaN, and strings from the options form).
   *
   * @param {*} value Candidate value.
   * @param {number} min Lower bound, inclusive.
   * @param {number} max Upper bound, inclusive.
   * @param {number} fallback Used when `value` is not numeric.
   * @returns {number}
   */
  function clampNumber(value, min, max, fallback) {
    // HTML form fields arrive as strings ("0.5"), so coerce those to numbers.
    const n = typeof value === "string" ? Number(value) : value;
    // Reject anything that is not a real, finite number. Number.isFinite is
    // false for NaN (what "abc" becomes) and for Infinity, so both are caught.
    if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
    // Clamp: Math.max(n, min) lifts n up to at least min, then Math.min(..., max)
    // caps it at max. The result is guaranteed to sit within [min, max].
    return Math.min(Math.max(n, min), max);
  }

  /**
   * Coerce to boolean, preserving an explicit false but falling back for
   * undefined so a newly added flag inherits its default.
   *
   * @param {*} value Candidate value.
   * @param {boolean} fallback Default.
   * @returns {boolean}
   */
  // WHY not just `value || fallback`? Because that would turn a deliberate
  // `false` into the fallback. We only fall back when the value is genuinely
  // not a boolean (e.g. undefined because the flag did not exist yet).
  function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  /**
   * Normalize a user-supplied list: strings only, trimmed, de-duplicated,
   * empties removed, and capped so a paste accident cannot bloat storage or
   * make the scorer's per-term loop pathological.
   *
   * @param {*} value Candidate list.
   * @param {number} [limit=500] Maximum entries kept.
   * @returns {string[]}
   */
  function stringList(value, limit = 500) {
    // If it isn't even an array, there is nothing usable -> empty list.
    if (!Array.isArray(value)) return [];
    // A Set remembers which entries we've already kept, giving fast O(1)
    // duplicate detection. We store the lowercased form as the dedupe "key".
    const seen = new Set();
    const out = [];
    for (const entry of value) {
      // Skip non-strings (numbers, objects, null) rather than coercing them.
      if (typeof entry !== "string") continue;
      // Trim surrounding whitespace; drop entries that are empty afterward.
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Case-insensitive dedupe: "Cats" and "cats" are treated as the same.
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Keep the original casing in the output; only the dedupe key is lowered.
      out.push(trimmed);
      // Hard cap so a giant paste cannot bloat storage or slow the scorer.
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Produce a fully-populated, in-range settings object from arbitrary input.
   * This is the only function allowed to construct settings; everything else
   * consumes its output.
   *
   * @param {*} input Possibly partial, possibly stale, possibly hostile.
   * @returns {object} Valid settings.
   */
  function sanitize(input) {
    const defaults = Taxonomy.DEFAULT_SETTINGS;
    // Guard against non-object input (null, a string, undefined). `src` is the
    // untrusted source we read FROM; if it isn't an object, treat it as empty.
    const src = input && typeof input === "object" ? input : {};
    // `out` starts as a full, valid copy of the defaults. We overlay only the
    // valid pieces of `src` on top -- so `out` is always completely populated.
    const out = clone(defaults);

    out.enabled = bool(src.enabled, defaults.enabled);
    out.showBadge = bool(src.showBadge, defaults.showBadge);

    // Categories: only known ids, only known actions, thresholds in 0..1.
    // We iterate over the KNOWN ids from the taxonomy (not over whatever keys
    // the input happens to have) -- that is the whitelist in action: unknown
    // category ids in `src` are never even looked at, so they cannot leak in.
    const categories = src.categories && typeof src.categories === "object" ? src.categories : {};
    for (const id of Taxonomy.CATEGORY_IDS) {
      const incoming = categories[id] || {};
      const fallback = defaults.categories[id];
      out.categories[id] = {
        // Accept the incoming action only if it is one of the recognized
        // ACTIONS; otherwise keep the default. Array.includes does the check.
        action: Taxonomy.ACTIONS.includes(incoming.action) ? incoming.action : fallback.action,
        // Threshold must be a probability in [0.05, 1]; clampNumber enforces it.
        threshold: clampNumber(incoming.threshold, 0.05, 1, fallback.threshold),
      };
    }

    // Same whitelist pattern for surface toggles: loop over the known surface
    // names and read each as a boolean, defaulting when absent/invalid.
    const surfaces = src.surfaces && typeof src.surfaces === "object" ? src.surfaces : {};
    for (const name of Taxonomy.SURFACES) {
      out.surfaces[name] = bool(surfaces[name], defaults.surfaces[name]);
    }

    const ml = src.ml && typeof src.ml === "object" ? src.ml : {};
    out.ml = { enabled: bool(ml.enabled, defaults.ml.enabled) };

    const media = src.media && typeof src.media === "object" ? src.media : {};
    const VIDEO_MODES = ["allow", "block", "hide"];
    // Migrate the pre-0.1 naming (normal/strict/always) so an upgrade keeps a
    // sensible equivalent rather than silently resetting.
    // `LEGACY[media.video]` looks up the old name; if there is no match it is
    // undefined, and `|| media.video` falls back to the value as-is.
    const LEGACY = { normal: "allow", strict: "block", always: "hide" };
    let video = LEGACY[media.video] || media.video;
    out.media = {
      // After migration, still validate against the allowed modes.
      video: VIDEO_MODES.includes(video) ? video : defaults.media.video,
      flaggedVideoBlur: bool(media.flaggedVideoBlur, defaults.media.flaggedVideoBlur),
    };

    // User-authored allow/block lists get the full stringList() scrub.
    const rules = src.rules && typeof src.rules === "object" ? src.rules : {};
    out.rules = {
      allowAuthors: stringList(rules.allowAuthors),
      blockTerms: stringList(rules.blockTerms),
      allowTerms: stringList(rules.allowTerms),
    };

    const security = src.security && typeof src.security === "object" ? src.security : {};
    out.security = {
      // Two encryption modes exist (detailed in crypto.js): "device" derives a
      // non-exportable key bound to this browser install, while "passphrase"
      // wraps the data key under a password the user types. We accept only the
      // exact string "passphrase"; anything else defaults to the safer "device"
      // mode -- so a garbled value can never silently disable protection.
      keyMode: security.keyMode === "passphrase" ? "passphrase" : "device",
      // Floor of 210,000 is OWASP's minimum for PBKDF2-SHA-256; refuse to
      // persist anything weaker even if an older record asks for it. Math.round
      // guarantees a whole number of iterations.
      kdfIterations: Math.round(
        clampNumber(security.kdfIterations, 210000, 4000000, defaults.security.kdfIterations)
      ),
    };

    return out;
  }

  /**
   * Load settings from encrypted storage, sanitized and ready to use.
   *
   * @returns {Promise<object>} Valid settings; defaults when nothing stored.
   */
  async function load() {
    // Store.get decrypts the settings record (or returns null if absent). We
    // ALWAYS pass it through sanitize -- even trusted-looking stored data may
    // be from an older schema, so sanitize is the single source of validity.
    const stored = await Store.get(Taxonomy.RECORDS.SETTINGS, null);
    return sanitize(stored);
  }

  /**
   * Persist settings after sanitizing them.
   *
   * @param {object} next Candidate settings.
   * @returns {Promise<object>} What was actually written.
   */
  async function save(next) {
    // Sanitize on the way IN too, not just on the way out. This is defense in
    // depth: whatever the options page sends, only a validated object is ever
    // encrypted and stored. We return the cleaned object so callers can render
    // exactly what was persisted (which may differ from what they submitted).
    const clean = sanitize(next);
    await Store.set(Taxonomy.RECORDS.SETTINGS, clean);
    return clean;
  }

  /**
   * Read a value from the encrypted secrets record.
   *
   * Currently unused by any feature; it is the storage slot the subscription
   * license key will live in. Kept (and tested) so license activation later
   * is purely UI work on top of an already-hardened path.
   *
   * @param {string} name Secret name.
   * @returns {Promise<string|null>} The value, or null when unset.
   */
  async function getSecret(name) {
    // Secrets live in their OWN encrypted record, separate from settings, so
    // settings can be exported for support without exposing any secret.
    const secrets = await Store.get(Taxonomy.RECORDS.SECRETS, null);
    // Return the named secret only if it exists and is a string; else null.
    return secrets && typeof secrets[name] === "string" ? secrets[name] : null;
  }

  /**
   * Store or clear a value in the encrypted secrets record.
   *
   * @param {string} name Secret name.
   * @param {string|null} value The value, or null to remove it.
   * @returns {Promise<void>}
   */
  async function setSecret(name, value) {
    // Read-modify-write: load the existing secrets object, or start a fresh {}
    // if none is stored yet.
    const secrets = (await Store.get(Taxonomy.RECORDS.SECRETS, null)) || {};
    // Passing an empty-ish value means "remove this secret".
    if (value === null || value === undefined || value === "") {
      delete secrets[name];
    } else {
      // Coerce to a string so the stored shape stays predictable.
      secrets[name] = String(value);
    }
    // Object.keys(secrets).length is the count of remaining secrets. If none
    // are left, delete the whole record entirely rather than storing an empty
    // object -- less to leak, and a cleaner "no secrets" state.
    if (Object.keys(secrets).length === 0) {
      await Store.remove(Taxonomy.RECORDS.SECRETS);
    } else {
      await Store.set(Taxonomy.RECORDS.SECRETS, secrets);
    }
  }

  /**
   * Fetch (creating on first run) the per-installation metadata: a random
   * install id (which subscription licensing can bind an activation to) and
   * a random salt available to any future feature that fingerprints content.
   *
   * @returns {Promise<{installId: string, hashSalt: string, createdAt: number}>}
   */
  async function getInstall() {
    // Return the existing metadata if it's already been created once.
    const existing = await Store.get(Taxonomy.RECORDS.INSTALL, null);
    if (existing && existing.hashSalt) return existing;

    // First run: mint random identifiers. randomHex(n) yields n random bytes as
    // a hex string (cryptographically strong). installId can anchor a license
    // activation; hashSalt is a per-install salt for any future hashing.
    const fresh = {
      installId: Crypto.randomHex(16),
      hashSalt: Crypto.randomHex(32),
      createdAt: Date.now(),
    };
    await Store.set(Taxonomy.RECORDS.INSTALL, fresh);
    return fresh;
  }

  // Public surface of the module. The `_`-prefixed entries are internal helpers
  // exposed only so the test suite can exercise them directly; treat them as
  // private everywhere else.
  return {
    sanitize,
    load,
    save,
    getSecret,
    setSecret,
    getInstall,
    // exported for tests
    _clampNumber: clampNumber,
    _stringList: stringList,
  };
});
