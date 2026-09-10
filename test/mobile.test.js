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
 * Integration test for the mobile injection bundle.
 *
 * This runs the ACTUAL generated `mobile/dist/valyou-inject.js` — the same
 * string react-native-webview would inject — inside a simulated page, and
 * proves the ported engine still finds a post, scores it, hides it, and
 * reports the event over the native bridge. It is the mobile equivalent of
 * loading the extension in a browser.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { Document, build } = require("./helpers/dom.js");

const BUNDLE = path.join(__dirname, "..", "mobile", "dist", "valyou-inject.js");

/** A settings object shaped like the real one, for the native side to inject. */
function mobileSettings(overrides) {
  const base = {
    enabled: true,
    categories: {
      hate_racial: { action: "hide", threshold: 0.55 },
      hate_gender: { action: "hide", threshold: 0.55 },
      violence: { action: "hide", threshold: 0.55 },
      harassment: { action: "blur", threshold: 0.6 },
      rage_bait: { action: "blur", threshold: 0.7 },
    },
    surfaces: { feed: true, comments: true, ads: true, messages: true, reels: true },
    ml: { enabled: false },
    media: { video: "hide", flaggedVideoBlur: true },
    rules: { allowAuthors: [], blockTerms: [], allowTerms: [] },
  };
  return Object.assign(base, overrides || {});
}

/**
 * Build a page context (globals a WebView provides) around the DOM stub, run
 * the bundle in it, and return the sandbox for assertions.
 *
 * @param {Document} doc The stub document, pre-populated.
 * @param {object} settings Settings the native app injects.
 * @returns {{messages: Array, sandbox: object}}
 */
function runBundle(doc, settings) {
  doc.head = doc.createElement("head");
  doc.getElementById = () => null;
  // The video play guard attaches a capturing listener to `document`; the stub
  // has no document-level event surface, so provide a no-op (no autoplay in a
  // static test anyway — the scan path is what we exercise here).
  doc.addEventListener = () => {};

  const messages = [];
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  sandbox.location = { hostname: "facebook.com" };
  sandbox.navigator = { userActivation: { isActive: false } };
  // A media element surface, so the engine's play()/autoplay patches install
  // and can actually be exercised. Without this the whole video guard — the
  // part that decides whether a clip is allowed to start — had no unit
  // coverage at all, and a bug in it could only be found on a real device.
  sandbox.playCalls = [];
  sandbox.HTMLMediaElement = function () {};
  sandbox.HTMLMediaElement.prototype = {
    play() {
      sandbox.playCalls.push(this);
      return Promise.resolve();
    },
    get autoplay() { return this._autoplay; },
    set autoplay(v) { this._autoplay = v; },
  };
  sandbox.Element = function () {};
  sandbox.Element.prototype = { setAttribute() {}, attachShadow() { return { host: null }; } };
  sandbox.DOMException = function (message, name) { this.message = message; this.name = name; };
  sandbox.Promise = Promise;
  sandbox.MutationObserver = function () {
    this.observe = () => {};
  };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.performance = performance;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.atob = atob;
  sandbox.btoa = btoa;
  sandbox.crypto = crypto;
  sandbox.console = console;
  sandbox.__VALYOU__ = { settings };
  sandbox.ReactNativeWebView = {
    postMessage: (s) => messages.push(JSON.parse(s)),
  };

  const code = fs.readFileSync(BUNDLE, "utf8");
  vm.runInNewContext(code, sandbox, { filename: "valyou-inject.js" });
  return { messages, sandbox };
}

/** A Facebook-shaped post in the stub DOM. */
function fbPost(doc, body) {
  return build(doc, {
    tag: "div",
    attrs: { role: "article" },
    children: [
      { tag: "header", children: [{ tag: "a", attrs: { role: "link" }, text: "Someone" }] },
      { tag: "div", text: body },
    ],
  });
}

test("the generated bundle exists and is syntactically valid", () => {
  assert.ok(fs.existsSync(BUNDLE), "run: node mobile/scripts/build-bundle.js");
  const code = fs.readFileSync(BUNDLE, "utf8");
  new vm.Script(code); // throws on a syntax error
  assert.ok(code.includes("VALYOU"), "must contain the engine");
  assert.ok(code.endsWith("true;\n") || code.endsWith("true;"), "must end with true; for react-native-webview");
});

test("injecting the bundle hides a hateful Facebook post and reports it", () => {
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "all immigrants are vermin and should be exterminated"));

  const { messages, sandbox } = runBundle(doc, mobileSettings());

  // The engine registered and ran.
  assert.ok(sandbox.VALYOU && sandbox.VALYOU.Scorer, "engine must self-register on window.VALYOU");
  assert.ok(messages.some((m) => m.type === "ready" && m.platform === "facebook"), "should signal ready");

  // The hateful post is hidden (its category action is 'hide').
  const post = doc.body.children[0];
  assert.equal(sandbox.VALYOU.Apply.stateOf(post), "hidden");

  // And the native side was told about it.
  const filtered = messages.find((m) => m.type === "stats" && m.event === "filtered");
  assert.ok(filtered, "a filtered event must be reported to native");
  assert.equal(filtered.category, "hate_racial");
});

test("a clean Facebook post is left visible", () => {
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "made the best carbonara of my life, recipe in the comments"));

  const { sandbox } = runBundle(doc, mobileSettings());
  const post = doc.body.children[0];
  // Clean text with no video → nothing to do. (No video here, so hide mode's
  // video gate does not apply.)
  assert.equal(sandbox.VALYOU.Apply.stateOf(post), "clean");
});

test("hide video mode gates a clean video post on mobile too", () => {
  const doc = new Document();
  const post = fbPost(doc, "check out this clip");
  post.appendChild(doc.createElement("video"));
  doc.body.appendChild(post);

  const { messages, sandbox } = runBundle(doc, mobileSettings());
  assert.equal(sandbox.VALYOU.Apply.stateOf(post), "blurred", "video gated behind a tap");
  assert.ok(messages.some((m) => m.event === "filtered" && m.action === "blur"));
});

test("the overlay CSS is injected as a <style> tag", () => {
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "hello everyone, lovely day"));
  const { sandbox } = runBundle(doc, mobileSettings());
  // The injector appends a <style> to document.head carrying the overlay CSS.
  const style = sandbox.document.head.children.find((c) => c.tagName === "STYLE");
  assert.ok(style, "overlay <style> must be injected");
  assert.match(style.textContent, /valyou-shield|valyou-bar/, "must carry the overlay rules");
});

test("applySettings re-runs the engine when the native app pushes changes", () => {
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "all immigrants are vermin and should be exterminated"));

  const { sandbox } = runBundle(doc, mobileSettings());
  const post = doc.body.children[0];
  assert.equal(sandbox.VALYOU.Apply.stateOf(post), "hidden");

  // The user turns filtering off in the native settings screen.
  sandbox.__VALYOU__.settings = mobileSettings({ enabled: false });
  sandbox.__VALYOU__.applySettings(sandbox.__VALYOU__.settings);

  // Previous decisions are cleared and, with filtering off, nothing re-hides.
  assert.equal(sandbox.VALYOU.Apply.stateOf(post), null);
});

test("a detached video cannot autoplay, however it is muted", () => {
  // Facebook's SEARCH RESULTS create a <video> in JavaScript and play it while
  // it is still outside the document. It is invisible to every collector, and a
  // fresh element defaults to muted === false, so the "sound means the user did
  // it" rule approved every one of them. The play() patch must refuse it.
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "an ordinary post with nothing wrong in it at all"));
  const { sandbox } = runBundle(doc, mobileSettings({ media: { video: "hide", flaggedVideoBlur: true } }));

  const detached = Object.create(sandbox.HTMLMediaElement.prototype);
  detached.tagName = "VIDEO";
  detached.muted = false;
  detached.isConnected = false; // never inserted into the page
  detached.hasAttribute = () => false;
  detached.setAttribute = () => {};
  detached.getRootNode = function () { return this; };

  const before = sandbox.playCalls.length;
  const result = detached.play();
  if (result && typeof result.catch === "function") result.catch(() => {});
  assert.equal(sandbox.playCalls.length, before, "the real play() must never be reached");
});

test("a video the user tapped is still allowed to play", () => {
  const doc = new Document();
  doc.body.appendChild(fbPost(doc, "an ordinary post with nothing wrong in it at all"));
  const { sandbox } = runBundle(doc, mobileSettings({ media: { video: "hide", flaggedVideoBlur: true } }));

  const approved = Object.create(sandbox.HTMLMediaElement.prototype);
  approved.tagName = "VIDEO";
  approved.muted = false;
  approved.isConnected = true;
  approved.hasAttribute = (n) => n === "data-valyou-approved"; // already approved
  approved.setAttribute = () => {};
  approved.getRootNode = function () { return doc; };

  const before = sandbox.playCalls.length;
  approved.play();
  assert.equal(sandbox.playCalls.length, before + 1, "an approved video must play");
});
