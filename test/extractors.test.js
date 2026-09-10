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
const Extractors = require("../src/content/extractors.js");

/** Settings fragment enabling every surface. */
const ALL_SURFACES = { feed: true, comments: true, ads: true, messages: true, reels: true };

/**
 * Build a Facebook-shaped post.
 *
 * @param {{author?: string, body: string, sponsored?: boolean, children?: Array}} spec
 * @returns {object} Element spec for build().
 */
function facebookPost(spec) {
  const children = [
    {
      tag: "header",
      children: [{ tag: "a", attrs: { role: "link" }, text: spec.author || "Some Person" }],
    },
    { tag: "div", text: spec.body },
  ];
  if (spec.sponsored) {
    children.push({ tag: "a", attrs: { href: "https://facebook.com/ads/about/?x=1" }, text: "" });
  }
  return {
    tag: "div",
    attrs: { role: "article" },
    children: children.concat(spec.children || []),
  };
}

/* ------------------------------------------------------------------ *
 * Platform detection                                                  *
 * ------------------------------------------------------------------ */

test("platformFor recognizes each supported host", () => {
  assert.equal(Extractors.platformFor("www.facebook.com"), "facebook");
  assert.equal(Extractors.platformFor("m.facebook.com"), "facebook");
  assert.equal(Extractors.platformFor("www.instagram.com"), "instagram");
  assert.equal(Extractors.platformFor("www.messenger.com"), "messenger");
  assert.equal(Extractors.platformFor("x.com"), "x");
  assert.equal(Extractors.platformFor("mobile.x.com"), "x");
  assert.equal(Extractors.platformFor("twitter.com"), "x");
  assert.equal(Extractors.platformFor("mobile.twitter.com"), "x");
});

test("platformFor returns null for unrelated hosts", () => {
  assert.equal(Extractors.platformFor("example.com"), null);
  assert.equal(Extractors.platformFor(""), null);
  assert.equal(Extractors.platformFor(null), null);
});

test("platformFor is not fooled by a lookalike domain", () => {
  // Domain-boundary matching: neither a registered lookalike nor a phishing
  // sub-path host may match — and the two-letter x.com domain is the
  // riskiest of all (netflix.com ends with "x.com").
  assert.equal(Extractors.platformFor("facebook.com.evil.net"), null);
  assert.equal(Extractors.platformFor("notfacebook.com"), null);
  assert.equal(Extractors.platformFor("netflix.com"), null);
  assert.equal(Extractors.platformFor("sphinx.com"), null);
  assert.equal(Extractors.platformFor("nottwitter.com"), null);
  assert.equal(Extractors.platformFor("FACEBOOK.COM"), "facebook");
});

/* ------------------------------------------------------------------ *
 * Text reading                                                        *
 * ------------------------------------------------------------------ */

test("readText collects the visible text of a unit", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [{ tag: "span", text: "Hello" }, { tag: "span", text: "world" }],
  });
  assert.equal(Extractors.readText(node), "Hello world");
});

test("expandUnit grows a post to its exclusive card wrapper, stopping at shared containers", () => {
  const doc = new Document();
  // A feed holding two result cards; each card = header ("subject line") +
  // the article. Hiding must cover the CARD (header included) but never the
  // shared feed container.
  const feed = build(doc, { attrs: { role: "feed" } });
  const mkCard = () => {
    const card = build(doc, {});
    const header = build(doc, { tag: "span", text: "Subject line here" });
    const article = build(doc, { attrs: { role: "article" }, text: "post body" });
    card.appendChild(header);
    card.appendChild(article);
    feed.appendChild(card);
    return { card, article };
  };
  const a = mkCard();
  mkCard(); // the neighbour that must never be swallowed
  const expanded = Extractors.expandUnit(a.article);
  assert.equal(expanded, a.card, "should cover the card incl. its header");
});

test("expandUnit never crosses into a wrapper holding another unit", () => {
  const doc = new Document();
  const wrap = build(doc, {});
  const article1 = build(doc, { attrs: { role: "article" }, text: "one" });
  const article2 = build(doc, { attrs: { role: "article" }, text: "two" });
  wrap.appendChild(article1);
  wrap.appendChild(article2);
  assert.equal(Extractors.expandUnit(article1), article1);
});

test("expandUnit still expands a post that carries nested comment previews", () => {
  const doc = new Document();
  // Facebook posts embed comment-preview articles INSIDE the post article.
  // Those must not block expansion to the card (they are ours), while a
  // sibling post next door still must.
  const feed = build(doc, { attrs: { role: "feed" } });
  const card = build(doc, {});
  const header = build(doc, { tag: "span", text: "Subject line" });
  const post = build(doc, { attrs: { role: "article" } });
  const nestedComment = build(doc, { attrs: { role: "article" }, text: "a comment" });
  post.appendChild(nestedComment);
  card.appendChild(header);
  card.appendChild(post);
  feed.appendChild(card);
  const neighbour = build(doc, { attrs: { role: "article" }, text: "other post" });
  feed.appendChild(neighbour);
  assert.equal(Extractors.expandUnit(post), card, "nested comments must not block expansion");
  // And a COMMENT inside the post must never expand past the post itself.
  assert.equal(Extractors.expandUnit(nestedComment), nestedComment);
});

test("findUnits scores a theater/permalink dialog whose caption is not in an article", () => {
  // Opening a post (or a RESHARE) renders it in a role="dialog" overlay whose
  // caption sits outside any role="article" — the shape that let a hateful
  // caption stay readable while only its video got gated.
  const doc = new Document();
  const root = build(doc, {});
  const dialog = build(doc, { attrs: { role: "dialog" } });
  const caption = build(doc, { tag: "span", text: "these people are subhuman vermin and should be wiped out" });
  dialog.appendChild(caption);
  root.appendChild(dialog);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1, "the dialog must yield one unit");
  assert.ok(units[0].text.includes("subhuman vermin"), "caption text must be extracted");
});

test("findUnits defers to the article rules when a dialog wraps a real article", () => {
  const doc = new Document();
  const root = build(doc, {});
  const dialog = build(doc, { attrs: { role: "dialog" } });
  const article = build(doc, { attrs: { role: "article" }, text: "the actual post body text here" });
  dialog.appendChild(article);
  root.appendChild(dialog);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1);
  assert.equal(units[0].node, article, "the article must win, not the dialog");
});

test("findUnits catches a loose caption text block outside any article shell", () => {
  // The theater/reshare shell: a caption in a div[dir=auto] with no article
  // anywhere above it. The last-resort rule must claim it.
  const doc = new Document();
  const root = build(doc, {});
  const shell = build(doc, {});
  const caption = build(doc, {
    attrs: { dir: "auto" },
    text: "these people are subhuman vermin and should be wiped out",
  });
  shell.appendChild(caption);
  root.appendChild(shell);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1);
  assert.equal(units[0].node, caption);
});

test("the loose text rule ignores text that belongs to a post a stronger rule owns", () => {
  const doc = new Document();
  const root = build(doc, {});
  const article = build(doc, { attrs: { role: "article" } });
  const inner = build(doc, { attrs: { dir: "auto" }, text: "ordinary post body text here" });
  article.appendChild(inner);
  root.appendChild(article);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1, "only the article, never its inner text block");
  assert.equal(units[0].node, article);
});

test("a caption in NESTED dir=auto blocks is still claimed (outermost wins)", () => {
  // Facebook nests dir="auto" inside dir="auto". A guard pair that skipped
  // "contains one" AND "inside one" left such captions claimed by NEITHER —
  // the exact hole that let a slur stay readable in the theater view.
  const doc = new Document();
  const root = build(doc, {});
  const outer = build(doc, { attrs: { dir: "auto" } });
  const mid = build(doc, {});
  const inner = build(doc, {
    attrs: { dir: "auto" },
    text: "these people are subhuman vermin and should be wiped out",
  });
  mid.appendChild(inner);
  outer.appendChild(mid);
  root.appendChild(outer);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1, "exactly one unit — the outermost block");
  assert.equal(units[0].node, outer);
  assert.ok(units[0].text.includes("subhuman vermin"));
});

test("site chrome is never filtered — searching a slur must not blur the search UI", () => {
  // The user types a flagged word into search; the field, its dropdown and the
  // results heading all echo it back. Blurring the user's own query would hide
  // the interface they are using.
  const doc = new Document();
  const root = build(doc, {});
  for (const attrs of [{ role: "search" }, { role: "combobox" }, { role: "listbox" }, { role: "banner" }]) {
    const chrome = build(doc, { attrs });
    chrome.appendChild(build(doc, { attrs: { dir: "auto" }, text: "subhuman vermin wiped out" }));
    root.appendChild(chrome);
  }
  assert.equal(Extractors.findUnits(root, { platform: "facebook" }).length, 0);

  // ...while a real post with the same text IS still claimed.
  const post = build(doc, { attrs: { role: "article" }, text: "subhuman vermin wiped out" });
  root.appendChild(post);
  const units = Extractors.findUnits(root, { platform: "facebook" });
  assert.equal(units.length, 1);
  assert.equal(units[0].node, post);
});

test("expandUnit never grows a cover into site chrome", () => {
  const doc = new Document();
  const banner = build(doc, { attrs: { role: "banner" } });
  const card = build(doc, {});
  const post = build(doc, { attrs: { role: "article" }, text: "post" });
  card.appendChild(post);
  banner.appendChild(card);
  assert.equal(Extractors.expandUnit(post), card, "stops below the chrome");
});

test("readText reads MIXED CONTENT — a bare caption text node beside element children", () => {
  // Facebook renders captions exactly like this: the post text is a raw text
  // node whose SIBLINGS are emoji/link <span> elements. A leaf-only reader
  // captures the spans but silently drops the caption — the bug that let
  // slur posts through as "clean". The caption must be extracted.
  const doc = new Document();
  const caption = build(doc, {
    children: [{ tag: "span", text: "🤣" }, { tag: "span", text: "🤣" }],
  });
  caption._text = "You're not welcome here, none of you people are";
  const node = build(doc, { children: [] });
  node.appendChild(caption);
  const text = Extractors.readText(node);
  assert.ok(text.includes("You're not welcome here"), `caption text lost: "${text}"`);
  assert.ok(text.includes("🤣"), "element children must still be read");
});

test("readText skips the user's own draft in a contenteditable", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "div", text: "The post body" },
      { tag: "div", attrs: { contenteditable: "true" }, text: "my half typed reply" },
    ],
  });

  // Classifying the user's own draft would filter their own reply as they
  // typed it — the single most jarring possible failure.
  const text = Extractors.readText(node);
  assert.ok(text.includes("The post body"));
  assert.ok(!text.includes("half typed"));
});

test("readText skips form fields", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "div", text: "real content" },
      { tag: "textarea", text: "draft" },
      { tag: "input", attrs: { value: "search" }, text: "search" },
      { tag: "div", attrs: { role: "textbox" }, text: "another draft" },
    ],
  });

  const text = Extractors.readText(node);
  assert.equal(text, "real content");
});

test("readText skips valyou's own injected UI", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "div", attrs: { class: "valyou-shield" }, text: "Hidden by valyou" },
      { tag: "div", text: "the actual post" },
    ],
  });

  // Otherwise a rescan would ingest our own overlay label as post content.
  assert.equal(Extractors.readText(node), "the actual post");
});

test("readText includes image alt text, where platforms describe content", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "div", text: "look at this" },
      // Instagram-style auto-generated alt text — often the only text signal
      // a meme image carries.
      { tag: "img", attrs: { alt: "May be an image of text that says all of them are vermin" } },
    ],
  });

  const text = Extractors.readText(node);
  assert.ok(text.includes("vermin"), "alt text must feed the classifier");
});

test("readText includes video aria-labels and titles", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "video", attrs: { "aria-label": "Video: wake up sheeple compilation" } },
      { tag: "div", text: "watch this" },
    ],
  });

  const text = Extractors.readText(node);
  assert.ok(text.includes("sheeple"));
});

test("readText ignores media elements with no descriptive text", () => {
  const doc = new Document();
  const node = build(doc, {
    children: [
      { tag: "img", attrs: { alt: "  " } },
      { tag: "video" },
      { tag: "div", text: "just the caption" },
    ],
  });

  assert.equal(Extractors.readText(node), "just the caption");
});

test("a hateful alt text alone is enough to filter the unit", () => {
  // End-to-end through findUnits: bland caption, hateful platform-generated
  // image description — the unit must still be scoreable.
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      attrs: { role: "article" },
      children: [
        { tag: "header", children: [{ tag: "a", attrs: { role: "link" }, text: "Someone" }] },
        { tag: "div", text: "thoughts?" },
        { tag: "img", attrs: { alt: "May be an image of text that says immigrants are vermin" } },
      ],
    })
  );

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.ok(units[0].text.includes("vermin"));
});

test("readText stops once the character budget is exhausted", () => {
  const doc = new Document();
  const node = build(doc, {
    children: Array.from({ length: 50 }, () => ({ tag: "span", text: "x".repeat(100) })),
  });
  assert.ok(Extractors.readText(node, 500).length < 700);
});

/* ------------------------------------------------------------------ *
 * Author extraction                                                   *
 * ------------------------------------------------------------------ */

test("extractAuthor finds the profile link in the header", () => {
  const doc = new Document();
  const node = build(doc, facebookPost({ author: "Aunt Carol", body: "hello everyone" }));
  assert.equal(Extractors.extractAuthor(node), "Aunt Carol");
});

test("extractAuthor returns null when no author link is present", () => {
  const doc = new Document();
  const node = build(doc, { attrs: { role: "article" }, children: [{ text: "body only" }] });
  assert.equal(Extractors.extractAuthor(node), null);
});

test("extractAuthor rejects an implausibly long name", () => {
  const doc = new Document();
  const node = build(doc, {
    attrs: { role: "article" },
    children: [
      { tag: "header", children: [{ tag: "a", attrs: { role: "link" }, text: "x".repeat(200) }] },
    ],
  });
  // A 200-character "name" means the selector matched the post body, not a
  // profile link — better to have no author than a wrong one.
  assert.equal(Extractors.extractAuthor(node), null);
});

/* ------------------------------------------------------------------ *
 * Sponsored detection                                                 *
 * ------------------------------------------------------------------ */

test("isSponsored detects the ad-preferences link", () => {
  const doc = new Document();
  const node = build(doc, facebookPost({ body: "buy our thing", sponsored: true }));

  // Facebook scrambles the word "Sponsored" to defeat blockers, but the ad
  // preferences link has to keep working.
  assert.equal(Extractors.isSponsored(node), true);
});

test("isSponsored detects an aria-label marker", () => {
  const doc = new Document();
  const node = build(doc, {
    attrs: { role: "article", "aria-label": "Sponsored post" },
    children: [{ text: "buy our thing" }],
  });
  assert.equal(Extractors.isSponsored(node), true);
});

test("isSponsored only scans the header region for the word itself", () => {
  const doc = new Document();
  // A post that merely *discusses* advertising must not be classed as an ad.
  const node = build(doc, {
    attrs: { role: "article" },
    children: [
      { tag: "div", text: "x".repeat(200) },
      { tag: "div", text: "I hate how much sponsored content is in my feed lately" },
    ],
  });
  assert.equal(Extractors.isSponsored(node), false);
});

test("isSponsored returns false for an ordinary post", () => {
  const doc = new Document();
  const node = build(doc, facebookPost({ body: "just a normal post from a friend" }));
  assert.equal(Extractors.isSponsored(node), false);
});

/* ------------------------------------------------------------------ *
 * Kind refinement                                                     *
 * ------------------------------------------------------------------ */

test("a nested article is treated as a comment, not a post", () => {
  const doc = new Document();
  const root = build(doc, {
    attrs: { role: "article" },
    children: [
      { tag: "div", text: "the original post text goes here" },
      {
        tag: "div",
        attrs: { role: "article" },
        children: [{ tag: "div", text: "a reply from someone else" }],
      },
    ],
  });
  doc.body.appendChild(root);

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  const kinds = units.map((u) => u.kind).sort();
  assert.deepEqual(kinds, ["comment", "post"]);
});

test("a sponsored post is classified as an ad rather than a feed post", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, facebookPost({ body: "limited time offer", sponsored: true })));

  const [unit] = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  assert.equal(unit.kind, "ad");
  assert.equal(unit.surface, "ads");
});

/* ------------------------------------------------------------------ *
 * findUnits                                                           *
 * ------------------------------------------------------------------ */

test("findUnits returns each post with its text and author", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, facebookPost({ author: "Aunt Carol", body: "hello everyone" })));
  doc.body.appendChild(build(doc, facebookPost({ author: "Dave", body: "second post here" })));

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });

  assert.equal(units.length, 2);
  assert.equal(units[0].author, "Aunt Carol");
  assert.ok(units[0].text.includes("hello everyone"));
  assert.equal(units[0].kind, "post");
});

test("findUnits honours the surface toggles", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, facebookPost({ body: "an ordinary friend post" })));
  doc.body.appendChild(build(doc, facebookPost({ body: "an advert for something", sponsored: true })));

  const surfaces = Object.assign({}, ALL_SURFACES, { ads: false });
  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces });

  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "post");
});

test("findUnits skips units already processed", () => {
  const doc = new Document();
  const node = build(doc, facebookPost({ body: "hello everyone how are you" }));
  node.setAttribute("data-valyou", "clean");
  doc.body.appendChild(node);

  // Idempotence: React re-renders constantly and our own writes trigger the
  // observer, so re-scanning must be a no-op.
  assert.equal(Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES }).length, 0);
});

test("findUnits skips units with too little text to judge", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, facebookPost({ body: "ok" })));

  const units = Extractors.findUnits(doc.body, {
    platform: "facebook",
    surfaces: ALL_SURFACES,
    minLength: 8,
  });
  // The author name alone should not push a two-character post over the line.
  assert.ok(units.every((u) => u.text.length >= 8));
});

test("findUnits returns nothing for an unknown platform", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, facebookPost({ body: "some content here" })));
  assert.deepEqual(Extractors.findUnits(doc.body, { platform: "myspace", surfaces: ALL_SURFACES }), []);
});

test("findUnits reads Instagram articles", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      tag: "article",
      children: [
        { tag: "header", children: [{ tag: "a", text: "someone" }] },
        { tag: "div", text: "an instagram caption with enough text" },
      ],
    })
  );

  const units = Extractors.findUnits(doc.body, { platform: "instagram", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "post");
  assert.ok(units[0].text.includes("instagram caption"));
});

test("findUnits reads Messenger message rows", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      attrs: { role: "row" },
      children: [{ tag: "div", text: "a direct message with some content" }],
    })
  );

  const units = Extractors.findUnits(doc.body, { platform: "messenger", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "message");
  assert.equal(units[0].surface, "messages");
});

/* ------------------------------------------------------------------ *
 * X (x.com / twitter.com)                                             *
 * ------------------------------------------------------------------ */

/**
 * Build an X-shaped tweet article.
 *
 * @param {{author?: string, body: string, promoted?: boolean}} spec
 * @returns {object} Element spec for build().
 */
function tweet(spec) {
  const children = [
    {
      tag: "div",
      attrs: { "data-testid": "User-Name" },
      children: [{ tag: "a", attrs: { role: "link" }, text: spec.author || "Some Account" }],
    },
    { tag: "div", attrs: { "data-testid": "tweetText" }, text: spec.body },
  ];
  if (spec.promoted) {
    children.push({ tag: "div", attrs: { "data-testid": "placementTracking" }, text: "" });
  }
  return { tag: "article", attrs: { "data-testid": "tweet" }, children };
}

test("findUnits reads tweets with text and author", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, tweet({ author: "Jordan Miles", body: "a tweet with enough text to score" })));

  const units = Extractors.findUnits(doc.body, { platform: "x", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "post");
  assert.equal(units[0].surface, "feed");
  assert.equal(units[0].author, "Jordan Miles");
  assert.ok(units[0].text.includes("a tweet with enough text"));
});

test("a promoted tweet is classified as an ad via placementTracking", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, tweet({ body: "buy this amazing thing today", promoted: true })));

  const [unit] = Extractors.findUnits(doc.body, { platform: "x", surfaces: ALL_SURFACES });
  assert.equal(unit.kind, "ad");
  assert.equal(unit.surface, "ads");
});

test("a tweet merely containing the word 'promoted' is not an ad", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, tweet({ body: "so proud, my friend just got promoted at work today!" }))
  );

  // The word appears in the body, not the header slice, and there is no
  // placementTracking container — must stay a regular post.
  const [unit] = Extractors.findUnits(doc.body, { platform: "x", surfaces: ALL_SURFACES });
  assert.equal(unit.kind, "post");
});

/* ------------------------------------------------------------------ *
 * Video detection                                                     *
 * ------------------------------------------------------------------ */

test("detectsVideo finds a bare video element", () => {
  const doc = new Document();
  const node = build(doc, { children: [{ tag: "video" }] });
  assert.equal(Extractors.detectsVideo(node, "post"), true);
});

test("detectsVideo finds a lazy player container before the video hydrates", () => {
  const doc = new Document();
  // X scaffolds the player container before injecting <video> on play.
  const node = build(doc, {
    children: [{ tag: "div", attrs: { "data-testid": "videoComponent" } }],
  });
  assert.equal(Extractors.detectsVideo(node, "post"), true);
});

test("detectsVideo treats every reel as video by definition", () => {
  const doc = new Document();
  const node = build(doc, { children: [{ tag: "div", text: "just a caption" }] });
  assert.equal(Extractors.detectsVideo(node, "reel"), true);
});

test("detectsVideo returns false for a plain text post", () => {
  const doc = new Document();
  const node = build(doc, { children: [{ tag: "div", text: "no media here at all" }] });
  assert.equal(Extractors.detectsVideo(node, "post"), false);
});

test("findUnits flags units that contain video", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      attrs: { role: "article" },
      children: [{ tag: "div", text: "check out this clip" }, { tag: "video" }],
    })
  );

  const [unit] = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  assert.equal(unit.hasVideo, true);
});

test("a caption-less video is surfaced despite short text", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      attrs: { role: "article" },
      children: [{ tag: "video" }], // no caption
    })
  );

  // Would be dropped for short text — but block/hide modes must be able to gate
  // it, so it has to reach the pipeline.
  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.equal(units[0].hasVideo, true);
});

test("a caption-less non-video unit is still dropped for short text", () => {
  const doc = new Document();
  doc.body.appendChild(build(doc, { attrs: { role: "article" }, children: [{ tag: "div", text: "hi" }] }));
  assert.equal(
    Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES }).length,
    0
  );
});

test("findUnits reads X direct messages under the messages surface", () => {
  const doc = new Document();
  doc.body.appendChild(
    build(doc, {
      attrs: { "data-testid": "messageEntry" },
      children: [{ tag: "div", text: "an x direct message with plenty of text" }],
    })
  );

  const units = Extractors.findUnits(doc.body, { platform: "x", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "message");
  assert.equal(units[0].surface, "messages");
});

test("a tweet matching both the testid and role selectors is returned once", () => {
  const doc = new Document();
  const node = build(doc, tweet({ body: "long enough text for the scorer here" }));
  node.setAttribute("role", "article"); // matches the fallback rule too
  doc.body.appendChild(node);

  const units = Extractors.findUnits(doc.body, { platform: "x", surfaces: ALL_SURFACES });
  assert.equal(units.length, 1, "dedup across overlapping rules");
});

test("findUnits catches Facebook feed stories that have no inner article", () => {
  const doc = new Document();
  const feed = build(doc, {
    attrs: { role: "feed" },
    children: [
      // A normal post (has an article) — handled by the article rule.
      {
        tag: "div",
        attrs: { "aria-posinset": "1" },
        children: [{ tag: "div", attrs: { role: "article" }, children: [{ tag: "div", text: "a normal feed post with text" }] }],
      },
      // A suggested/media story with NO article — must be caught by the fallback.
      {
        tag: "div",
        attrs: { "aria-posinset": "2" },
        children: [{ tag: "div", text: "suggested content that would otherwise be missed entirely" }],
      },
    ],
  });
  doc.body.appendChild(feed);

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  const texts = units.map((u) => u.text);
  assert.ok(
    texts.some((t) => t.includes("suggested content")),
    "the article-less story must be captured"
  );
  // And nothing double-processed: the post-with-article appears exactly once.
  assert.equal(texts.filter((t) => t.includes("a normal feed post")).length, 1);
});

test("the posinset fallback does not double-process a story that has an article", () => {
  const doc = new Document();
  const feed = build(doc, {
    attrs: { role: "feed" },
    children: [
      {
        tag: "div",
        attrs: { "aria-posinset": "1" },
        children: [
          { tag: "div", attrs: { role: "article" }, children: [{ tag: "div", text: "the real post content here" }] },
        ],
      },
    ],
  });
  doc.body.appendChild(feed);

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  // Exactly one unit — the article — not the wrapper too.
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "post");
});

test("findUnits never returns the same node twice", () => {
  const doc = new Document();
  // A node matching two rules must still be reported once.
  doc.body.appendChild(
    build(doc, {
      attrs: { role: "row", "aria-label": "Message", class: "" },
      children: [{ tag: "div", text: "a message that is long enough to score" }],
    })
  );

  const units = Extractors.findUnits(doc.body, { platform: "facebook", surfaces: ALL_SURFACES });
  const nodes = new Set(units.map((u) => u.node));
  assert.equal(nodes.size, units.length);
});

test("a flagged search result covers only itself, not the whole results list", () => {
  // Facebook search results are plain text blocks, not role="article" posts, so
  // the foreign-unit check missed them: one flagged result expanded past its
  // neighbours and covered the entire list under a single bar — and revealing
  // that one post revealed every post with it.
  const doc = new Document();
  const results = build(doc, {});
  const cards = [];
  const posts = [];
  for (let i = 0; i < 4; i += 1) {
    const card = build(doc, {});
    card.appendChild(build(doc, { tag: "span", text: `Result header ${i}` }));
    const text = build(doc, { attrs: { dir: "auto" }, text: `post number ${i} with words in it` });
    card.appendChild(text);
    results.appendChild(card);
    cards.push(card);
    posts.push(text);
  }
  const expanded = Extractors.expandUnit(posts[0]);
  assert.equal(expanded, cards[0], "must stop at its own card");
  assert.equal(
    expanded.querySelectorAll('[dir="auto"]').length,
    1,
    "the cover must contain exactly one post"
  );
});
