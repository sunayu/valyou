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
 * Finding and reading the units of content on a page.
 *
 * ------------------------------------------------------------------------
 * BEGINNER ORIENTATION
 * ------------------------------------------------------------------------
 * A "unit" here means one self-contained chunk of social content: a single
 * feed post, a comment, an ad, or a direct message. The browser represents
 * the whole page as a tree of elements called the DOM (Document Object
 * Model). This file's job is to walk that tree, locate each unit, and read
 * its text so another layer can decide whether to filter it.
 *
 * This file only READS the DOM — it never changes the page. The counterpart
 * file, apply.js, does all the WRITING (hiding, blurring, tagging). Keeping
 * "figure out what's here" separate from "change the page" is a deliberate
 * design choice: reading code with no side effects is easy to reason about
 * and easy to test with a fake/stub DOM, and a bug in a read-only function
 * can never corrupt the live page.
 *
 * HOW WE FIND THINGS — AND WHY IT LOOKS THE WAY IT DOES:
 * Facebook and Instagram ship obfuscated, machine-generated class names that
 * rotate frequently, so any selector built on them breaks within weeks. What
 * does not rotate is the ARIA structure, because assistive technology depends
 * on it and both sites are legally obliged to keep it working. (ARIA is a set
 * of `role="..."` and `aria-*` attributes that describe an element's purpose
 * to screen readers, e.g. role="article" for a post, role="feed" for the
 * scrolling list.) Every selector here is therefore anchored on `role`,
 * semantic tags, and `aria-*` — the layer with the strongest incentive to
 * stay stable. Those quoted strings like 'div[role="article"]' are CSS
 * selectors: a mini query language for "find elements matching this shape."
 *
 * All functions are pure with respect to the DOM: they read, they never
 * mutate. Mutation lives in apply.js. That split is what lets the whole
 * extraction layer be unit tested against a lightweight DOM stub.
 */
// ---------------------------------------------------------------------------
// The UMD (Universal Module Definition) wrapper below is a common JavaScript
// pattern for making one file work in several environments without changes.
// It is an IIFE (Immediately Invoked Function Expression): a function that is
// defined and called in the same breath — note the `(function(){...})(...)`
// shape, where the trailing `(...)` runs it right away. It receives `root`
// (the global object — `self` inside a browser tab/extension, otherwise
// `globalThis`) and `factory` (the function further down that actually builds
// this module). It publishes the result two ways: onto `root.VALYOU.Extractors`
// so browser code can reach it, and onto `module.exports` so the Node.js test
// runner can `require()` it. Wrapping everything in a function also keeps our
// helper names private instead of leaking into the global scope.
(function (root, factory) {
  const mod = factory();
  // `root.VALYOU = root.VALYOU || {}` means "reuse the existing VALYOU object
  // if one exists, otherwise create an empty one" — a standard guard so that
  // whichever of our files loads first sets up the shared namespace.
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Extractors = mod;
  // In the Node test environment `module` exists; in the browser it does not.
  // This line exports the module for tests without erroring in the browser.
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // "use strict" opts this file into JavaScript's stricter rules, which turn
  // silent mistakes (like assigning to an undeclared variable) into loud errors.
  "use strict";

  /**
   * Per-platform unit definitions, in priority order. `surface` maps to the
   * user-facing on/off toggles in settings.
   *
   * This is a lookup table keyed by platform name. Each value is an array of
   * "rules" tried in order (top to bottom). A rule says: "elements matching
   * this CSS `selector` are units of `kind`, governed by the `surface`
   * toggle." `kind` is our internal label (post/comment/ad/message); `surface`
   * is the settings switch the user flips (feed/comments/ads/messages). Some
   * rules add `skipIfContains` to avoid double-processing — see notes inline.
   */
  const PLATFORM_RULES = {
    facebook: [
      // Selector reading guide: `div[role="row"][aria-label]` means "a <div>
      // that has BOTH a role attribute equal to 'row' AND any aria-label
      // attribute." Square brackets test attributes; stacking them requires
      // all of them. Messenger threads render each chat message as such a row.
      { kind: "message", surface: "messages", selector: 'div[role="row"][aria-label]' },
      // A Facebook feed post is a <div role="article"> — the ARIA role that
      // marks a standalone, self-contained piece of content. This is our
      // primary, most reliable post selector on desktop.
      { kind: "post", surface: "feed", selector: 'div[role="article"]' },
      // Feed stories that never expose an inner article — suggested posts,
      // some media/reel stories, certain sponsored formats. Every feed story
      // is a posinset item inside role="feed"; `skipIfContains` drops the ones
      // the article rule already handled, so nothing is processed twice.
      {
        kind: "post",
        surface: "feed",
        selector: 'div[role="feed"] div[aria-posinset]',
        skipIfContains: 'div[role="article"]',
      },
      // Mobile web (m.facebook.com, the touch site) renders each feed story as
      // a semantic <article> element rather than a role="article" div. Match it
      // as a fallback, skipping any that already wrap a role-based article so a
      // story is never processed twice. The desktop rules above still win on
      // www.facebook.com. Provisional — see mobile/README.md → selector
      // verification (needs a logged-in mobile DOM to confirm/extend).
      {
        kind: "post",
        surface: "feed",
        selector: "article",
        skipIfContains: 'div[role="article"]',
      },
      // THEATER / PERMALINK MODAL. Opening a post (especially a video, or a
      // RESHARE whose own caption sits above the shared item) renders it in a
      // role="dialog" overlay whose caption is NOT inside any role="article" —
      // so none of the rules above see it, and a hateful caption stayed
      // readable while only the video got gated. skipIfContains defers to the
      // article rules whenever the dialog does contain a proper article, so
      // ordinary modals are unaffected.
      {
        kind: "post",
        surface: "feed",
        selector: 'div[role="dialog"]',
        skipIfContains: 'div[role="article"], article',
      },
      // LAST RESORT — structure-independent text blocks.
      //
      // Facebook renders the same post through many shells (theater overlays,
      // reshare wrappers, search-result cards, permalink modals) and keeps
      // changing them; every shell-specific selector above is a guess that can
      // go stale. This rule stops guessing: `div[dir="auto"]` is how Facebook
      // marks a run of user-authored text ANYWHERE, so a caption is caught no
      // matter which shell holds it.
      //
      // It is safe because it is doubly bounded: `skipIfInside` ignores text
      // that belongs to a post/comment/row a stronger rule already judged (and
      // anything already processed), and the scorer still has to find real
      // hate — clean text yields "off" and is never touched. The unit is the
      // text block itself; expandUnit then grows the cover to its card.
      // Claim the OUTERMOST such block: skipIfInside alone does that (a nested
      // dir="auto" is inside another one and is skipped). Note there is
      // deliberately NO skipIfContains here — Facebook nests dir="auto" blocks
      // inside each other, so a "skip if it contains one" guard would drop the
      // outer block while skipIfInside dropped the inner, and the caption
      // would be claimed by neither.
      {
        kind: "post",
        surface: "feed",
        selector: 'div[dir="auto"]',
        skipIfInside: 'div[role="article"], article, div[role="row"], div[dir="auto"]',
      },
    ],
    messenger: [
      // Standalone Messenger site: every message bubble is a role="row".
      { kind: "message", surface: "messages", selector: 'div[role="row"]' },
    ],
    instagram: [
      { kind: "message", surface: "messages", selector: 'div[role="row"]' },
      // A bare `article` selector matches the semantic <article> HTML tag —
      // Instagram wraps each feed post in one.
      { kind: "post", surface: "feed", selector: "article" },
      // A descendant selector: parts separated by spaces mean "nested inside."
      // This reads "a span[dir=auto] that is inside a div[role=button] that is
      // inside a <ul>" — the shape Instagram uses for the text of a comment.
      { kind: "comment", surface: "comments", selector: 'ul div[role="button"] span[dir="auto"]' },
    ],
    // X anchors on data-testid, which its own automated tests depend on —
    // the closest thing the site has to a stable contract, alongside ARIA.
    // Replies are structurally identical to tweets (not nested), so every
    // tweet is a feed unit; the comments surface toggle does not apply here.
    x: [
      // `data-testid` is a custom attribute X adds for its own test automation.
      // Because their tests would break if it changed, it is nearly as stable
      // as ARIA — hence we lean on it here.
      { kind: "message", surface: "messages", selector: 'div[data-testid="messageEntry"]' },
      // `article[data-testid="tweet"]` = an <article> tag that also has
      // data-testid="tweet". Combining a tag name with an attribute test
      // narrows the match to exactly the tweet container.
      { kind: "post", surface: "feed", selector: 'article[data-testid="tweet"]' },
      // Fallback for tweets that lack the testid but still carry the ARIA role.
      { kind: "post", surface: "feed", selector: 'article[role="article"]' },
    ],
  };

  /**
   * Elements whose text must never be classified: the user's own draft, and
   * valyou's own injected UI (classifying our own "hidden by valyou" label
   * would be an amusing infinite loop).
   */
  /**
   * SITE CHROME — never content, never filtered.
   *
   * The search box, its suggestion dropdown, the results heading, the top bar
   * and nav rails all echo whatever the USER typed. Searching for a slur (to
   * check the filter, to report a page, to research a term) must not blur the
   * user's own query back at them — that hides the interface they are trying
   * to use and looks like a bug. Everything inside these containers is skipped
   * outright, on every platform.
   *
   * `[role=search]` / `combobox` / `listbox` / `option` cover the search field
   * and its dropdown; `banner`/`navigation`/`toolbar`/`menu` cover the top bar
   * and rails; `<header>`/`<nav>` catch the semantic equivalents.
   */
  const CHROME_SELECTORS = [
    '[role="search"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="banner"]',
    '[role="navigation"]',
    '[role="toolbar"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="menuitem"]',
    '[role="tablist"]',
    "header",
    "nav",
  ].join(", ");

  const EXCLUDED_SELECTORS = [
    // `[contenteditable="true"]` and `[role="textbox"]`, plus <textarea> and
    // <input>, are all places the USER types. We skip them so a half-written
    // reply is never scored as if it were someone else's post.
    '[contenteditable="true"]',
    '[role="textbox"]',
    "textarea",
    "input",
    // A leading dot targets a CSS class: `.valyou-shield` matches any element
    // with class="valyou-shield". These two are the overlays apply.js injects;
    // reading our own labels back in would create a feedback loop.
    ".valyou-shield",
    ".valyou-bar",
  ];

  /**
   * Marker attribute set on units we have already handled.
   *
   * We stamp this HTML attribute onto a unit once it has been processed. On
   * the next scan we can cheaply skip anything that already carries it, which
   * matters because these pages re-render constantly and we re-scan often.
   */
  const PROCESSED_ATTR = "data-valyou";

  /**
   * True when `host` is `domain` or a subdomain of it.
   *
   * The dot-or-exact boundary matters twice over: "netflix.com" must not
   * match the domain "x.com", and "notfacebook.com" must not match
   * "facebook.com" — a bare endsWith() gets both of those wrong.
   *
   * @param {string} host Lowercased hostname.
   * @param {string} domain Registrable domain to test against.
   * @returns {boolean}
   */
  function isDomain(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  /**
   * Identify the platform from a hostname.
   *
   * @param {string} hostname e.g. "www.facebook.com".
   * @returns {"facebook"|"instagram"|"messenger"|"x"|null}
   */
  function platformFor(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (isDomain(host, "messenger.com")) return "messenger";
    if (isDomain(host, "instagram.com")) return "instagram";
    if (isDomain(host, "facebook.com")) return "facebook";
    if (isDomain(host, "x.com") || isDomain(host, "twitter.com")) return "x";
    return null;
  }

  /**
   * Walk up from a node looking for an ancestor that matches a selector,
   * excluding the node itself.
   *
   * Used to tell a comment from a post: on Facebook both are
   * `div[role="article"]`, and the only reliable difference is that a comment
   * is nested inside another one.
   *
   * @param {Element} node Starting element.
   * @param {string} selector CSS selector.
   * @returns {Element|null} Nearest matching ancestor, or null.
   */
  function ancestorMatching(node, selector) {
    // `element.parentElement` steps one level UP the DOM tree (to the element
    // that contains this one). Starting at the parent, not the node itself,
    // is how we exclude the node from its own ancestor search.
    let current = node.parentElement || null;
    while (current) {
      // `element.matches(selector)` returns true if THIS element matches the
      // CSS selector. We guard with a typeof check first because our test
      // stubs, and some detached nodes, may not implement matches().
      if (typeof current.matches === "function" && current.matches(selector)) return current;
      // Climb one more level and loop until we hit the top (parentElement
      // becomes null at the document root), giving up if nothing matched.
      current = current.parentElement || null;
    }
    return null;
  }

  /**
   * True when this element is an advertisement.
   *
   * Facebook actively obscures the word "Sponsored" (scrambled spans, CSS
   * reordering, decoy nodes) to defeat ad blockers, so text matching alone is
   * unreliable. The ad-preferences link is checked first because it is a
   * functional element that has to keep working.
   *
   * @param {Element} node Candidate unit.
   * @returns {boolean}
   */
  function isSponsored(node) {
    // `node.querySelector(sel)` searches this unit's subtree and returns the
    // FIRST descendant matching the selector, or null. We only need presence,
    // so `if (node.querySelector(...))` reads as "does this contain one?".
    if (typeof node.querySelector === "function") {
      // `a[href*="/ads/about"]` = an <a> link whose href attribute CONTAINS
      // that substring (`*=` means "contains", vs `=` for exact match). The
      // comma makes it two selectors in one — matching either link. Ads carry
      // a working "Why am I seeing this ad?" link, which is hard to disguise.
      if (node.querySelector('a[href*="/ads/about"], a[href*="/ads/preferences"]')) return true;
      // X wraps promoted tweets in a placementTracking container — a
      // functional element its delivery pipeline depends on, so it outlives
      // any visual "Ad" label restyling.
      if (node.querySelector('div[data-testid="placementTracking"]')) return true;
    }
    const label = attr(node, "aria-label") || "";
    if (/sponsor|advertis|promoted/i.test(label)) return true;

    // Fall back to a text scan over the first part of the unit — the ad
    // marker appears in the header, and scanning the whole post would flag
    // any post that merely discusses advertising.
    const head = readText(node).slice(0, 120);
    if (/\bsponsored\b|\bpaid partnership\b|\bsuggested for you\b/i.test(head)) return true;

    // X's "Promoted"/"Ad" label sits at the very top of the unit, above the
    // author. Tweets are short, so an unanchored match would catch ordinary
    // sentences ("my friend just got promoted!") that land inside the head
    // window — the start anchor is what makes this safe.
    return /^(?:promoted|ad)\b/i.test(head);
  }

  /**
   * Read an attribute defensively; stub DOMs and detached nodes may not
   * implement getAttribute.
   *
   * @param {Element} node Element to read.
   * @param {string} name Attribute name.
   * @returns {string|null}
   */
  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return null;
    return node.getAttribute(name);
  }

  /**
   * Collect the visible text of a unit, skipping excluded subtrees.
   *
   * Deliberately not `node.textContent`: that would swallow the user's own
   * half-typed reply sitting in a contenteditable inside the same article,
   * and would re-ingest valyou's own overlay text.
   *
   * @param {Element} node Root of the unit.
   * @param {number} [limit=4000] Character budget; traversal stops once hit.
   * @returns {string} Concatenated text, whitespace-collapsed.
   */
  function readText(node, limit = 4000) {
    // `parts` collects text fragments we find; we join them at the end.
    // `budget` is a running character allowance so a giant thread can't make
    // us read (and later send) an unbounded amount of text. `limit = 4000` is
    // a default parameter: callers may omit it and get 4000.
    const parts = [];
    let budget = limit;

    /**
     * Depth-first walk, pruning excluded subtrees.
     *
     * "Depth-first" means we fully explore one child (and its children, and
     * theirs) before moving to the next sibling. `walk` calls itself on each
     * child — this self-calling style is called recursion. It is defined
     * inside readText so it can share the `parts` and `budget` variables.
     */
    function walk(current) {
      // Stop early if we ran out of node or ran out of character budget.
      if (!current || budget <= 0) return;

      // If this element is one of the user-input / our-own-UI zones, skip its
      // entire subtree by returning before we descend into it.
      if (typeof current.matches === "function") {
        for (const selector of EXCLUDED_SELECTORS) {
          if (current.matches(selector)) return;
        }
      }

      // Media elements carry their text in attributes, not text nodes:
      // Instagram writes auto-generated alt text describing image contents
      // ("May be an image of ..."), and players label videos via aria-label.
      // Without this, a hateful meme image with a bland caption contributes
      // nothing to the score even though the platform itself described it.
      // `tagName` is the element's HTML tag in UPPERCASE, e.g. "DIV", "IMG".
      const tag = current.tagName || "";
      if (tag === "IMG" || tag === "VIDEO") {
        const label =
          (tag === "IMG"
            ? attr(current, "alt")
            : attr(current, "aria-label") || attr(current, "title")) || "";
        const trimmed = label.trim();
        if (trimmed) {
          parts.push(trimmed);
          budget -= trimmed.length;
        }
        return; // sources/tracks under a video carry no useful text
      }

      // Read this element's DIRECT text nodes and recurse into its element
      // children. `childNodes` (unlike `children`) includes raw TEXT nodes
      // (nodeType 3) sitting between elements — MIXED CONTENT. This matters
      // enormously on Facebook: a caption is often a bare text node whose
      // siblings are emoji/link <span>s. An earlier version read text only at
      // LEAF elements, so it captured the emoji spans but silently skipped
      // the caption text node next to them — the actual post text never
      // reached the scorer and hateful posts sailed through as "clean".
      // Reading text nodes exactly where they live (and only there) also
      // avoids double-counting: each piece of text belongs to exactly one
      // parent, so no word is collected twice on the way down.
      const kids = current.childNodes || [];
      for (const child of kids) {
        if (budget <= 0) return;
        if (child.nodeType === 3) {
          // A text node: its textContent is the literal text. Trim and keep.
          const text = (child.textContent || "").trim();
          if (text) {
            parts.push(text);
            budget -= text.length;
          }
        } else if (child.nodeType === 1) {
          walk(child); // element: descend (exclusions re-checked inside)
        }
      }
    }

    walk(node);
    // Join the fragments with spaces, then `replace(/\s+/g, " ")` collapses any
    // run of whitespace (spaces, tabs, newlines) into a single space so the
    // scorer sees clean, normalized text. `/\s+/g` is a regular expression:
    // \s = whitespace, + = one or more, g = replace every occurrence.
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  /**
   * Best-effort author name for a unit, used only for the allowlist check.
   *
   * The name never leaves the device: it is compared locally against the
   * user's allowlist and is deliberately excluded from anything sent to the
   * API.
   *
   * @param {Element} node Root of the unit.
   * @returns {string|null} Author display name, or null when not found.
   */
  function extractAuthor(node) {
    if (typeof node.querySelector !== "function") return null;

    // Facebook and Instagram put the author in a heading-linked profile
    // anchor at the top of the unit; X labels its author block with a
    // data-testid whose first link is the display name.
    // Tried in order, most specific/reliable first. Each is a descendant
    // selector: e.g. 'h2 a[role="link"]' = "a link inside an <h2> heading."
    // We return as soon as one produces a plausible name.
    const candidates = [
      'div[data-testid="User-Name"] a[role="link"]',
      'h2 a[role="link"]',
      'h3 a[role="link"]',
      'h4 a[role="link"]',
      'strong a[role="link"]',
      'header a[role="link"]',
      "header a",
    ];
    for (const selector of candidates) {
      const found = node.querySelector(selector);
      // `continue` skips to the next selector when this one matched nothing.
      if (!found) continue;
      const name = (found.textContent || "").trim();
      // Guard against absurdly long "names" (a mis-match that grabbed a whole
      // paragraph); a real display name is short.
      if (name && name.length <= 80) return name;
    }
    return null;
  }

  /**
   * Determine the effective kind of a matched node, refining `post` into
   * `comment` (nested) or `ad` (sponsored).
   *
   * @param {Element} node Matched element.
   * @param {{kind: string, selector: string}} rule Rule that matched.
   * @returns {string} One of post | comment | ad | message | reel.
   */
  function refineKind(node, rule) {
    // Only "post" needs refining; message/etc. rules already know their kind.
    if (rule.kind !== "post") return rule.kind;
    if (isSponsored(node)) return "ad";
    // If this "post" is itself nested inside another element matching the same
    // post selector, it is actually a comment on that post (see
    // ancestorMatching's docs — comments and posts share a selector).
    if (ancestorMatching(node, rule.selector)) return "comment";
    return "post";
  }

  /**
   * Selectors that indicate a unit contains (or will contain) a video.
   *
   * A bare `<video>` element is the obvious signal, but feeds lazy-hydrate
   * players: the scaffold container is in the DOM at scan time while the
   * `<video>` is injected only on play. Matching the platform player
   * containers too means "block" and "hide" modes can gate the unit BEFORE the
   * video ever hydrates. The document-level play guard in main.js is the
   * belt-and-suspenders for anything that still slips past scan timing.
   */
  const VIDEO_SELECTORS = [
    "video",
    '[data-testid="videoComponent"]', // X
    '[data-testid="videoPlayer"]', // X
    '[data-testid="previewInterstitial"]', // X video preview
    // `aria-label*="video" i` = aria-label CONTAINS "video", and the trailing
    // ` i` makes the match case-insensitive ("Video", "VIDEO" all count).
    '[aria-label*="video" i]', // Facebook/Instagram (any element, not just div)
    '[aria-label*="reel" i]', // Instagram/Facebook reels
    'div[data-video-id]',
    // A feed video is usually a STILL THUMBNAIL until it is opened — the <video>
    // element doesn't exist yet. But the thumbnail links to the video, so these
    // href patterns let us recognise a video POST up front and gate it before it
    // ever plays (rather than only once the <video> appears).
    'a[href*="/videos/"]', // Facebook
    'a[href*="/watch/"]', // Facebook Watch
    'a[href*="/reel/"]', // Facebook / Instagram reels
    // `.join(",")` turns this array into one comma-separated selector string.
    // In CSS a comma means OR, so the result matches an element that fits ANY
    // of the entries — letting a single querySelector test them all at once.
  ].join(",");

  /**
   * Does this unit contain a video (present or lazily-loaded)?
   *
   * @param {Element} node Unit root.
   * @param {string} kind Refined unit kind.
   * @returns {boolean}
   */
  function detectsVideo(node, kind) {
    if (kind === "reel") return true; // reels are video by definition
    if (typeof node.querySelector !== "function") return false;
    // querySelector returns an element or null. The `!!` (double-NOT) converts
    // that into a clean true/false: null -> false, any element -> true.
    return !!node.querySelector(VIDEO_SELECTORS);
  }

  /** Map a refined kind back to the settings surface toggle that governs it. */
  const KIND_TO_SURFACE = {
    post: "feed",
    comment: "comments",
    ad: "ads",
    message: "messages",
    reel: "reels",
  };

  /**
   * Find every unclassified content unit under a root element.
   *
   * @param {Element} root Subtree to search (document.body, or a mutation target).
   * @param {{platform: string, surfaces: Object<string, boolean>, minLength?: number}} options
   * @returns {Array<{node: Element, kind: string, surface: string, text: string, author: string|null}>}
   */
  function findUnits(root, options) {
    // Look up this platform's rule list; bail out early if we don't recognize
    // the platform or the root can't be queried (e.g. a stub without the API).
    const rules = PLATFORM_RULES[options.platform];
    if (!rules || typeof root.querySelectorAll !== "function") return [];

    const minLength = options.minLength || 8;
    // A Set is a collection of unique values with fast membership tests. Here
    // it remembers which DOM nodes we've already claimed this pass, so two
    // different rules can't emit the same node twice.
    const seen = new Set();
    const units = [];

    for (const rule of rules) {
      // `querySelectorAll` (note the "All") returns EVERY matching descendant,
      // not just the first — so this inner loop visits each candidate element.
      for (const node of root.querySelectorAll(rule.selector)) {
        if (seen.has(node)) continue;
        if (attr(node, PROCESSED_ATTR)) continue; // already handled on a prior scan

        // Site chrome (search field + dropdown, top bar, nav) is never
        // content: filtering it would blur the user's own search query back at
        // them. Checked on the node itself and every ancestor.
        if (inChrome(node)) continue;

        // A fallback rule can defer to a more specific one: skip this node when
        // it contains something the earlier rule already claimed (e.g. a feed
        // wrapper that holds a role="article"), so no unit is processed twice.
        if (
          rule.skipIfContains &&
          typeof node.querySelector === "function" &&
          node.querySelector(rule.skipIfContains)
        ) {
          continue;
        }

        // The mirror of skipIfContains, for last-resort text-block rules:
        // skip this node when it sits INSIDE something a stronger rule owns
        // (an article/comment/row), or inside anything already processed on a
        // previous pass. Without this, a loose text rule would re-claim the
        // paragraphs of posts that were already judged as whole units.
        if (rule.skipIfInside) {
          let ancestor = node.parentElement;
          let nested = false;
          while (ancestor) {
            if (attr(ancestor, PROCESSED_ATTR)) { nested = true; break; }
            if (typeof ancestor.matches === "function" && ancestor.matches(rule.skipIfInside)) {
              nested = true;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (nested) continue;
        }

        const kind = refineKind(node, rule);
        const surface = KIND_TO_SURFACE[kind] || rule.surface;
        // Respect the user's per-surface toggles: if they've turned this
        // surface off, skip the unit entirely.
        if (options.surfaces && options.surfaces[surface] === false) continue;

        const text = readText(node);
        const hasVideo = detectsVideo(node, kind);

        // Too little text to judge — but a caption-less VIDEO must still be
        // surfaced, or block/hide modes could not gate it. For such a unit the
        // scorer returns all-zeros and only the video mode decides its fate.
        if (text.length < minLength && !hasVideo) continue;

        seen.add(node);
        // Build the plain result object for this unit. `{ node, kind, ... }`
        // is shorthand: `node` alone means `node: node`. This object is the
        // hand-off to the scoring/decision layer — note it holds a reference
        // to the live `node`, but we only READ from it here.
        units.push({ node, kind, surface, text, author: extractAuthor(node), hasVideo });
      }
    }

    return units;
  }

  // The factory returns this object; the UMD wrapper publishes it as
  // VALYOU.Extractors. Everything listed is exported both for the rest of the
  // extension and for the unit tests (which exercise the helpers directly).
  /**
   * Grow a unit to the outermost wrapper that still contains ONLY this unit.
   *
   * WHY: hiding/blurring the bare article isn't always enough. Facebook wraps
   * each post in card chrome — the header/"subject line", the "Suggested for
   * you" banner, search-result context — that sits as a SIBLING above the
   * article, so covering only the article leaves that text readable. This
   * climbs from the unit toward the root and keeps going while the parent
   * still holds no OTHER post/comment, so the whole card gets covered — but
   * it can never swallow a neighbouring post:
   *   - stop at feed/list/main landmarks (they hold many posts),
   *   - stop as soon as a parent contains more than one unit-like element,
   *   - stop after 6 levels (defense against pathological nesting).
   *
   * @param {Element} node The matched unit element.
   * @returns {Element} `node` itself or the largest exclusive wrapper.
   */
  /**
   * True when `node` is, or sits inside, site chrome (see CHROME_SELECTORS).
   * Walks the ancestor chain rather than using closest(), so it behaves the
   * same in the test stub.
   *
   * @param {Element} node
   * @returns {boolean}
   */
  function inChrome(node) {
    let el = node;
    while (el) {
      if (typeof el.matches === "function" && el.matches(CHROME_SELECTORS)) return true;
      el = el.parentElement;
    }
    return false;
  }

  /** True when `el` sits inside `ancestor`'s subtree (parentElement walk —
   *  works in the test stub too, which has no Element.contains). */
  function isInside(el, ancestor) {
    let p = el;
    while (p) {
      if (p === ancestor) return true;
      p = p.parentElement;
    }
    return false;
  }

  function expandUnit(node) {
    if (!node) return node;
    let current = node;
    // Facebook nests posts deep inside card chrome, so the climb needs real
    // headroom — the guards below (not the depth cap) are what keep this safe.
    for (let depth = 0; depth < 12; depth += 1) {
      const parent = current.parentElement;
      if (!parent) break;
      const tag = parent.tagName || "";
      if (tag === "BODY" || tag === "HTML" || tag === "MAIN") break;
      const role = attr(parent, "role");
      if (role === "feed" || role === "main" || role === "list") break;
      // Never expand into site chrome (a card sitting next to the nav rail
      // must not drag the nav into the cover).
      if (typeof parent.matches === "function" && parent.matches(CHROME_SELECTORS)) break;
      // Never climb ONTO another unit: when our unit is a comment nested in a
      // post, its parent chain reaches the post's own article — expanding to
      // it would hide the whole post because of one comment. (The enclosing
      // article can't be caught by the querySelectorAll below, because a
      // query lists descendants only — the parent itself never appears.)
      if (role === "article" || role === "row" || tag === "ARTICLE") break;
      // Would this wrapper contain any FOREIGN unit — a post/comment that is
      // neither our own node NOR nested inside it? Facebook posts carry
      // comment-preview articles INSIDE them, so a naive "more than one
      // article under the parent" test always fires and blocked expansion
      // entirely. Nested-in-ours doesn't count; an element that CONTAINS ours
      // does (climbing past it would swallow the enclosing post — e.g. when
      // our unit is itself a comment inside a post).
      let foreign = false;
      if (typeof parent.querySelectorAll === "function") {
        // `[dir="auto"]` belongs in this list because the last-resort rule
        // claims plain text blocks as units — which is how a Facebook SEARCH
        // RESULT is matched. Without it, a flagged result expanded straight
        // past its neighbours and covered the entire results list under one
        // bar, so revealing one post revealed every post with it.
        const candidates = parent.querySelectorAll(
          'div[role="article"], article, div[role="row"], div[dir="auto"]'
        );
        for (const el of candidates) {
          if (el === node) continue; // the unit itself
          if (isInside(el, node)) continue; // our own nested comment previews
          foreign = true; // a sibling unit, or an ancestor unit enclosing ours
          break;
        }
      }
      if (foreign) break;
      current = parent;
    }
    return current;
  }

  return {
    PLATFORM_RULES,
    EXCLUDED_SELECTORS,
    CHROME_SELECTORS,
    inChrome,
    PROCESSED_ATTR,
    KIND_TO_SURFACE,
    VIDEO_SELECTORS,
    platformFor,
    ancestorMatching,
    isSponsored,
    detectsVideo,
    readText,
    extractAuthor,
    refineKind,
    findUnits,
    expandUnit,
  };
});
