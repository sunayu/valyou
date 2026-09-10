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
 * Coverage for the coded-hate lexicon.
 *
 * These patterns are what lets a fully on-device product catch the vocabulary
 * built specifically to slip past word filters. Every addition ships with a
 * false-positive guard beside it — the coverage is only a win if ordinary
 * posts stay untouched.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Settings = require("../src/lib/settings.js");
const Scorer = require("../src/lib/scorer.js");

const DEFAULTS = Settings.sanitize(null);
const HIDE = DEFAULTS.categories.hate_racial.threshold; // 0.55

/**
 * Score text and return the given category's value.
 *
 * @param {string} text Text to score.
 * @param {string} category Category id.
 * @returns {number}
 */
function score(text, category) {
  return Scorer.scoreText(text, DEFAULTS.rules).scores[category];
}

/* ------------------------------------------------------------------ *
 * Detection: coded hate must be caught locally, with no API           *
 * ------------------------------------------------------------------ */

test("white-nationalist slogans are caught by the local classifier alone", () => {
  const samples = [
    "the great replacement is happening right in front of you",
    "this is white genocide plain and simple",
    "he is a race traitor and everyone knows it",
    "blood and soil, brothers",
  ];
  for (const text of samples) {
    assert.ok(score(text, "hate_racial") >= HIDE, `missed: ${text}`);
  }
});

test("neo-Nazi numeric codes are caught in plain form", () => {
  assert.ok(score("1488 forever, you know what it means", "hate_racial") >= HIDE);
  assert.ok(score("living by the 14 words every day", "hate_racial") >= HIDE);
});

test("Holocaust celebration is caught at near-certainty", () => {
  const result = Scorer.scoreText("six million wasn't enough if you ask me", DEFAULTS.rules);
  assert.ok(result.scores.hate_racial > 0.9);
  assert.ok(result.scores.violence > 0.9);
});

test("the triple-parentheses echo is caught", () => {
  assert.ok(score("look at what (((they))) are pushing now", "hate_racial") >= HIDE);
});

test("racist meme phrases are caught", () => {
  assert.ok(score("typical, he dindu nuffin right?", "hate_racial") >= HIDE);
  assert.ok(score("we wuz kangz and all that", "hate_racial") >= HIDE);
});

test("nativist expulsion demands are caught", () => {
  assert.ok(score("just go back to your country if you hate it here", "hate_racial") >= HIDE);
  assert.ok(score("speak english or leave, simple as that", "hate_racial") >= HIDE);
});

test("religion-as-disease framing is caught", () => {
  assert.ok(score("islam is a cancer on the west", "hate_racial") >= HIDE);
});

test("the groomer smear is caught only when aimed at LGBT people", () => {
  assert.ok(
    score("every drag queen event is full of groomers", "hate_gender") >=
      DEFAULTS.categories.hate_gender.threshold
  );

  // The bare word is an ordinary occupation and must not score.
  assert.equal(score("the dog groomer did an amazing job on our poodle", "hate_gender"), 0);
  assert.equal(score("my wedding hair and makeup groomer was fantastic", "hate_gender"), 0);
});

test("obfuscated dogwhistles are caught through the folded form", () => {
  // Leetspeak on the slogan itself — the reason dogwhistles are checked
  // against the deobfuscated text as well.
  assert.ok(score("wh1te p0wer forever", "hate_racial") >= HIDE);
});

test("incel vocabulary for women is caught", () => {
  assert.ok(
    score("femoids only date chads, every roastie is the same", "hate_gender") >=
      DEFAULTS.categories.hate_gender.threshold
  );
});

test("mass-violence references to public places are caught", () => {
  assert.ok(
    score("someone should shoot up that mosque", "violence") >=
      DEFAULTS.categories.violence.threshold
  );
});

test("intimidation and execution fantasies are caught", () => {
  assert.ok(score("i know where you live, remember that", "violence") > 0.7);
  assert.ok(score("string them all up, every last one", "violence") > 0.8);
  assert.ok(score("nobody would even miss you", "harassment") > 0.8);
});

test("censorship-urgency rage bait contributes", () => {
  const result = Scorer.scoreText(
    "SHARE THIS BEFORE THEY DELETE IT!!! they're coming for your kids!!!",
    DEFAULTS.rules
  );
  assert.ok(result.scores.rage_bait >= DEFAULTS.categories.rage_bait.threshold);
});

/* ------------------------------------------------------------------ *
 * False-positive guards: one per risky addition                       *
 * ------------------------------------------------------------------ */

test("the cat breed does not trip the coon pattern", () => {
  assert.equal(score("our maine coon just turned three, he's enormous", "hate_racial"), 0);
});

test("pakistan and pakistani do not trip the paki pattern", () => {
  assert.equal(score("the pakistan cricket team played brilliantly today", "hate_racial"), 0);
  assert.equal(score("found an amazing pakistani restaurant downtown", "hate_racial"), 0);
});

test("single sub-threshold homograph slurs never act alone", () => {
  // "negro" is Spanish for black; "dyke" is a surname and an embankment.
  // Both are deliberately weighted below the acting threshold.
  assert.ok(score("mi gato negro es muy bonito", "hate_racial") < HIDE);
  assert.ok(score("the van dyke family reunion was lovely", "hate_gender") < HIDE);
  assert.ok(score("the dyke held back the floodwater all winter", "hate_gender") < HIDE);
});

test("ordinary parentheses do not trip the echo pattern", () => {
  assert.equal(score("we left early (((the queue was insane, honestly)))", "hate_racial"), 0);
});

test("discussing dogwhistles critically is damped by the mitigators", () => {
  const raw = Scorer.scoreText("the great replacement is real", DEFAULTS.rules);
  const critical = Scorer.scoreText(
    'The term "great replacement" is a slur-adjacent conspiracy theory; here is why this is harmful.',
    DEFAULTS.rules
  );
  assert.ok(critical.scores.hate_racial < raw.scores.hate_racial);
});

test("sports talk about redskins games stays clean", () => {
  assert.equal(score("watching the redskins game with my dad like old times", "hate_racial"), 0);
});

test("innocuous sentences with newly-added trigger words stay clean", () => {
  const benign = [
    "the white power washer finally arrived, deck cleaning weekend!",
    "my daughter is learning about the second world war at school",
    "we counted six million steps on the group fitness challenge",
    "he knows where you live stream on fridays",
  ];
  for (const text of benign) {
    const result = Scorer.scoreText(text, DEFAULTS.rules);
    assert.ok(result.max < HIDE, `false positive (${result.max}): ${text}`);
  }
});
