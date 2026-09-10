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
const Text = require("../src/lib/text.js");

test("normalize lowercases, collapses whitespace, and trims", () => {
  assert.equal(Text.normalize("  Hello   WORLD \n\t "), "hello world");
});

test("normalize applies NFKC so fullwidth characters fold to ASCII", () => {
  // Fullwidth Latin is a common copy-paste evasion; NFKC maps it to ASCII.
  assert.equal(Text.normalize("ＫＩＬＬ"), "kill");
});

test("normalize strips zero-width characters used to break word matching", () => {
  const withZeroWidth = "ki​ll‍ them";
  assert.equal(Text.normalize(withZeroWidth), "kill them");
});

test("normalize returns empty string for non-string and empty input", () => {
  assert.equal(Text.normalize(null), "");
  assert.equal(Text.normalize(undefined), "");
  assert.equal(Text.normalize(42), "");
  assert.equal(Text.normalize(""), "");
});

test("normalize preserves word boundaries so phrase patterns still work", () => {
  assert.equal(Text.normalize("All Women Are Bad"), "all women are bad");
});

test("deobfuscate folds leetspeak digits and symbols to letters", () => {
  assert.equal(Text.deobfuscate("k1ll"), "kill");
  assert.equal(Text.deobfuscate("h4t3"), "hate");
  assert.equal(Text.deobfuscate("@ss"), "ass");
});

test("deobfuscate removes intra-word separators", () => {
  assert.equal(Text.deobfuscate("f.u.c.k"), "fuck");
  assert.equal(Text.deobfuscate("k i l l"), "kill");
  assert.equal(Text.deobfuscate("k-i-l-l"), "kill");
});

test("deobfuscate collapses stretched characters but keeps genuine doubles", () => {
  // Runs of 3+ are stretching and collapse to one character...
  assert.equal(Text.deobfuscate("hellooooo"), "hello");
  assert.equal(Text.deobfuscate("faaaggooot"), "faggot");
  // ...while runs of exactly two are real spelling and survive untouched.
  assert.equal(Text.deobfuscate("bookkeeper"), "bookkeeper");
});

test("deobfuscate preserves word boundaries, preventing cross-word collisions", () => {
  // Regression guard: an earlier version stripped all whitespace, so this
  // phrase collapsed to "workikept" — which contains a slur as a substring.
  const folded = Text.deobfuscate("work i kept");
  assert.equal(folded, "work i kept");
  assert.ok(!/\bkike\b/.test(folded));
});

test("deobfuscate does not weld ordinary short words together", () => {
  // Two single letters are not an evasion pattern; three or more are.
  assert.equal(Text.deobfuscate("a b test"), "a b test");
});

test("deobfuscate folds Cyrillic homoglyphs to their Latin lookalikes", () => {
  // "неllо" mixes Cyrillic н/е/о with Latin l — a classic filter-evasion trick.
  assert.equal(Text.deobfuscate("неllо"), "hello");
});

test("deobfuscate handles combined evasion techniques", () => {
  assert.equal(Text.deobfuscate("K   1  L. L"), "kill");
});

test("tokenize splits on non-word characters and drops empties", () => {
  assert.deepEqual(Text.tokenize("Hello, world! It's me."), ["hello", "world", "it's", "me"]);
});

test("tokenize keeps non-Latin scripts intact", () => {
  assert.deepEqual(Text.tokenize("hola señor"), ["hola", "señor"]);
});

test("tokenize returns an empty array for empty input", () => {
  assert.deepEqual(Text.tokenize(""), []);
  assert.deepEqual(Text.tokenize(null), []);
});

test("capsRatio measures uppercase share of letters only", () => {
  assert.equal(Text.capsRatio("ABCD"), 1);
  assert.equal(Text.capsRatio("abcd"), 0);
  assert.equal(Text.capsRatio("ABcd"), 0.5);
});

test("capsRatio ignores digits and punctuation when computing the ratio", () => {
  // Four letters, all uppercase; the digits and symbols must not dilute it.
  assert.equal(Text.capsRatio("AB!!12CD"), 1);
});

test("capsRatio returns 0 when there are no letters", () => {
  assert.equal(Text.capsRatio("1234!!!"), 0);
  assert.equal(Text.capsRatio(""), 0);
  assert.equal(Text.capsRatio(null), 0);
});

test("punctuationBursts counts runs of stacked terminal punctuation", () => {
  assert.equal(Text.punctuationBursts("what!! really?? no!!!"), 3);
  assert.equal(Text.punctuationBursts("normal sentence."), 0);
  // A single ! is normal writing, not a burst.
  assert.equal(Text.punctuationBursts("hey!"), 0);
});

test("clamp leaves short text untouched", () => {
  assert.equal(Text.clamp("short", 100), "short");
});

test("clamp cuts on a word boundary when one is available", () => {
  const input = "the quick brown fox jumps over the lazy dog";
  const result = Text.clamp(input, 20);
  assert.ok(result.length <= 20);
  // Should not end mid-word.
  assert.ok(input.startsWith(result));
  assert.ok(!result.endsWith("fo"));
});

test("clamp falls back to a hard cut when no late word boundary exists", () => {
  const result = Text.clamp("aaaaaaaaaaaaaaaaaaaaaaaa", 10);
  assert.equal(result.length, 10);
});

test("base64url round-trips arbitrary bytes without padding", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  const encoded = Text.toBase64Url(bytes);

  assert.ok(!encoded.includes("+"), "must not contain +");
  assert.ok(!encoded.includes("/"), "must not contain /");
  assert.ok(!encoded.includes("="), "must not be padded");
  assert.deepEqual(Array.from(Text.fromBase64Url(encoded)), Array.from(bytes));
});

test("base64url round-trips every input length modulo 3", () => {
  // The padding-strip logic is length-sensitive, so cover all three cases.
  for (const length of [1, 2, 3, 4, 5, 6, 7]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
    const decoded = Text.fromBase64Url(Text.toBase64Url(bytes));
    assert.deepEqual(Array.from(decoded), Array.from(bytes), `length ${length}`);
  }
});

test("fingerprint is deterministic for the same text and salt", async () => {
  const a = await Text.fingerprint("hello world", "salt123");
  const b = await Text.fingerprint("hello world", "salt123");
  assert.equal(a, b);
});

test("fingerprint changes when the salt changes", async () => {
  // This is the property that makes a stolen cache useless: without the
  // per-install salt, an attacker cannot confirm which posts were seen.
  const a = await Text.fingerprint("hello world", "salt-a");
  const b = await Text.fingerprint("hello world", "salt-b");
  assert.notEqual(a, b);
});

test("fingerprint ignores normalization-equivalent differences", async () => {
  // Cache hit rate depends on this: the same post re-rendered with different
  // whitespace or casing must map to the same key.
  const a = await Text.fingerprint("Hello   World", "s");
  const b = await Text.fingerprint("hello world", "s");
  assert.equal(a, b);
});

test("fingerprint differs for different text", async () => {
  const a = await Text.fingerprint("hello world", "s");
  const b = await Text.fingerprint("goodbye world", "s");
  assert.notEqual(a, b);
});
