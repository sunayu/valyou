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
 * Text normalization and fingerprinting utilities.
 *
 * Everything the classifier sees passes through here first. Two separate
 * normalized forms are produced because they serve different jobs:
 *
 *   normalize()    - conservative cleanup (case, Unicode form, whitespace).
 *                    Preserves word boundaries, so phrase and template
 *                    patterns still match ("all X are Y").
 *   deobfuscate()  - aggressive cleanup that additionally folds leetspeak,
 *                    strips intra-word separators, and squashes character
 *                    repetition. This defeats the usual evasion tricks
 *                    (f.u.c.k, k1ll, hellooooo) but destroys word boundaries,
 *                    so it is only used for single-term matching.
 *
 * Loaded as a classic script in three environments (extension service worker,
 * content script isolated world, and Node's test runner), so it uses a small
 * UMD-style wrapper rather than ES module syntax.
 */

/*
 * UMD / IIFE WRAPPER (for beginners).
 *
 * This whole file is one big "Immediately Invoked Function Expression" (IIFE):
 * we DEFINE a function `(function (root, factory) { ... })` and then CALL it
 * right away by passing arguments in the trailing `(...)`. Wrapping code this
 * way keeps our helper variables private instead of leaking into the global
 * scope, and it lets the SAME file work in a browser and in Node without
 * changes (this is the "UMD" — Universal Module Definition — pattern).
 *
 * Reading the two argument groups at the bottom tells you what `root` and
 * `factory` are:
 *   - `root`    = the global object, chosen at call time (see the very last
 *                 lines): `self` in a browser/worker, else `globalThis`.
 *   - `factory` = the second function below; calling it BUILDS and returns the
 *                 module's public object (`mod`).
 *
 * The body then publishes that object two ways so every environment can import
 * it: attached to `window.VALYOU.Text` for the browser, and to `module.exports`
 * for Node's `require()`.
 */
(function (root, factory) {
  const mod = factory(); // run the factory once to build the module object
  // `root.VALYOU || {}` means "reuse the existing namespace if present, else
  // start a fresh empty object". `||` returns its first truthy operand, so this
  // is the classic "get-or-create" idiom and avoids clobbering a sibling module.
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Text = mod;
  // In Node, `module` exists and this exposes the module to `require()`. In the
  // browser `module` is undefined, so `typeof module !== "undefined"` guards
  // against a ReferenceError before we ever touch `module.exports`.
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  // The two arguments below are what `root` and `factory` receive:
  //   - `typeof self !== "undefined" ? self : globalThis` picks the right global
  //     object; `self` exists in browsers/service workers, `globalThis` is the
  //     portable fallback (e.g. Node).
  //   - the trailing `function () { ... }` is the `factory` that builds everything.
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict"; // opt into stricter parsing; turns silent mistakes into errors

  /**
   * Characters that are invisible but change the byte sequence of a word.
   * Attackers insert these between letters to break naive substring matching:
   * zero-width space/non-joiner/joiner, word joiner, BOM, and soft hyphen.
   */
  // A regex literal is written between slashes: /.../ . The `[...]` is a
  // "character class" meaning "match any ONE of these characters". The odd
  // glyphs inside are real zero-width/invisible code points. The trailing `g`
  // is the "global" flag: replace EVERY match, not just the first.
  const INVISIBLE = /[­​‌‍⁠﻿]/g;

  /**
   * Homoglyph and leetspeak folding table, applied only by deobfuscate().
   * Keys are the substitute characters an author might use; values are the
   * plain-ASCII letters they stand in for. Cyrillic/Greek lookalikes are
   * included because copy-pasted "spicy" text frequently uses them.
   */
  // A plain JS object used as a lookup table (like a dictionary/map): each
  // "key: value" pair says "if you see this character, replace it with that
  // letter". Keys that are valid identifiers can be bare (`$`, `а`); keys that
  // aren't (like "@" or "!") must be quoted strings. Number-looking keys such
  // as `0` are stored as the string "0" — object keys are always strings.
  const FOLD_MAP = {
    0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 6: "g", 7: "t", 8: "b", 9: "g",
    "@": "a", $: "s", "!": "i", "|": "l", "+": "t",
    // Cyrillic lookalikes
    а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c",
    т: "t", у: "y", х: "x",
    // Greek lookalikes
    α: "a", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  };

  /**
   * Punctuation sprinkled *inside* a word to evade matching: f.u.c.k, k-i-l-l.
   * Lookarounds restrict removal to positions between two alphanumerics, so
   * sentence punctuation and word boundaries are left alone.
   */
  // Regex breakdown:
  //   (?<=[\p{L}\p{N}])  "lookbehind": only match if just BEFORE this position
  //                      there is a letter (\p{L}) or number (\p{N}). It checks
  //                      the neighbour but does NOT consume/delete it.
  //   [._*+~^'`"-]+      one or more of these punctuation characters (the actual
  //                      thing we will strip out).
  //   (?=[\p{L}\p{N}])   "lookahead": only if a letter/number comes right AFTER.
  //   flags: g = replace all matches, u = Unicode mode (required so \p{...}
  //          Unicode property escapes work at all).
  // Net effect: only punctuation sitting BETWEEN two letters/digits is removed,
  // so "f.u.c.k" -> "fuck" but "end. Start" keeps its sentence period.
  const INTRA_WORD_PUNCT = /(?<=[\p{L}\p{N}])[._*+~^'`"-]+(?=[\p{L}\p{N}])/gu;

  /**
   * A run of single characters separated by whitespace — "k i l l", "K 1 L. L".
   * Requires at least three characters in the run so ordinary short words
   * ("a b test") are not welded together.
   */
  // Regex breakdown (matches things like "k i l l" so we can weld them):
  //   (?<=^|\s)                     lookbehind: run must start at the beginning
  //                                 of the string (^) or after a space (\s).
  //   [\p{L}\p{N}][._*+~^'`"-]*     a single letter/number, optionally trailed
  //                                 by decorative punctuation.
  //   (?:\s+ ... ){2,}              a NON-capturing group `(?: )` repeated 2+
  //                                 times: whitespace then another single char.
  //                                 The {2,} plus the first char means 3+ chars
  //                                 total, so short "a b" is ignored.
  //   (?=\s|$)                      lookahead: run must end at a space or the
  //                                 end of the string.
  const LETTER_SPACED_RUN =
    /(?<=^|\s)[\p{L}\p{N}][._*+~^'`"-]*(?:\s+[\p{L}\p{N}][._*+~^'`"-]*){2,}(?=\s|$)/gu;

  /**
   * Conservative normalization. Safe for phrase/template matching because it
   * keeps spaces and punctuation between words intact.
   *
   * @param {string} input Raw text pulled off the page.
   * @returns {string} Lowercased, NFKC-normalized, whitespace-collapsed text.
   */
  function normalize(input) {
    // Guard clause: if we weren't handed a real, non-empty string, return an
    // empty string so callers never have to worry about null/undefined/numbers.
    if (typeof input !== "string" || input.length === 0) return "";
    // This is "method chaining": each call returns a new string, and we call the
    // next method on that result. Read top to bottom as a pipeline of steps.
    return input
      // NFKC is a Unicode normalization form. `String.prototype.normalize`
      // rewrites look-alike/compatibility characters into a canonical form, e.g.
      // fullwidth "ＡＢＣ" -> "ABC" and ligatures -> plain letters. This makes
      // visually-identical text compare equal.
      .normalize("NFKC") // collapse fullwidth/compatibility forms to ASCII
      .replace(INVISIBLE, "") // delete the zero-width chars matched above
      .toLowerCase() // case-fold so "KILL" and "kill" are the same
      .replace(/\s+/g, " ") // squeeze every run of whitespace into one space
      .trim(); // drop leading/trailing spaces
  }

  /**
   * Aggressive normalization for single-term matching.
   *
   * Undoes the four common evasion techniques while *preserving word
   * boundaries*, which matters more than it looks: an earlier version stripped
   * all whitespace, and "work i kept" collapsed to "workikept" — which
   * contains the substring "kike". Keeping spaces means slur patterns can be
   * \b-anchored and cross-word collisions become impossible.
   *
   *   "K   1  L. L  himmmm"  ->  "kill him"
   *   "f.u.c.k"              ->  "fuck"
   *   "faaaggooot"           ->  "faggot"
   *
   * @param {string} input Raw text pulled off the page.
   * @returns {string} Folded, de-obfuscated text with word boundaries intact.
   */
  function deobfuscate(input) {
    // Reuse the conservative pass first so we start from clean, lowercased text.
    const base = normalize(input);
    if (base.length === 0) return "";

    // Step 1: fold homoglyphs/leetspeak one character at a time.
    // `for...of` iterates over the string by CHARACTER (code point), which
    // correctly handles multi-byte Unicode, unlike a plain index loop.
    let folded = "";
    for (const ch of base) {
      // `cond ? a : b` is the ternary operator: an inline if/else that yields a
      // value. Here: if FOLD_MAP has an entry for this char, use the replacement
      // FOLD_MAP[ch]; otherwise keep the original char. `+=` appends to `folded`.
      //
      // Why the verbose `Object.prototype.hasOwnProperty.call(FOLD_MAP, ch)`
      // instead of the shorter `FOLD_MAP.hasOwnProperty(ch)`? It's the safe way
      // to ask "does this object have its own key named `ch`?" without breaking
      // if the object happened to have a property literally called
      // "hasOwnProperty". `.call(obj, ...)` borrows the method and runs it with
      // `this` set to `obj`.
      folded += Object.prototype.hasOwnProperty.call(FOLD_MAP, ch)
        ? FOLD_MAP[ch]
        : ch;
    }

    // Steps 2-4: another method-chaining pipeline over the folded string.
    return folded
      .replace(INTRA_WORD_PUNCT, "") // strip punctuation glued inside words
      // Weld letter-spaced runs back into a single word. The 2nd argument to
      // `.replace` is a CALLBACK: for each whole run the regex matched, it is
      // called with that matched text (`run`) and returns the replacement — here
      // the same run with all its spaces/punctuation removed, e.g. "k i l l" ->
      // "kill". This is a small closure defined inline with arrow syntax.
      .replace(LETTER_SPACED_RUN, (run) => run.replace(/[\s._*+~^'`"-]+/g, ""))
      // Runs of 3+ are stretching ("sooooo"); collapse them to one character.
      // Runs of exactly 2 are left alone so genuine doubles ("bookkeeper",
      // "faggot") survive and stay matchable.
      //
      // `(.)` captures any one character into "group 1". `\1` is a backreference
      // meaning "the same character group 1 just matched", and `{2,}` requires 2
      // or more MORE of it (so 3+ identical chars total). In the replacement
      // string, `$1` inserts that captured character once — collapsing the run.
      .replace(/(.)\1{2,}/g, "$1");
  }

  /**
   * Split normalized text into word tokens. Unicode-letter aware so that
   * non-English text is not shredded into single characters.
   *
   * @param {string} input Raw or normalized text.
   * @returns {string[]} Lowercase word tokens, empty entries removed.
   */
  function tokenize(input) {
    const base = normalize(input);
    if (base.length === 0) return [];
    // Split on any run of characters that are NOT letters, digits, or an
    // apostrophe. Inside `[...]` a leading `^` means "NOT these", so
    // `[^\p{L}\p{N}']+` matches the separators (spaces, commas, etc.) between
    // words. `.split` returns the pieces in between — the words themselves.
    // `.filter(Boolean)` drops any empty strings: `Boolean` used as the filter
    // callback keeps only truthy values, and "" is falsy.
    return base.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  }

  /**
   * Fraction of alphabetic characters that are uppercase in the ORIGINAL
   * (un-normalized) text. A strong rage-bait signal above ~0.6 on long text.
   *
   * @param {string} input Raw text, before normalization.
   * @returns {number} 0..1; returns 0 when there are no letters to measure.
   */
  function capsRatio(input) {
    if (typeof input !== "string") return 0;
    let upper = 0;
    let letters = 0;
    for (const ch of input) {
      // `.test(ch)` returns true/false for whether the regex matches. Here we
      // skip anything that is not a letter: `!/\p{L}/u.test(ch)` is "not a
      // letter", and `continue` jumps straight to the next loop iteration.
      if (!/\p{L}/u.test(ch)) continue;
      letters += 1;
      // A character counts as uppercase when it differs from its lowercase form
      // AND equals its uppercase form. The two checks together exclude
      // caseless letters (many scripts have no case), which are neither.
      if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) upper += 1;
    }
    // Avoid dividing by zero: with no letters, report 0 instead of NaN.
    return letters === 0 ? 0 : upper / letters;
  }

  /**
   * Count runs of stacked terminal punctuation ("!!!", "?!?!"), which
   * correlate with outrage-bait phrasing.
   *
   * @param {string} input Raw text.
   * @returns {number} Number of runs of 2+ consecutive ! or ? characters.
   */
  function punctuationBursts(input) {
    if (typeof input !== "string") return 0;
    // `.match(regex-with-g)` returns an ARRAY of all matches, or `null` if there
    // were none. `[!?]{2,}` matches 2+ consecutive `!` or `?` characters.
    const matches = input.match(/[!?]{2,}/g);
    // Guard against the null case: only read `.length` when we actually got an
    // array, otherwise report 0 bursts.
    return matches ? matches.length : 0;
  }

  /**
   * Trim text to a maximum length on a word boundary. Keeps API payloads
   * bounded and predictable; classification quality does not improve past
   * roughly the first couple of thousand characters of a social post.
   *
   * @param {string} input Text to clamp.
   * @param {number} max Maximum characters to keep.
   * @returns {string} Clamped text.
   */
  function clamp(input, max) {
    if (typeof input !== "string") return "";
    if (input.length <= max) return input; // already short enough, nothing to do
    // `.slice(0, max)` takes the first `max` characters (a hard cut that may
    // land in the middle of a word).
    const cut = input.slice(0, max);
    // Find the last space in that cut so we can trim back to a whole word.
    // `.lastIndexOf` returns the index, or -1 if there is no space.
    const lastSpace = cut.lastIndexOf(" ");
    // Only trim back to the last space if that space is reasonably far in (past
    // 60% of `max`); otherwise a very early space would throw away most of the
    // text, so we keep the hard cut instead. `.trim()` cleans any trailing space.
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }

  /**
   * Salted content fingerprint, used as the verdict-cache key.
   *
   * The salt is a per-installation random value. Without it, a stored cache
   * would be a plain SHA-256 of post text, which an attacker with disk access
   * could confirm by hashing candidate strings (a dictionary attack against
   * "did this user see post X"). Salting makes the fingerprints useless
   * outside this one installation.
   *
   * @param {string} input Text to fingerprint (normalized internally).
   * @param {string} salt Per-installation hex salt.
   * @returns {Promise<string>} base64url-encoded SHA-256 digest.
   */
  // `async` marks a function that does asynchronous work and always returns a
  // Promise; inside it we can `await` other Promises as if they were blocking.
  async function fingerprint(input, salt) {
    const material = `${salt || ""} ${normalize(input)}`;
    // NOTE: the line above builds `material` as a template literal (backticks)
    // with `${...}` placeholders: the salt, then a separator, then the
    // normalized text. `salt || ""` substitutes an empty string when `salt` is
    // missing/falsy so we never embed the word "undefined".
    // `TextEncoder` turns a JS string into raw UTF-8 bytes (a Uint8Array),
    // because the crypto hashing API operates on bytes, not text.
    const bytes = new TextEncoder().encode(material);
    // `crypto.subtle.digest` is the browser's built-in hashing. It returns a
    // Promise, so we `await` it to get the finished hash as an ArrayBuffer.
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    // Wrap the raw ArrayBuffer in a Uint8Array (a typed byte view) so our
    // encoder can iterate it, then return the URL-safe text form.
    return toBase64Url(new Uint8Array(digest));
  }

  /**
   * Encode bytes as base64url (RFC 4648 §5) with padding stripped. Used for
   * every binary value we persist so records stay JSON-safe.
   *
   * @param {Uint8Array} bytes Bytes to encode.
   * @returns {string} base64url text.
   */
  function toBase64Url(bytes) {
    // `btoa` (below) only accepts a "binary string" — a string whose characters
    // each stand for one byte (code points 0-255). So first we build that string
    // one byte at a time: `String.fromCharCode(n)` turns a number into its
    // matching character. This classic index loop walks the array by position.
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    // `btoa` produces standard base64. base64url differs in three ways, fixed by
    // the chained `.replace` calls: `+` -> `-`, `/` -> `_`, and trailing `=`
    // padding removed (`/=+$/` matches one-or-more `=` anchored to the end `$`).
    // These swaps make the text safe to drop into URLs and filenames.
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * Inverse of toBase64Url.
   *
   * @param {string} text base64url text.
   * @returns {Uint8Array} Decoded bytes.
   */
  function fromBase64Url(text) {
    // Reverse the two character swaps so we have standard base64 again.
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    // `atob` requires the padding `=` characters that toBase64Url stripped, and
    // base64 length must be a multiple of 4. `(len + 3) % 4` computes how many
    // pad chars to KEEP from "===": `.slice(n)` drops the first n, leaving 0-3.
    // (`%` is the remainder/modulo operator.) Then `atob` decodes to a binary
    // string.
    const binary = atob(padded + "===".slice((padded.length + 3) % 4));
    // Allocate a byte array of the right size, then copy each character's numeric
    // code (`charCodeAt`, 0-255) into it — the inverse of the fromCharCode loop.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // The factory's return value is this module's PUBLIC API — only the helpers
  // listed here are visible to other files (via VALYOU.Text or require()).
  // `{ normalize }` is shorthand for `{ normalize: normalize }`.
  return {
    normalize,
    deobfuscate,
    tokenize,
    capsRatio,
    punctuationBursts,
    clamp,
    fingerprint,
    toBase64Url,
    fromBase64Url,
  };
});
