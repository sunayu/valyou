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
 * Content-script entry point: the scan loop.
 *
 * BEGINNER ORIENTATION — HOW THIS FILE FITS THE EXTENSION
 *   A Chrome extension (Manifest V3) is split into separate JavaScript worlds
 *   that cannot touch each other's variables and can only talk by passing
 *   messages:
 *     - A CONTENT SCRIPT (this file) is injected INTO a web page — here,
 *       Facebook/Instagram/X. It can read and modify that page's DOM (the
 *       live tree of HTML elements), which is how valyou finds posts and
 *       hides them. It runs in an "isolated world": it shares the page's DOM
 *       but has its own private JavaScript scope, so the page's own scripts
 *       cannot see or tamper with valyou's variables.
 *     - The SERVICE WORKER (src/background/service-worker.js) runs in the
 *       background with no page attached. It owns the settings and stats and
 *       is the only part allowed to touch encrypted storage. This content
 *       script asks it for settings and reports counters over messages.
 *   So the division of labour is: the service worker decides the RULES, and
 *   this content script APPLIES them to whatever is on screen.
 *
 * FLOW PER UNIT
 *   extract text -> score (synchronous, sub-millisecond) -> apply
 *   A "unit" is one piece of content we judge — usually a post/tweet/reel.
 *   "Synchronous" means each step runs to completion immediately, with no
 *   waiting/await in the middle, so the whole verdict lands in one animation
 *   frame.
 *
 * The whole pipeline is local and synchronous, which is what makes valyou
 * feel instant: a verdict is reached and applied in the same frame the unit
 * appears, with no network round trip anywhere. The extension makes no
 * network requests at all — by design, so the product can never depend on
 * an external service.
 */
// The entire file is wrapped in an IIFE — an Immediately Invoked Function
// Expression: `(function () { ... })();` defines a function and calls it at
// once. This gives the code a private scope so none of the names below leak
// onto the page's global `window`, keeping the content script self-contained.
(function () {
  // "use strict" opts into stricter JavaScript rules (e.g. assigning to an
  // undeclared variable throws instead of silently creating a global). It
  // catches common mistakes early.
  "use strict";

  // `self` is the global object inside any script (the worker/content-script
  // equivalent of `window`). All of valyou's shared library modules attach
  // themselves to a single `self.VALYOU` namespace object; here we pull out the
  // pieces this file needs via destructuring (unpacking named properties).
  const { Scorer, Extractors, Apply, ML, ModelData } = self.VALYOU;

  /**
   * Load (or unload) the ML assist to match the current setting.
   *
   * Gating at load time keeps the scoring hot path branch-free: when the
   * assist is off, the model is simply never loaded and the scorer skips it.
   *
   * @param {object} settings Current settings.
   */
  function syncModel(settings) {
    if (!ML) return; // ML module may be absent in stripped builds; nothing to do.
    // `want` is true only when the setting object exists AND ml.enabled is true.
    // The chained `&&` guards against `settings` or `settings.ml` being null,
    // which would otherwise throw when we read `.enabled`.
    const want = settings && settings.ml && settings.ml.enabled;
    // Load the model only when it is wanted and not already loaded; unload
    // (load null) when it is no longer wanted. ML.ready() reports current state.
    if (want && ModelData && !ML.ready()) ML.load(ModelData);
    else if (!want && ML.ready()) ML.load(null);
  }

  /** Debounce window for mutation-driven rescans.
   *  "Debounce" = wait until a burst of events stops before acting. When the
   *  feed inserts 30 nodes in a row, we schedule ONE scan 150ms later instead
   *  of 30 scans, so rapid DOM changes collapse into a single pass. */
  const SCAN_DEBOUNCE_MS = 150;

  /** Cap on units processed per scan, so a huge DOM insert cannot jank a frame.
   *  ("Jank" = a visible stutter caused by doing too much work in one frame.) */
  const MAX_UNITS_PER_SCAN = 60;

  // Single mutable object holding this content script's live state. Using one
  // object (rather than many loose `let`s) keeps related state together and
  // lets helpers read/write it by reference.
  const runtime = {
    // Which site we are on ("facebook", "instagram", …) derived from the URL
    // host, or null if this is a site valyou does not handle.
    platform: Extractors.platformFor(location.hostname),
    settings: null, // filled in by fetchSettings() during start()
    observer: null, // the MutationObserver, once created
    scanTimer: null, // the pending debounced-scan timer id, if any
  };

  /**
   * Ask the service worker for the current settings. Returns null when the
   * worker is unreachable (extension updating or reloading), in which case we
   * simply do nothing this cycle rather than filtering with stale rules.
   *
   * WHY a message and not a direct call: settings live in the service worker's
   * encrypted store, which this content script cannot read directly. Message
   * passing is the only bridge between the two worlds.
   *
   * @returns {Promise<object|null>}
   */
  async function fetchSettings() {
    try {
      // chrome.runtime.sendMessage delivers a message to the extension's own
      // service worker and resolves with whatever that worker sends back. The
      // `{ type: "getSettings" }` shape is a convention: the worker switches on
      // `type` to decide how to respond.
      const response = await chrome.runtime.sendMessage({ type: "getSettings" });
      return response && response.settings ? response.settings : null;
    } catch {
      // sendMessage rejects if no receiver is alive (worker restarting, or the
      // extension was just reloaded). Swallow it and return null.
      return null;
    }
  }

  /**
   * Handle one unit end to end: score its text, decide what to do, and apply
   * that decision to the DOM. This is the core "extract -> score -> apply"
   * pipeline for a single post.
   *
   * @param {{node: Element, kind: string, text: string, author: string|null}} unit
   *        The extracted content unit: `node` is the DOM element to act on,
   *        `text` its text, `author` and `kind` metadata used by the scorer.
   * @returns {void}
   */
  function processUnit(unit) {
    const settings = runtime.settings;
    // scoreText returns per-category `scores` plus `signals` (extra features
    // like caps-ratio) computed purely from the text — no network, no state.
    const local = Scorer.scoreText(unit.text, settings.rules);
    // decide() turns raw scores + settings + context into an action verdict,
    // e.g. { action: "hide"|"blur"|"off", category, reason }.
    const decision = Scorer.decide(local.scores, settings, {
      author: unit.author,
      signals: local.signals,
      hasVideo: unit.hasVideo,
    });

    // applyDecision mutates the DOM node (collapse/blur/tag it). The onReveal
    // callback is wired up so it runs later if the user clicks to un-hide.
    Apply.applyDecision(unit.node, decision, {
      onReveal: () => {
        // Clicking to reveal a gated video is the "select it to play" action —
        // approve its videos and start playback within this user gesture, so
        // it plays in one click instead of leaving a paused player behind.
        if (unit.hasVideo) approveAndPlay(unit.node);
        report("revealed", decision.category);
      },
    });

    if (decision.action !== "off") {
      report("filtered", decision.category, decision.action, unit.kind);
    }
  }

  /**
   * Send a lightweight stats event to the service worker. Fire-and-forget:
   * counters are not worth a failed promise in the console.
   *
   * @param {string} event Event name.
   * @param {string|null} category Category involved, if any.
   * @param {string} [action] Action taken.
   * @param {string} [kind] Unit kind.
   */
  function report(event, category, action, kind) {
    // Fire-and-forget message to the worker's "stats" handler. The trailing
    // `.catch(() => {})` swallows any rejection (e.g. worker asleep) so a
    // failed counter update never surfaces as an unhandled promise error.
    chrome.runtime.sendMessage({ type: "stats", event, category, action, kind }).catch(() => {});
  }

  /**
   * Scan a subtree and process everything found.
   *
   * @param {Element} root Subtree root; defaults to the whole body.
   */
  function scan(root) {
    // Guard clauses: bail out early if we have no settings yet, the user turned
    // valyou off, or we are on an unsupported site. Returning here keeps the
    // rest of the function from having to null-check.
    if (!runtime.settings || !runtime.settings.enabled || !runtime.platform) return;

    // Ask the extractors for every content unit inside `root`. `root` lets us
    // rescan just a newly-inserted subtree; it defaults to the whole page body.
    const units = Extractors.findUnits(root || document.body, {
      platform: runtime.platform,
      surfaces: runtime.settings.surfaces,
      minLength: Scorer.MIN_LENGTH,
    });

    // Process at most MAX_UNITS_PER_SCAN units (slice caps the array) so one
    // giant DOM insertion cannot freeze the frame.
    for (const unit of units.slice(0, MAX_UNITS_PER_SCAN)) {
      // needsWork() returns false for nodes we already judged, so a rescan is
      // cheap — we skip everything already decided and only touch new content.
      if (!Apply.needsWork(unit.node)) continue;
      try {
        processUnit(unit);
      } catch (err) {
        // One malformed unit must never stop the scan for the rest of the feed.
        // Mark it "clean" so we don't retry it forever, log at debug level.
        Apply.mark(unit.node, "clean");
        console.debug("[valyou] unit failed", err);
      }
    }

    // Cover and/or pause every video per the current mode — catches players
    // that mounted or started after the initial pass, in or out of a post.
    sweepVideos();
  }

  /** Marker: the user deliberately started this video, so let it play. */
  const APPROVED_ATTR = "data-valyou-approved";

  /**
   * Approve every video in a unit and start it playing.
   *
   * Called from a reveal click (a real user gesture), so calling play() here
   * is honoured by both the browser and our own play guard — the whole point
   * of "the user selects it to play it". Approval also stops the guard and the
   * stray-video sweep from ever re-pausing it.
   *
   * @param {Element} unitNode The revealed unit.
   */
  function approveAndPlay(unitNode) {
    // Defensive: some nodes (text/comment nodes) have no querySelectorAll.
    if (typeof unitNode.querySelectorAll !== "function") return;
    // querySelectorAll("video") returns every <video> descendant of the unit.
    for (const video of unitNode.querySelectorAll("video")) {
      video.setAttribute(APPROVED_ATTR, "1"); // stamp it so guards leave it alone
      // If we muted it earlier while blocking autoplay, restore the sound now
      // that the user has explicitly chosen to play it.
      if (video.getAttribute("data-valyou-muted")) {
        video.muted = false;
        video.removeAttribute("data-valyou-muted");
      }
      try {
        // video.play() returns a Promise in modern browsers. It can reject
        // (e.g. autoplay policy) — we attach a no-op .catch so a rejection
        // doesn't log as an unhandled error. The `typeof` checks guard against
        // host players that replace these methods.
        const p = typeof video.play === "function" ? video.play() : null;
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* host-managed player will pick up the user's own click */
      }
    }
  }

  /**
   * True if a user gesture is currently (or was very recently) active.
   *
   * This is the signal that separates autoplay (no gesture) from a real
   * click on the play button (gesture) — the thing that makes "block
   * autoplay, but let me click to play" actually work. `navigator
   * .userActivation` is available in every Chrome we target (116+); if it is
   * somehow absent we fail SAFE (treat as not activated → block autoplay),
   * because the product's job is to stop autoplay, not to permit it.
   *
   * @returns {boolean}
   */
  function userActivated() {
    // navigator.userActivation.isActive is a browser flag that is true only
    // while (or just after) the user has interacted — a click, key press, tap.
    // Autoplay fires with NO activation; a real play-button click DOES have it.
    // That distinction is exactly how we tell "the site started this video"
    // from "the user started this video". The `!!` coerces the result to a
    // strict true/false even when navigator.userActivation is undefined.
    return !!(navigator.userActivation && navigator.userActivation.isActive);
  }

  /**
   * Stop a video that is autoplaying, and record why we can un-stop it later.
   *
   * @param {HTMLVideoElement} video The video element.
   */
  function stopAutoplay(video) {
    try {
      if (typeof video.pause === "function") video.pause();
    } catch {
      /* detached / host-managed player */
    }
    // Remember that WE muted it (data-valyou-muted marker) so approveAndPlay
    // can unmute later. We only touch videos that were unmuted, to avoid
    // clobbering a video the user had already muted themselves.
    if (video.muted === false) {
      video.muted = true;
      video.setAttribute("data-valyou-muted", "1");
    }
    // Clear the autoplay flag so the browser won't auto-restart it.
    video.autoplay = false;
  }

  /**
   * The autoplay-control layer for "block" and "hide" video modes.
   *
   * Autoplay in a feed is not one event we can catch once — players retry,
   * hydrate late, and start before our async boot finishes. So this uses two
   * cooperating mechanisms:
   *
   *   1. A document-level *capturing* `play` listener. It sees every play
   *      attempt before the player's own handlers. Autoplay (no user gesture,
   *      not yet approved) is paused and muted immediately; in "hide" mode the
   *      video is also covered (its post if recognized, else its container). A
   *      real click carries a user gesture, so `blocksAutoplay` lets it through
   *      and marks the video approved — that is how click-to-play keeps working.
   *   2. `sweepVideos()`, run after every scan, covers/pauses videos that
   *      mounted or started outside a `play` event we caught — lazy players and
   *      the boot race. It never touches an approved video, so it can't stop
   *      something the user chose to watch.
   *
   * Installed once; every check re-reads the live setting, so toggling the
   * mode takes effect without reinstalling.
   */
  function installVideoPlayGuard() {
    if (runtime.videoGuardInstalled) return; // install exactly once
    runtime.videoGuardInstalled = true;

    document.addEventListener(
      "play",
      (event) => {
        const settings = runtime.settings;
        if (!settings || !settings.enabled) return;
        // Re-read the live setting on every event so toggling the video mode
        // takes effect immediately, without reinstalling the listener.
        const mode = settings.media && settings.media.video;

        // event.target is the element that fired "play". Ignore anything that
        // is not a <video> (audio elements, etc.).
        const video = event.target;
        if (!video || video.tagName !== "VIDEO") return;

        const approved = video.hasAttribute(APPROVED_ATTR);
        // blocksAutoplay decides, from the mode plus whether the play was
        // user-initiated or pre-approved, if THIS play attempt should be
        // stopped. If not, we let it run.
        if (!Scorer.blocksAutoplay(mode, { approved, userActivated: userActivated() })) {
          // Allowed: either mode permits it, or the user clicked. Mark it so
          // future retries and scans leave it alone.
          if (userActivated()) video.setAttribute(APPROVED_ATTR, "1");
          return;
        }

        stopAutoplay(video);

        // Cover it (post if recognized, else the player's container) so it is
        // hidden, not just paused — the fix for videos that stopped autoplaying
        // yet stayed visible because they sit outside any recognized post.
        if (mode === "hide") coverVideoElement(video);
      },
      // The third argument `true` registers this as a CAPTURING listener.
      // DOM events travel down from the document to the target (capture phase)
      // and then bubble back up. Listening in the capture phase means we see
      // the "play" event BEFORE the player's own handlers on the way down, so
      // we can pause an autoplay before the site reacts to it.
      true
    );
  }

  /**
   * Blur a node behind a click-to-play shield.
   *
   * The state check gates a node that is unprocessed OR was previously judged
   * "clean" (the Facebook case: the post is cleared on the first pass and only
   * mounts its <video> later). It never re-gates a node the user revealed, or
   * one already filtered by the classifier.
   *
   * @param {Element|null} node The unit or video container to cover.
   * @returns {boolean} true if it was newly gated.
   */
  function gateNode(node) {
    if (!node) return false;
    // stateOf() reports what valyou has already done to this node. If it is
    // revealed/hidden/blurred/tagged we must NOT re-gate it — only untouched
    // or "clean" nodes are eligible for a click-to-play shield.
    const st = Apply.stateOf(node);
    if (st === "revealed" || st === "hidden" || st === "blurred" || st === "tagged") return false;

    Apply.applyDecision(
      node,
      { action: "blur", category: null, reason: "Video hidden until you choose to play it" },
      {
        onReveal: () => {
          approveAndPlay(node); // revealing is the user selecting the video — play it
          report("revealed", null);
        },
      }
    );
    report("filtered", null, "blur", "reel");
    return true;
  }

  /**
   * A fallback container to cover when a video is not inside a recognized post
   * (Facebook theater view, Reels, and other surfaces we don't parse). Climb a
   * few levels from the video to enclose the player and its controls without
   * reaching the whole page.
   *
   * @param {Element} video The video element.
   * @returns {Element} A sensible container to blur.
   */
  function videoContainer(video) {
    // Walk up at most 3 parent levels, stopping before <body>. This wraps the
    // player and its controls in a cover without accidentally covering the
    // entire page.
    let el = video;
    for (let i = 0; i < 3 && el.parentElement && el.parentElement !== document.body; i += 1) {
      el = el.parentElement;
    }
    return el;
  }

  /**
   * Cover a single video so it is hidden until clicked.
   *
   * Prefers the whole enclosing post when we recognize one (nicer — the caption
   * and thumbnail go too); otherwise covers the video's own container so it is
   * hidden even on surfaces we don't parse. This unit-agnostic fallback is the
   * fix for "autoplay stopped but the video still shows": stopping autoplay
   * never needed a unit, but covering used to — now neither does.
   *
   * @param {Element} video The video element.
   * @returns {boolean} true if newly covered.
   */
  function coverVideoElement(video) {
    if (video.hasAttribute(APPROVED_ATTR)) return false; // user chose it; leave it
    // Prefer the whole enclosing post if we recognize one; otherwise fall back
    // to the video's own container (`||` returns the first truthy value).
    return gateNode(enclosingUnit(video) || videoContainer(video));
  }

  /**
   * Sweep every video on the page under a blocking mode.
   *
   * Runs on each scan (and the boot race). In `hide`, every un-approved video
   * is covered — via its post if recognized, else its own container — and
   * paused. In `block`, videos are only paused (kept visible). Approved videos
   * (the user chose to play them) are never touched.
   */
  function sweepVideos() {
    const settings = runtime.settings;
    if (!settings || !settings.enabled) return;
    const mode = settings.media && settings.media.video;
    // Only act in the two blocking modes; "off"/"allow" leaves videos alone.
    if (mode !== "block" && mode !== "hide") return;

    // Every <video> on the page — the safety net for players that started or
    // mounted without firing a "play" event we caught in the capturing guard.
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(APPROVED_ATTR)) continue; // never touch approved
      if (mode === "hide") coverVideoElement(video);
      if (!video.paused) stopAutoplay(video); // pause anything still playing
    }
  }

  /**
   * Walk up from a media element to the nearest recognized content unit for the
   * current platform, so hide mode can blur the whole post when possible.
   *
   * @param {Element} node Starting element (a video).
   * @returns {Element|null} Enclosing unit, or null.
   */
  function enclosingUnit(node) {
    // The CSS selectors that identify a "post" on the current platform.
    const rules = Extractors.PLATFORM_RULES[runtime.platform] || [];
    let current = node;
    // Climb parent by parent toward <body>. `element.matches(selector)` tests
    // whether an element matches a CSS selector; the first ancestor that
    // matches any platform rule is the enclosing post.
    while (current && current !== document.body) {
      for (const rule of rules) {
        if (typeof current.matches === "function" && current.matches(rule.selector)) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null; // not inside any recognized post
  }

  /** Coalesce bursts of mutations into a single scan.
   *  This is the debounce mechanism: if a timer is already pending we do
   *  nothing, so N mutations in quick succession still result in ONE scan
   *  SCAN_DEBOUNCE_MS after the first. */
  function scheduleScan() {
    if (runtime.scanTimer) return; // a scan is already queued
    // setTimeout runs the callback once, after the delay. We stash the timer id
    // in runtime.scanTimer so the guard above can tell one is pending, and
    // clear it inside the callback right before running the scan.
    runtime.scanTimer = setTimeout(() => {
      runtime.scanTimer = null;
      scan(document.body);
    }, SCAN_DEBOUNCE_MS);
  }

  /**
   * Start watching for new content. Feeds are infinite scrollers, so almost
   * everything arrives after the initial load.
   *
   * A MutationObserver is a browser API that calls you back whenever the DOM
   * changes (nodes added/removed, attributes edited). It is how we notice new
   * posts appearing as the user scrolls, instead of polling the page on a timer.
   */
  function observe() {
    if (runtime.observer) return; // observe once
    // The callback receives a batch of MutationRecords describing what changed.
    runtime.observer = new MutationObserver((mutations) => {
      // Our own DOM writes (covers, badges) also trigger this observer. If we
      // rescanned on those we would react to our own changes forever — an
      // infinite loop. So we only proceed when at least one added node is a
      // real ELEMENT (nodeType === 1) that is NOT one of our own valyou-* nodes.
      const relevant = mutations.some((m) =>
        // addedNodes is a NodeList; Array.from makes it a real array so we can
        // use .some(). A mutation is relevant if any added node qualifies.
        Array.from(m.addedNodes || []).some(
          (n) =>
            n.nodeType === 1 && // 1 === element node (skip text/comment nodes)
            !(n.className && String(n.className).startsWith("valyou-"))
        )
      );
      if (relevant) scheduleScan(); // debounced — not an immediate scan
    });
    // Begin observing: childList = watch for added/removed children,
    // subtree = watch the whole tree under body, not just its direct children.
    runtime.observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Clear every valyou marker and re-run from scratch. Used when settings
   * change, because previous decisions were made under the old thresholds.
   */
  function resetAndRescan() {
    // Strip our processing markers/classes off every node we previously touched
    // so scan() will re-evaluate them under the new settings.
    for (const node of document.querySelectorAll(`[${Apply.PROCESSED_ATTR}]`)) {
      node.removeAttribute(Apply.PROCESSED_ATTR);
      node.removeAttribute(Apply.REASON_ATTR);
      node.classList.remove("valyou-collapsed", "valyou-blurred");
    }
    // Remove the visual chrome we injected (shields, bars, badges). The local
    // name `chrome_` has a trailing underscore only to avoid shadowing the
    // global `chrome` extension API used elsewhere.
    for (const chrome_ of document.querySelectorAll(".valyou-shield, .valyou-bar, .valyou-badge")) {
      if (chrome_.parentElement) chrome_.parentElement.removeChild(chrome_);
    }
    scan(document.body); // fresh pass with the new rules
  }

  /** Boot: load settings, do a first pass, then watch.
   *  Marked `async` so it can `await` the settings message before scanning. */
  async function start() {
    if (!runtime.platform) return; // unsupported site; do nothing at all

    // Fetch settings from the service worker before touching the page.
    runtime.settings = await fetchSettings();
    if (!runtime.settings) return; // worker unreachable — try again next load

    syncModel(runtime.settings);
    installVideoPlayGuard(); // before the first scan, so no play event is missed
    scan(document.body); // initial pass over whatever already loaded
    observe(); // then watch for everything that scrolls in later

    // React to settings edits made in the options page while a feed is open.
    // onMessage registers a listener; the service worker broadcasts a
    // "settingsChanged" message (see broadcastSettings) whenever the user saves.
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "settingsChanged") {
        runtime.settings = message.settings;
        syncModel(runtime.settings);
        resetAndRescan(); // old verdicts used old thresholds; redo them all
      }
    });
  }

  // Expose internals for debugging from the page console; harmless because
  // the isolated world is not reachable from page scripts. (The page's own
  // JavaScript cannot see this content script's `self.VALYOU`.)
  self.VALYOU.__content = { runtime, scan, resetAndRescan, processUnit };

  start(); // kick everything off
})();
