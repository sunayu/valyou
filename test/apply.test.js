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

const { Document, build } = require("./helpers/dom.js");
const Apply = require("../src/content/apply.js");

/**
 * Build a post-shaped node attached to a document.
 *
 * @returns {{doc: Document, node: object}}
 */
function fixture() {
  const doc = new Document();
  const node = build(doc, {
    attrs: { role: "article" },
    children: [{ tag: "div", text: "the original post content" }],
  });
  doc.body.appendChild(node);
  return { doc, node };
}

/** A decision object as produced by Scorer.decide. */
const DECISION = { action: "hide", category: "violence", reason: "Violence & threats — direct threat" };

/* ------------------------------------------------------------------ *
 * Marking and idempotence                                             *
 * ------------------------------------------------------------------ */


/**
 * Reveal a unit the way a user now must: a deliberate right swipe.
 * (A tap deliberately does nothing — see apply.js#onActivate.)
 *
 * @param {Element} el The bar, shield or button to swipe.
 */
function swipeRight(el) {
  el.dispatch("pointerdown", { clientX: 10, clientY: 100 });
  el.dispatch("pointermove", { clientX: 120, clientY: 104 });
}

test("an unprocessed node needs work; a processed one does not", () => {
  const { node } = fixture();
  assert.equal(Apply.needsWork(node), true);

  Apply.mark(node, "clean");
  assert.equal(Apply.needsWork(node), false);
});

test("every applied state marks the node so rescans skip it", () => {
  for (const action of ["hide", "blur", "tag", "off"]) {
    const { node } = fixture();
    Apply.applyDecision(node, Object.assign({}, DECISION, { action }));
    assert.equal(Apply.needsWork(node), false, `${action} must mark the node`);
  }
});

test("the reason is stored on the node for inspection", () => {
  const { node } = fixture();
  Apply.applyDecision(node, DECISION);
  assert.equal(node.getAttribute(Apply.REASON_ATTR), DECISION.reason);
});

/* ------------------------------------------------------------------ *
 * hide                                                                *
 * ------------------------------------------------------------------ */

test("hide collapses the node and inserts a labelled bar", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);

  assert.ok(node.classList.contains("valyou-collapsed"));
  assert.equal(Apply.stateOf(node), "hidden");

  const bar = node.querySelector(".valyou-bar");
  assert.ok(bar, "a bar must be inserted");
  assert.match(bar.textContent, /Hidden by valyou/);
  assert.match(bar.textContent, /direct threat/);
});

test("hide never removes the original content from the DOM", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);

  // Facebook and Instagram are virtual-scrolled React apps; deleting a node
  // they still reference causes reconciliation crashes.
  assert.ok(node.textContent.includes("the original post content"));
  assert.ok(node.parentElement, "the unit itself must stay attached");
});

test("the bar is inserted as a child, not a sibling", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);
  // A sibling would be recycled away by the virtual scroller and orphaned.
  assert.equal(node.children[0].className, "valyou-bar");
});

test("swiping right reveals the content and removes the bar", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);

  swipeRight(node.querySelector(".valyou-reveal"));

  assert.equal(node.classList.contains("valyou-collapsed"), false);
  assert.equal(node.querySelector(".valyou-bar"), null);
  assert.equal(Apply.stateOf(node), "revealed");
});

test("the reveal click does not propagate to the post underneath", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);

  const event = node.querySelector(".valyou-reveal").dispatch("click");

  // Otherwise clicking "Show" would also open the post, like the video, or
  // whatever else the host app has bound to that region.
  assert.equal(event.propagationStopped, true);
  assert.equal(event.defaultPrevented, true);
});

test("hide fires the onReveal callback so stats can record it", () => {
  const { node } = fixture();
  let revealed = 0;
  Apply.hide(node, Object.assign({}, DECISION, { onReveal: () => (revealed += 1) }));

  swipeRight(node.querySelector(".valyou-reveal"));
  assert.equal(revealed, 1);
});

/* ------------------------------------------------------------------ *
 * blur                                                                *
 * ------------------------------------------------------------------ */

test("blur adds the blur class and a shield with an explanation", () => {
  const { node } = fixture();
  Apply.blur(node, Object.assign({}, DECISION, { action: "blur" }));

  assert.ok(node.classList.contains("valyou-blurred"));
  assert.equal(Apply.stateOf(node), "blurred");

  const shield = node.querySelector(".valyou-shield");
  assert.ok(shield);
  assert.match(shield.textContent, /direct threat/);
});

test("the shield is announced to assistive technology", () => {
  const { node } = fixture();
  Apply.blur(node, Object.assign({}, DECISION, { action: "blur" }));

  const shield = node.querySelector(".valyou-shield");
  assert.equal(shield.getAttribute("role"), "group");
  assert.match(shield.getAttribute("aria-label"), /filtered by valyou/i);
});

test("revealing a blurred unit clears the blur and the shield", () => {
  const { node } = fixture();
  Apply.blur(node, Object.assign({}, DECISION, { action: "blur" }));

  swipeRight(node.querySelector(".valyou-reveal"));

  assert.equal(node.classList.contains("valyou-blurred"), false);
  assert.equal(node.querySelector(".valyou-shield"), null);
  assert.equal(Apply.stateOf(node), "revealed");
});

/* ------------------------------------------------------------------ *
 * tag                                                                 *
 * ------------------------------------------------------------------ */

test("tag leaves content fully visible and adds only a badge", () => {
  const { node } = fixture();
  Apply.tag(node, Object.assign({}, DECISION, { action: "tag" }));

  assert.equal(node.classList.contains("valyou-collapsed"), false);
  assert.equal(node.classList.contains("valyou-blurred"), false);
  assert.ok(node.querySelector(".valyou-badge"));
  assert.equal(Apply.stateOf(node), "tagged");
});

/* ------------------------------------------------------------------ *
 * applyDecision dispatch                                              *
 * ------------------------------------------------------------------ */

test("applyDecision routes each action to the right treatment", () => {
  const cases = [
    ["hide", "hidden", ".valyou-bar"],
    ["blur", "blurred", ".valyou-shield"],
    ["tag", "tagged", ".valyou-badge"],
  ];

  for (const [action, expectedState, selector] of cases) {
    const { node } = fixture();
    const state = Apply.applyDecision(node, Object.assign({}, DECISION, { action }));

    assert.equal(state, expectedState);
    assert.ok(node.querySelector(selector), `${action} should insert ${selector}`);
  }
});

test("an off decision marks the node clean and changes nothing visually", () => {
  const { node } = fixture();
  const state = Apply.applyDecision(node, { action: "off", category: null, reason: "" });

  assert.equal(state, "clean");
  assert.equal(Apply.stateOf(node), "clean");
  assert.equal(node.children.length, 1, "no chrome should be inserted");
});

/* ------------------------------------------------------------------ *
 * reveal is sticky                                                    *
 * ------------------------------------------------------------------ */

test("a revealed unit is not re-processed by a later scan", () => {
  const { node } = fixture();
  Apply.hide(node, DECISION);
  swipeRight(node.querySelector(".valyou-reveal"));

  // Once a user has explicitly chosen to see something, no later verdict may
  // take it away again.
  assert.equal(Apply.needsWork(node), false);
  assert.equal(Apply.stateOf(node), "revealed");
});

test("reveal tolerates a missing chrome element", () => {
  const { node } = fixture();
  node.classList.add("valyou-blurred");

  assert.doesNotThrow(() => Apply.reveal(node, null));
  assert.equal(Apply.stateOf(node), "revealed");
});

test("stateOf returns null for a node that has never been touched", () => {
  const { node } = fixture();
  assert.equal(Apply.stateOf(node), null);
});

/* ------------------------------------------------------------------ *
 * Media neutralization                                                *
 * ------------------------------------------------------------------ */

/**
 * Build a unit containing a playing, unmuted video.
 *
 * The stub DOM has no media semantics, so the fixture models exactly what
 * apply.js touches: pause(), muted, autoplay, and the play event.
 *
 * @returns {{doc: Document, node: object, video: object}}
 */
function videoFixture() {
  const doc = new Document();
  const node = build(doc, {
    attrs: { role: "article" },
    children: [
      { tag: "div", text: "caption text for the filtered unit" },
      { tag: "video" },
    ],
  });
  doc.body.appendChild(node);

  const video = node.querySelector("video");
  video.muted = false;
  video.autoplay = true;
  video.paused = false;
  video.pauseCalls = 0;
  video.pause = function () {
    this.paused = true;
    this.pauseCalls += 1;
  };
  return { doc, node, video };
}

test("hiding a unit pauses and mutes its video", () => {
  // display:none does NOT stop an HTML5 video's audio — without explicit
  // neutralization, "hidden" hateful video would keep talking.
  const { node, video } = videoFixture();
  Apply.hide(node, DECISION);

  assert.equal(video.paused, true, "video must be paused");
  assert.equal(video.muted, true, "video must be muted");
  assert.equal(video.autoplay, false, "autoplay must be disabled");
});

test("blurring a unit pauses and mutes its video", () => {
  const { node, video } = videoFixture();
  Apply.blur(node, Object.assign({}, DECISION, { action: "blur" }));

  assert.equal(video.paused, true);
  assert.equal(video.muted, true);
});

test("a playback attempt while filtered is re-paused by the guard", () => {
  // Feed players resume themselves via autoplay observers; one pause is not
  // enough. The guard must keep winning for as long as the unit is filtered.
  const { node, video } = videoFixture();
  Apply.hide(node, DECISION);
  const pausesAfterHide = video.pauseCalls;

  video.paused = false; // host player resumed it
  video.dispatch("play");

  assert.equal(video.paused, true, "guard must re-pause");
  assert.ok(video.pauseCalls > pausesAfterHide);
});

test("after reveal, the guard stands down and mute is restored", () => {
  const { node, video } = videoFixture();
  Apply.hide(node, DECISION);
  swipeRight(node.querySelector(".valyou-reveal"));

  // Our mute is undone (the user gets their previous state back)...
  assert.equal(video.muted, false, "mute imposed by valyou must be restored");
  // ...and a play attempt now goes through untouched.
  video.paused = false;
  video.dispatch("play");
  assert.equal(video.paused, false, "guard must not fight a revealed unit");
});

test("a video the user had already muted stays muted after reveal", () => {
  const { node, video } = videoFixture();
  video.muted = true; // the user's own choice, before filtering

  Apply.hide(node, DECISION);
  swipeRight(node.querySelector(".valyou-reveal"));

  assert.equal(video.muted, true, "must not unmute what we never muted");
});

test("tagging leaves media completely untouched", () => {
  const { node, video } = videoFixture();
  Apply.tag(node, Object.assign({}, DECISION, { action: "tag" }));

  assert.equal(video.paused, false, "tagged content stays playable");
  assert.equal(video.muted, false);
});

test("neutralizeMedia tolerates videos without a pause method", () => {
  const { doc, node } = fixture();
  node.appendChild(doc.createElement("video")); // bare stub, no media API
  assert.doesNotThrow(() => Apply.hide(node, DECISION));
});

test("a post previously cleared can still be blurred when its video appears late", () => {
  // The Facebook case: the post is judged clean on the first pass, then mounts
  // a <video> later. Blurring a "clean"-marked node must work and transition
  // it to "blurred" so the re-gate sweep can act on lazy players.
  const { node } = fixture();
  Apply.mark(node, "clean");
  assert.equal(Apply.stateOf(node), "clean");

  Apply.applyDecision(node, { action: "blur", category: null, reason: "Video hidden until you choose to play it" });

  assert.equal(Apply.stateOf(node), "blurred");
  assert.ok(node.querySelector(".valyou-shield"), "the shield must be inserted");
});

test("a user-revealed post is never re-gated", () => {
  // The re-gate sweep must skip revealed units — the guard in gateVideoUnit
  // relies on the state check, so confirm reveal is sticky here too.
  const { node } = fixture();
  Apply.blur(node, Object.assign({}, DECISION, { action: "blur" }));
  swipeRight(node.querySelector(".valyou-reveal"));
  assert.equal(Apply.stateOf(node), "revealed");
});

test("a right swipe reveals; a tap deliberately does not", () => {
  // A tap is the most accidental gesture on a phone — a stray thumb while
  // scrolling would undo the protection the user asked for, showing them the
  // very thing they installed valyou to avoid. Revealing now takes a sideways
  // swipe, which scrolling does not produce.
  const doc = new Document();
  const node = build(doc, { attrs: { role: "article" }, text: "hateful post text here" });
  let revealed = 0;
  Apply.applyDecision(node, { action: "hide", category: "hate_racial", reason: "test" }, {
    onReveal: () => { revealed += 1; },
  });
  assert.equal(Apply.stateOf(node), "hidden");
  const button = node.querySelector(".valyou-reveal");
  assert.ok(button, "the bar must carry a reveal button");

  // A tap must NOT reveal.
  button.dispatch("click");
  button.dispatch("touchend");
  assert.equal(Apply.stateOf(node), "hidden", "a tap must never reveal");
  assert.equal(revealed, 0);

  // A short drag must not reveal either — it has to clear the threshold.
  button.dispatch("pointerdown", { clientX: 10, clientY: 100 });
  button.dispatch("pointermove", { clientX: 40, clientY: 100 });
  assert.equal(Apply.stateOf(node), "hidden", "a short drag must not reveal");

  // A vertical drag is a scroll, not a swipe.
  button.dispatch("pointerdown", { clientX: 10, clientY: 100 });
  button.dispatch("pointermove", { clientX: 20, clientY: 300 });
  assert.equal(Apply.stateOf(node), "hidden", "scrolling must not reveal");

  // A full right swipe does reveal.
  swipeRight(button);
  assert.equal(Apply.stateOf(node), "revealed", "a right swipe must reveal");
  assert.equal(revealed, 1);

  // Repeats must not fire again.
  swipeRight(button);
  button.dispatch("click");
  assert.equal(revealed, 1, "reveal must run exactly once");
});

test("the keyboard can still reveal, since a swipe is impossible there", () => {
  const doc = new Document();
  const node = build(doc, { attrs: { role: "article" }, text: "hateful post text here" });
  let revealed = 0;
  Apply.applyDecision(node, { action: "hide", category: "hate_racial", reason: "test" }, {
    onReveal: () => { revealed += 1; },
  });
  const button = node.querySelector(".valyou-reveal");
  button.dispatch("keydown", { key: "Enter" });
  assert.equal(Apply.stateOf(node), "revealed", "Enter must reveal for keyboard users");
  assert.equal(revealed, 1);
});

test("a desktop drag survives leaving the button and a jittery first move", () => {
  // Found in real Chrome: the "Swipe right" button is barely wider than the
  // threshold, so a mouse drag outran it and Chrome's pointerleave killed the
  // gesture a few pixels short of the reveal. And a mouse reports every pixel,
  // so the first move of a sideways drag is often a stray vertical one, which
  // used to be judged as a scroll and abandon the swipe on the spot.
  const doc = new Document();
  const node = build(doc, { attrs: { role: "article" }, text: "hateful post text here" });
  let revealed = 0;
  Apply.applyDecision(node, { action: "hide", category: "hate_racial", reason: "test" }, {
    onReveal: () => { revealed += 1; },
  });
  const bar = node.querySelector(".valyou-bar");
  const button = node.querySelector(".valyou-reveal");
  const captured = [];
  bar.setPointerCapture = (id) => captured.push(id);

  button.dispatch("pointerdown", { clientX: 10, clientY: 100, pointerId: 7 });
  assert.deepEqual(captured, [7], "the surface must capture the pointer so moves keep arriving");
  button.dispatch("pointermove", { clientX: 10, clientY: 101 }); // jitter: 1px down
  button.dispatch("pointermove", { clientX: 40, clientY: 103 });
  button.dispatch("pointerleave"); // the mouse has outrun the button
  button.dispatch("pointermove", { clientX: 70, clientY: 104 });
  assert.equal(Apply.stateOf(node), "hidden", "still short of the threshold");
  bar.dispatch("pointermove", { clientX: 100, clientY: 105 });
  assert.equal(Apply.stateOf(node), "revealed", "the drag must complete after leaving the button");
  assert.equal(revealed, 1);
});

test("a scroll that starts on the bar is still a scroll once past the slop", () => {
  const doc = new Document();
  const node = build(doc, { attrs: { role: "article" }, text: "hateful post text here" });
  Apply.applyDecision(node, { action: "hide", category: "hate_racial", reason: "test" });
  const button = node.querySelector(".valyou-reveal");
  button.dispatch("pointerdown", { clientX: 10, clientY: 100, pointerId: 1 });
  button.dispatch("pointermove", { clientX: 12, clientY: 100 }); // within slop: undecided
  button.dispatch("pointermove", { clientX: 14, clientY: 140 }); // clearly vertical: released
  button.dispatch("pointermove", { clientX: 200, clientY: 140 }); // later sideways travel is ignored
  assert.equal(Apply.stateOf(node), "hidden", "a scroll must never turn into a reveal");
  const drag = button.dispatch("dragstart");
  assert.equal(drag.defaultPrevented, true, "native drag-and-drop must not steal the swipe");
});

test("with a mouse (desktop), a plain click reveals and no swipe is needed", () => {
  // Desktop Chrome/Brave/Safari: a mouse click is deliberate, so the control
  // is a click, labelled "Show". The swipe is reserved for touch screens.
  const doc = new Document();
  doc.defaultView = {
    matchMedia: (q) => ({ matches: q === "(pointer: fine)" || q === "(hover: hover)" }),
  };
  assert.equal(Apply.revealMode(doc), "tap");
  const post = build(doc, { attrs: { role: "article" }, text: "hateful post text here" });
  let revealed = 0;
  Apply.applyDecision(post, { action: "hide", category: "hate_racial", reason: "test" }, {
    onReveal: () => { revealed += 1; },
  });
  const button = post.querySelector(".valyou-reveal");
  assert.equal(button.textContent, "Show");
  const click = button.dispatch("click");
  assert.equal(click.propagationStopped, true, "the post underneath must not get the click");
  assert.equal(Apply.stateOf(post), "revealed", "a click must reveal on a desktop");
  assert.equal(revealed, 1);
  button.dispatch("click");
  assert.equal(revealed, 1, "reveal must run exactly once");

  // The video shield gets the same treatment.
  const video = build(doc, { attrs: { role: "article" }, text: "a video post" });
  Apply.applyDecision(video, { action: "blur", category: null, reason: "Video hidden" }, {
    onReveal: () => { revealed += 1; },
  });
  assert.equal(video.querySelector(".valyou-reveal").textContent, "Show");
  video.querySelector(".valyou-shield").dispatch("click");
  assert.equal(Apply.stateOf(video), "revealed", "a click anywhere on the shield reveals");
  assert.equal(revealed, 2);
});

test("a touch screen, or a device that cannot say, gets the swipe", () => {
  const coarse = new Document();
  coarse.defaultView = { matchMedia: (q) => ({ matches: q === "(pointer: coarse)" }) };
  assert.equal(Apply.revealMode(coarse), "swipe");
  assert.equal(Apply.revealMode(new Document()), "swipe", "no matchMedia: the safe default");

  // The mobile shell pins the mode regardless of what the WebView reports.
  const fine = new Document();
  fine.defaultView = { matchMedia: () => ({ matches: true }) };
  Apply.setRevealMode("swipe");
  try {
    assert.equal(Apply.revealMode(fine), "swipe");
    const post = build(fine, { attrs: { role: "article" }, text: "hateful post text here" });
    Apply.applyDecision(post, { action: "hide", category: "hate_racial", reason: "test" });
    post.querySelector(".valyou-reveal").dispatch("click");
    assert.equal(Apply.stateOf(post), "hidden", "pinned to swipe: a tap must not reveal");
  } finally {
    Apply.setRevealMode(null);
  }
  assert.equal(Apply.revealMode(fine), "tap", "override cleared: detection is back");
});
