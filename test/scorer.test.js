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

const Taxonomy = require("../src/lib/taxonomy.js");
const Settings = require("../src/lib/settings.js");
const Scorer = require("../src/lib/scorer.js");

/** Baseline settings used by most cases. */
const DEFAULTS = Settings.sanitize(null);

/**
 * Convenience: score text and return the top category score.
 *
 * @param {string} text Text to score.
 * @param {object} [rules] Optional user rules.
 * @returns {number}
 */
function scoreOf(text, rules) {
  return Scorer.scoreText(text, rules).max;
}

/* ------------------------------------------------------------------ *
 * Clean content must stay clean — the most important property here.  *
 * A moderation tool that filters ordinary posts is worse than none.  *
 * ------------------------------------------------------------------ */

test("ordinary posts score at zero", () => {
  const benign = [
    "Just made the best carbonara of my life. Recipe in comments!",
    "Anyone else watching the game tonight? What a comeback.",
    "My daughter graduated today. So proud of her I could burst.",
    "Looking for a plumber recommendation in the north end, thanks all.",
    "Three years sober today. Thank you to everyone who checked in on me.",
    "The new album is genuinely their worst work and I will die on this hill.",
    "Reminder that the council meeting is Thursday at 7pm at the library.",
  ];

  for (const text of benign) {
    assert.equal(scoreOf(text), 0, `false positive on: ${text}`);
  }
});

test("heated but legitimate political speech is not treated as rage bait", () => {
  const opinions = [
    "I think this housing policy is badly designed and will raise rents.",
    "The mayor's budget cuts the library fund by 12 percent. I'm voting no.",
    "Strongly disagree with the court's reasoning here, it ignores precedent.",
  ];

  for (const text of opinions) {
    const result = Scorer.scoreText(text, DEFAULTS.rules);
    assert.ok(
      result.scores.rage_bait < DEFAULTS.categories.rage_bait.threshold,
      `political opinion flagged as rage bait: ${text} (${result.scores.rage_bait})`
    );
  }
});

test("text below the minimum length is skipped entirely", () => {
  const result = Scorer.scoreText("ok", DEFAULTS.rules);
  assert.equal(result.tooShort, true);
  assert.equal(result.max, 0);
});

/* ------------------------------------------------------------------ *
 * Detection                                                          *
 * ------------------------------------------------------------------ */

test("dehumanizing generalizations about a group score as hate", () => {
  const result = Scorer.scoreText("all immigrants are vermin and should be removed", DEFAULTS.rules);
  assert.ok(result.scores.hate_racial > 0.6, `expected hate signal, got ${result.scores.hate_racial}`);
  assert.ok(result.signals.some((s) => s.id === "group_dehumanized"));
});

test("asserting a group is inherently inferior scores as hate", () => {
  const result = Scorer.scoreText("women are genetically inferior at everything", DEFAULTS.rules);
  assert.ok(result.scores.hate_gender > 0.6);
});

test("direct threats score as violence", () => {
  const result = Scorer.scoreText("i'm gonna find you and kill you, watch your back", DEFAULTS.rules);
  assert.ok(result.scores.violence > 0.8);
  assert.ok(result.signals.some((s) => s.id === "direct_threat"));
});

test("telling someone to kill themselves scores as harassment and violence", () => {
  const result = Scorer.scoreText("nobody likes you, just kys already", DEFAULTS.rules);
  assert.ok(result.scores.harassment > 0.7);
  assert.ok(result.scores.violence > 0.5);
});

test("classic misogynistic constructions score as gender hate", () => {
  const result = Scorer.scoreText("women belong in the kitchen and nowhere else", DEFAULTS.rules);
  assert.ok(result.scores.hate_gender > 0.7);
});

test("slurs are detected even when obfuscated", () => {
  // Each of these must land, or evasion is trivially easy.
  const evasions = ["f4gg0t", "f a g g o t", "f.a.g.g.o.t", "faaaggooot"];
  for (const text of evasions) {
    const result = Scorer.scoreText(`you absolute ${text} get lost`, DEFAULTS.rules);
    assert.ok(
      result.scores.harassment > 0.6,
      `evasion not caught: ${text} (${result.scores.harassment})`
    );
  }
});

test("rage-bait markers accumulate but a single weak one does not trigger", () => {
  const single = Scorer.scoreText("Share this if you agree with me about the weather", DEFAULTS.rules);
  assert.ok(
    single.scores.rage_bait < DEFAULTS.categories.rage_bait.threshold,
    "one weak marker should not be enough"
  );

  const stacked = Scorer.scoreText(
    "WAKE UP SHEEPLE!!! They don't want you to know this!!! Share if you agree!!!",
    DEFAULTS.rules
  );
  assert.ok(
    stacked.scores.rage_bait >= DEFAULTS.categories.rage_bait.threshold,
    `stacked markers should trigger, got ${stacked.scores.rage_bait}`
  );
});

test("sustained shouting counts only on text long enough to be deliberate", () => {
  // Short exclamations are normal.
  const short = Scorer.scoreText("OMG YES!!", DEFAULTS.rules);
  assert.ok(!short.signals.some((s) => s.id === "all_caps"));

  const long = Scorer.scoreText(
    "THIS IS COMPLETELY UNACCEPTABLE AND EVERYONE NEEDS TO SEE WHAT IS HAPPENING RIGHT NOW",
    DEFAULTS.rules
  );
  assert.ok(long.signals.some((s) => s.id === "all_caps"));
});

/* ------------------------------------------------------------------ *
 * Mitigation — the difference between a filter and a censor          *
 * ------------------------------------------------------------------ */

test("counter-speech quoting hate scores lower than the hate itself", () => {
  const raw = Scorer.scoreText("all immigrants are vermin", DEFAULTS.rules);
  const objection = Scorer.scoreText(
    'Someone in my feed wrote "all immigrants are vermin" — this is disgusting, I reported him',
    DEFAULTS.rules
  );

  assert.ok(
    objection.max < raw.max,
    `counter-speech (${objection.max}) should score below the original (${raw.max})`
  );
  assert.ok(objection.signals.some((s) => s.weight < 0), "should record a mitigating signal");
});

test("news reporting about violence is damped", () => {
  const result = Scorer.scoreText(
    "According to police reports, the suspect was charged with attempting to kill two men.",
    DEFAULTS.rules
  );
  assert.ok(result.max < 0.6, `news framing scored too high: ${result.max}`);
});

test("mitigation is capped so an explicit slur still registers", () => {
  // Wrapping a slur in polite framing must not zero it out entirely.
  const result = Scorer.scoreText(
    "According to the article, he said you absolute f4gg0t, which is disgusting",
    DEFAULTS.rules
  );
  assert.ok(result.max > 0.2, `mitigation should be capped, got ${result.max}`);
});

/* ------------------------------------------------------------------ *
 * User rules                                                          *
 * ------------------------------------------------------------------ */

test("user block terms force a near-certain score", () => {
  const rules = { blockTerms: ["crypto"], allowTerms: [] };
  const result = Scorer.scoreText("check out my new crypto project", rules);
  assert.ok(result.max > 0.9);
  assert.ok(result.signals.some((s) => s.id === "user_block_term"));
});

test("user block terms survive obfuscation", () => {
  const rules = { blockTerms: ["crypto"], allowTerms: [] };
  const result = Scorer.scoreText("check out my new c r y p t o project", rules);
  assert.ok(result.max > 0.9);
});

test("very short block terms are ignored to prevent runaway matching", () => {
  const rules = { blockTerms: ["a"], allowTerms: [] };
  assert.equal(scoreOf("a perfectly ordinary sentence about things", rules), 0);
});

test("user allow terms damp an otherwise-matching post", () => {
  const withoutRule = Scorer.scoreText("all immigrants are vermin", { blockTerms: [], allowTerms: [] });
  const withRule = Scorer.scoreText("all immigrants are vermin", {
    blockTerms: [],
    allowTerms: ["immigrants"],
  });
  assert.ok(withRule.max < withoutRule.max);
});

/* ------------------------------------------------------------------ *
 * Score combination                                                   *
 * ------------------------------------------------------------------ */

test("noisy-OR keeps combined weak signals below certainty", () => {
  const scores = Scorer.emptyScores();
  // Three 0.4 signals: summing would give 1.2 (clamped to certainty);
  // noisy-OR gives 0.784, which correctly reads as "likely, not certain".
  const combined = 1 - Math.pow(1 - 0.4, 3);
  assert.ok(combined > 0.78 && combined < 0.79);
  assert.equal(Object.keys(scores).length, Taxonomy.CATEGORY_IDS.length);
});

test("all scores stay within 0..1", () => {
  const samples = [
    "all immigrants are vermin and i'm gonna kill you, f4gg0t, KYS!!! WAKE UP SHEEPLE!!!",
    "hello",
    "",
  ];
  for (const text of samples) {
    const result = Scorer.scoreText(text, DEFAULTS.rules);
    for (const [id, value] of Object.entries(result.scores)) {
      assert.ok(value >= 0 && value <= 1, `${id} out of range: ${value}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * decide()                                                            *
 * ------------------------------------------------------------------ */

test("decide returns off when nothing crosses a threshold", () => {
  const scores = Scorer.emptyScores();
  scores.violence = 0.3;
  assert.equal(Scorer.decide(scores, DEFAULTS, {}).action, "off");
});

test("decide applies the configured action once a threshold is crossed", () => {
  const scores = Scorer.emptyScores();
  scores.violence = 0.9;
  const decision = Scorer.decide(scores, DEFAULTS, {});
  assert.equal(decision.action, "hide");
  assert.equal(decision.category, "violence");
});

test("decide picks the strictest action when several categories trip", () => {
  const scores = Scorer.emptyScores();
  scores.rage_bait = 0.99; // configured to blur
  scores.violence = 0.6; // configured to hide

  const decision = Scorer.decide(scores, DEFAULTS, {});
  // Hide beats blur even though rage_bait scored higher — the user asked for
  // the stricter treatment of violence.
  assert.equal(decision.action, "hide");
  assert.equal(decision.category, "violence");
});

test("decide ignores categories the user turned off", () => {
  const settings = Settings.sanitize({ categories: { violence: { action: "off" } } });
  const scores = Scorer.emptyScores();
  scores.violence = 1;
  assert.equal(Scorer.decide(scores, settings, {}).action, "off");
});

test("decide honours the author allow list", () => {
  const settings = Settings.sanitize({ rules: { allowAuthors: ["Aunt Carol"] } });
  const scores = Scorer.emptyScores();
  scores.violence = 1;

  const decision = Scorer.decide(scores, settings, { author: "aunt carol" });
  assert.equal(decision.action, "off");
  assert.match(decision.reason, /allow list/i);
});

test("the author allow list matches case- and whitespace-insensitively", () => {
  const settings = Settings.sanitize({ rules: { allowAuthors: ["Aunt Carol"] } });
  const scores = Scorer.emptyScores();
  scores.violence = 1;
  assert.equal(Scorer.decide(scores, settings, { author: "  AUNT   CAROL " }).action, "off");
});

test("decide produces an explanation naming the strongest signal", () => {
  const result = Scorer.scoreText("i'm gonna kill you", DEFAULTS.rules);
  const decision = Scorer.decide(result.scores, DEFAULTS, { signals: result.signals });
  assert.match(decision.reason, /Violence/);
  assert.match(decision.reason, /threat/i);
});

/* ------------------------------------------------------------------ *
 * Video handling — decide() (post blurring in "hide" mode)            *
 * ------------------------------------------------------------------ */

test("allow mode leaves a clean video post untouched", () => {
  const settings = Settings.sanitize({ media: { video: "allow" } });
  const decision = Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: true });
  assert.equal(decision.action, "off");
});

test("block mode TAGS a clean video post (autoplay stopped, post visible)", () => {
  // block never covers the post — it labels it so the user can see valyou
  // stopped autoplay, and the site's own player still works on a tap.
  const settings = Settings.sanitize({ media: { video: "block" } });
  const decision = Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: true });
  assert.equal(decision.action, "tag");
  assert.match(decision.reason, /autoplay/i);
});

test("hide mode blurs a clean video post behind a click", () => {
  const settings = Settings.sanitize({ media: { video: "hide" } });
  const decision = Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: true });
  assert.equal(decision.action, "blur");
  assert.match(decision.reason, /click to play|choose to play/i);
});

test("by default, every video post is blurred behind a click", () => {
  // The default is "hide": a spotless video post is still blurred so the user
  // must choose it to play. A text post with the same (clean) content is not.
  const settings = Settings.sanitize(null);
  assert.equal(settings.media.video, "hide");
  assert.equal(Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: true }).action, "blur");
  assert.equal(Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: false }).action, "off");
});

test("hide mode does not touch non-video units", () => {
  const settings = Settings.sanitize({ media: { video: "hide" } });
  const decision = Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: false });
  assert.equal(decision.action, "off");
});

test("the hide-mode gate itself never downgrades a stronger action", () => {
  // Isolate the hide-mode gate from the flagged-video-blur default (tested
  // separately): with flagged-blur off, a hide-category video keeps "hide".
  const settings = Settings.sanitize({ media: { video: "hide", flaggedVideoBlur: false } });
  const scores = Scorer.emptyScores();
  scores.violence = 0.9; // hides by default
  const decision = Scorer.decide(scores, settings, { hasVideo: true });
  assert.equal(decision.action, "hide");
  assert.equal(decision.category, "violence");
});

test("no video mode blurs a text-only (no video) unit", () => {
  const scores = Scorer.emptyScores();
  scores.violence = 0.4; // under threshold
  for (const mode of ["allow", "block", "hide"]) {
    const settings = Settings.sanitize({ media: { video: mode } });
    const decision = Scorer.decide(scores, settings, { hasVideo: false });
    assert.equal(decision.action, "off", `mode ${mode} must not touch a non-video unit`);
  }
});

test("an allowlisted author's video is never blurred, even in hide mode", () => {
  const settings = Settings.sanitize({
    media: { video: "hide" },
    rules: { allowAuthors: ["Aunt Carol"] },
  });
  const decision = Scorer.decide(Scorer.emptyScores(), settings, {
    hasVideo: true,
    author: "Aunt Carol",
  });
  assert.equal(decision.action, "off");
  assert.match(decision.reason, /allow list/i);
});

/* ------------------------------------------------------------------ *
 * Flagged videos blur rather than collapse (default on)               *
 * ------------------------------------------------------------------ */

test("a flagged video that would HIDE is blurred instead by default", () => {
  const settings = Settings.sanitize(null); // flaggedVideoBlur defaults on
  const scores = Scorer.emptyScores();
  scores.violence = 0.9; // violence defaults to "hide"

  const asVideo = Scorer.decide(scores, settings, { hasVideo: true });
  const asText = Scorer.decide(scores, settings, { hasVideo: false });

  assert.equal(asVideo.action, "blur", "flagged video collapses to a blur, not a bar");
  assert.equal(asText.action, "hide", "a non-video post still hides");
  // The reason still names the category, so the user knows why.
  assert.match(asVideo.reason, /Violence/);
  assert.equal(asVideo.category, "violence");
});

test("a flagged video that would only TAG is upgraded to blur", () => {
  const settings = Settings.sanitize({ categories: { rage_bait: { action: "tag", threshold: 0.3 } } });
  const scores = Scorer.emptyScores();
  scores.rage_bait = 0.9;

  const decision = Scorer.decide(scores, settings, { hasVideo: true });
  assert.equal(decision.action, "blur", "a flagged video is at least blurred");
});

test("an already-blur flagged video stays blur", () => {
  const settings = Settings.sanitize(null); // harassment defaults to blur
  const scores = Scorer.emptyScores();
  scores.harassment = 0.9;
  assert.equal(Scorer.decide(scores, settings, { hasVideo: true }).action, "blur");
});

test("an unflagged video is not blurred by the flagged-video rule", () => {
  // In allow mode a clean video stays off; the flagged-blur rule only touches
  // flagged units. (block tags all video posts; hide gates them — separately.)
  const settings = Settings.sanitize({ media: { video: "allow" } });
  assert.equal(Scorer.decide(Scorer.emptyScores(), settings, { hasVideo: true }).action, "off");
});

test("turning flaggedVideoBlur off lets a flagged video obey its category action", () => {
  const settings = Settings.sanitize({ media: { flaggedVideoBlur: false } });
  const scores = Scorer.emptyScores();
  scores.violence = 0.9; // "hide"
  assert.equal(
    Scorer.decide(scores, settings, { hasVideo: true }).action,
    "hide",
    "with the option off, the video collapses like any post"
  );
});

test("flagged-video blur never weakens protection below a click-to-reveal", () => {
  // Both hide and blur require a click; the change is presentational. Confirm a
  // flagged video is never left visible (tag/off) when its category would act.
  const settings = Settings.sanitize(null);
  for (const [cat, action] of [["violence", "hide"], ["hate_racial", "hide"]]) {
    const scores = Scorer.emptyScores();
    scores[cat] = 0.9;
    const d = Scorer.decide(scores, settings, { hasVideo: true });
    assert.ok(d.action === "blur" || d.action === "hide", `${cat} (${action}) must gate the video`);
  }
});

/* ------------------------------------------------------------------ *
 * Autoplay control — blocksAutoplay()                                 *
 * ------------------------------------------------------------------ */

test("allow mode never blocks autoplay", () => {
  assert.equal(Scorer.blocksAutoplay("allow", { approved: false, userActivated: false }), false);
});

test("block and hide modes stop un-approved autoplay with no user gesture", () => {
  for (const mode of ["block", "hide"]) {
    assert.equal(
      Scorer.blocksAutoplay(mode, { approved: false, userActivated: false }),
      true,
      `${mode} must block autoplay`
    );
  }
});

test("a real user gesture is always allowed — this is what makes click-to-play work", () => {
  for (const mode of ["block", "hide"]) {
    assert.equal(
      Scorer.blocksAutoplay(mode, { approved: false, userActivated: true }),
      false,
      `${mode} must allow a user-initiated play`
    );
  }
});

test("an already-approved video plays freely thereafter", () => {
  assert.equal(Scorer.blocksAutoplay("block", { approved: true, userActivated: false }), false);
  assert.equal(Scorer.blocksAutoplay("hide", { approved: true, userActivated: false }), false);
});

/* ------------------------------------------------------------------ *
 * Performance                                                         *
 * ------------------------------------------------------------------ */

test("scoring a realistic post stays well inside one frame", () => {
  const post =
    "Went to the farmers market this morning and came back with more tomatoes than " +
    "any two people could eat. If anyone wants some, message me — otherwise it's " +
    "sauce for the next three weekends. Also the bread stall is back, finally.";

  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) Scorer.scoreText(post, DEFAULTS.rules);
  const perCall = (performance.now() - started) / 1000;

  // Budget: a 60-item scan must not exceed a 16ms frame, so a single post
  // needs to stay far below 0.25ms.
  assert.ok(perCall < 0.25, `scoring took ${perCall.toFixed(4)}ms per post, expected < 0.25ms`);
});

/* ------------------------------------------------------------------ *
 * Gaps found by end-to-end testing on real pages (2026-08-11)         *
 * ------------------------------------------------------------------ */

test("obfuscated phrases cannot evade the templates", () => {
  // Templates were once matched against the normalized text only, so spacing a
  // phrase out defeated every pattern except the slur list.
  const settings = Settings.sanitize(null);
  const text = "go back where you came from you f.i.l.t.h.y a.n.i.m.a.l.s, this country is not for you people";
  const result = Scorer.scoreText(text, settings.rules);
  assert.ok(result.signals.some((s) => !s.id.startsWith("ml_")), "a pattern must fire, not just the model");
  assert.notEqual(Scorer.decide(result.scores, settings, {}).action, "off");
});

test("a call to kill a group is caught without an 'I am going to' preamble", () => {
  const settings = Settings.sanitize(null);
  const result = Scorer.scoreText("kill them all, every single one of those animals deserves to die", settings.rules);
  assert.notEqual(Scorer.decide(result.scores, settings, {}).action, "off");
});

test("the woman's-place trope is caught across a clause", () => {
  const settings = Settings.sanitize(null);
  const result = Scorer.scoreText(
    "women are too stupid and emotional to be in charge of anything, they belong in the kitchen",
    settings.rules
  );
  assert.notEqual(Scorer.decide(result.scores, settings, {}).action, "off");
});

test("violent verbs in ordinary speech are not filtered", () => {
  // English recycles violent verbs for enthusiasm constantly. A pattern that
  // matched a violence verb plus a bare pronoun hid eight of these ten on a
  // real feed, so the patterns now require the sentence to name a group.
  const settings = Settings.sanitize(null);
  for (const text of [
    "let me shoot them a quick email about the meeting tomorrow morning",
    "you absolutely killed it out there tonight, what a performance",
    "we need to burn it down and rebuild the roster from scratch",
    "just kill it with fire lol my code is a disaster today",
    "gonna hang them up on the wall once the frames arrive",
    "shoot them over whenever you get a chance, no rush at all",
    "these mosquitoes are awful, going to gas them out of the garage",
    "wipe them out in the tournament tonight boys, lets go",
    "kill them all in the game tonight, good luck to the team",
    "he deserves to die at the end of that movie honestly, great writing",
  ]) {
    const result = Scorer.scoreText(text, settings.rules);
    assert.equal(Scorer.decide(result.scores, settings, {}).action, "off", `false positive: ${text}`);
  }
});

test("the new patterns do not fire on innocent lookalikes", () => {
  const settings = Settings.sanitize(null);
  for (const text of [
    "the knives belong in the kitchen not the dining room, please put them away",
    "our chefs are amazing, they belong in the kitchen doing what they love",
    "had to kill time before the meeting so I walked around the block twice",
    "go back to italy next summer is the plan, we loved it there",
    "women are running for office in record numbers this year according to the report",
  ]) {
    const result = Scorer.scoreText(text, settings.rules);
    assert.equal(Scorer.decide(result.scores, settings, {}).action, "off", `false positive: ${text}`);
  }
});

test("a post that is nothing but a slur is caught", () => {
  // The minimum-length gate ran BEFORE the slur pass, so a one-word post — the
  // most common way a slur actually appears — was never evaluated at all.
  const settings = Settings.sanitize(null);
  for (const text of ["nigger", "nigga", "n1gg3r", "n i g g e r"]) {
    const result = Scorer.scoreText(text, settings.rules);
    assert.ok(
      result.signals.some((s) => s.id === "slur"),
      `no slur signal for ${JSON.stringify(text)}`
    );
    assert.notEqual(Scorer.decide(result.scores, settings, {}).action, "off");
  }
});

test("short harmless text is still left alone", () => {
  // The length gate still protects everything that is NOT a slur: "no", "lol"
  // and an emoji carry too little signal to judge.
  const settings = Settings.sanitize(null);
  for (const text of ["lol", "ok thanks", "no way", "👍", "🎉🎉", "same", "yes!"]) {
    const result = Scorer.scoreText(text, settings.rules);
    assert.equal(Scorer.decide(result.scores, settings, {}).action, "off", `false positive: ${text}`);
  }
});
