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
 * Mobile injection entry point — the mobile equivalent of content/main.js.
 *
 * On the browser extension, the content script talks to a service worker over
 * chrome.runtime for settings and stats. There is no service worker on mobile:
 * this script runs inside the WebView's page context (injected by
 * react-native-webview), and the native app is the trusted core instead. So
 * the two chrome.* dependencies are replaced by a tiny bridge:
 *
 *   - SETTINGS arrive from the native side as `window.__VALYOU__.settings`
 *     (set before this runs, and refreshed by re-injecting a small assignment
 *     when the user edits them). No decryption here — the native app owns the
 *     encrypted store; the page only receives the resolved settings object.
 *   - STATS / events go out via `window.ReactNativeWebView.postMessage(...)`,
 *     which the native side receives and persists.
 *
 * Everything else — Extractors, Scorer, Apply, the ML assist, the video
 * blocking — is the SAME engine as the extension, unchanged, because it was
 * written as pure page-context JavaScript from the start. That is the whole
 * point of this port: one classifier, two shells.
 *
 * ----- ORIENTATION FOR A NEWCOMER -----
 * A "WebView" is a full web browser embedded inside the native app. When the
 * user opens (say) Facebook, the native app tells the WebView to load that URL
 * and then INJECTS this script into the page. From that moment this code lives
 * *inside* the social-media page, with the same powers a page's own scripts
 * have: it can read the DOM (the tree of on-screen elements), watch for new
 * posts as you scroll, and hide/blur anything it decides is harmful.
 *
 * Because this runs inside an untrusted page, it must never handle secrets. It
 * only gets already-resolved settings pushed in from the trusted native side,
 * and it only sends plain counters back out. See the trust-model note in
 * App.tsx.
 *
 * This whole file is wrapped in an IIFE — an "Immediately Invoked Function
 * Expression": `(function () { ... })();`. Defining a function and calling it
 * on the spot creates a private scope, so none of the variables below (`root`,
 * `Scorer`, etc.) leak into the page's global namespace where they could clash
 * with the site's own code.
 */
(function () {
  "use strict"; // opt into strict mode: turns silent JS mistakes into errors

  // `window` is the page's global object. `window.__VALYOU__` is our private
  // stash on it: the native side sets it up before this runs, so we reuse it if
  // present, or create an empty object and assign it if not. `root` is a short
  // local alias for that stash.
  var root = window.__VALYOU__ || (window.__VALYOU__ = {});
  var VALYOU = window.VALYOU; // the engine namespace (Extractors/Scorer/Apply/…)
  if (!VALYOU || !VALYOU.Extractors) return; // engine not loaded — nothing to do
  if (root.started) return; // idempotent: injection may fire more than once
  root.started = true;

  // Pull the engine's sub-modules into short local names. These are the SAME
  // objects the browser extension uses — shared, unchanged classifier code.
  var Scorer = VALYOU.Scorer; // decides an action (hide/blur/tag/off) from text
  var Extractors = VALYOU.Extractors; // finds the "units" (posts/comments) in the DOM
  var Apply = VALYOU.Apply; // performs the hide/blur/reveal on a DOM node
  // This shell only ever runs on a phone or tablet, where a tap is the most
  // accidental gesture there is: filtered content is revealed by a deliberate
  // right swipe, never a tap. Pinned here so the choice does not depend on
  // what the WebView reports for its pointer.
  if (Apply && typeof Apply.setRevealMode === "function") Apply.setRevealMode("swipe");
  var ML = VALYOU.ML; // optional on-device machine-learning classifier

  var SCAN_DEBOUNCE_MS = 150; // wait this long after DOM changes before re-scanning
  var MAX_UNITS_PER_SCAN = 60; // cap work per pass so scrolling stays smooth
  var APPROVED_ATTR = "data-valyou-approved"; // marks a video the user chose to play

  // Mutable engine state for this page. `platform` picks the right DOM selectors
  // for whichever site we're on; `observer`/`scanTimer` are filled in later.
  var state = {
    platform: Extractors.platformFor(location.hostname),
    observer: null,
    scanTimer: null,
  };

  /**
   * Current settings, as handed over by the native app. Returns the resolved
   * settings object, or null if the native side has not pushed them in yet.
   * A helper (rather than reading root.settings directly) keeps that "or null"
   * fallback in one place.
   */
  function settings() {
    return root.settings || null;
  }

  /**
   * Send an event to the native side — this is our half of the "bridge".
   * react-native-webview exposes window.ReactNativeWebView.postMessage; calling
   * it with a string is the ONLY channel from page → native. We also accept a
   * generic hook (root.bridge) so the same bundle can run under a Capacitor
   * plugin or a test harness.
   *
   * @param {object} message Event payload (must be plain JSON-serialisable data).
   */
  function toNative(message) {
    try {
      // postMessage only accepts a string, so serialise the object to JSON.
      // The native onMessage handler will JSON.parse it back into an object.
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      } else if (typeof root.bridge === "function") {
        root.bridge(message);
      }
    } catch (e) {
      /* a filtering engine must never throw into the host page */
    }
  }

  /**
   * Emit a stats event (fire-and-forget), mirroring the extension's `report`.
   *
   * @param {string} event Event name.
   * @param {string|null} category Category, if any.
   * @param {string} [action] Action taken.
   * @param {string} [kind] Unit kind.
   */
  function report(event, category, action, kind) {
    toNative({ type: "stats", event: event, category: category, action: action, kind: kind });
  }

  /**
   * Load or unload the bundled ML model to match the current setting. Loading
   * the model costs memory, so we only do it when ml.enabled is true and it is
   * not already loaded; when the user turns ML off we free it by loading null.
   */
  function syncModel() {
    if (!ML) return;
    var s = settings();
    var want = s && s.ml && s.ml.enabled;
    if (want && window.VALYOU.ModelData && !ML.ready()) ML.load(window.VALYOU.ModelData);
    else if (!want && ML.ready()) ML.load(null);
  }

  /* ----- video blocking (same behaviour as the extension) ----- */

  /**
   * True when the browser thinks the user recently interacted (tapped/clicked).
   * Browsers track "user activation" to distinguish a video the user started
   * from one that autoplayed on its own — we only block the latter. `!!` coerces
   * the value to a strict true/false boolean.
   */
  function userActivated() {
    return !!(navigator.userActivation && navigator.userActivation.isActive);
  }

  /**
   * Which <video> was this tap FOR? Climb up from the tap target to the
   * smallest ancestor whose subtree contains EXACTLY ONE video (searching
   * through shadow roots) — that's the tapped player, even when the tap landed
   * on an overlay that is a SIBLING of the video's own chain (Instagram and
   * Facebook player chrome work this way, which is why comparing the tap chain
   * against the video's ancestors missed real taps and froze playback).
   * An ancestor containing 2+ videos means the tap wasn't on a specific player
   * (e.g. somewhere in the feed shell) — give up rather than guess.
   */
  function resolveTappedVideo(target) {
    var p = target;
    for (var i = 0; i < 15 && p && p !== document.body; i += 1) {
      if (p.tagName === "VIDEO") return p;
      if (typeof p.querySelectorAll === "function") {
        var vids = collectVideosIn(p);
        if (vids.length === 1) return vids[0];
        if (vids.length > 1) return null; // ambiguous — not a player tap
      }
      p = climbUp(p);
    }
    return null;
  }

  /**
   * Record every real tap and act on it IMMEDIATELY. The browser's transient-
   * activation flag is consumed/expired before Facebook's player calls play()
   * asynchronously, and a plain "recent tap" time window is far too loose (any
   * tap would bless every autoplay near it — paused feed players retry play()
   * constantly, so ANY loose window gets consumed by retries). Instead we
   * resolve the tapped VIDEO at click time and approve exactly that one, before
   * the site's own handler even runs — no race, no guessing later.
   * (We listen for "click", not touch events, because scrolling fires touch
   * events too — click only fires on an actual tap. composedPath()[0] gives the
   * true innermost target even inside shadow DOM, where event.target is
   * retargeted to the shadow host.)
   */
  function installTapTracker() {
    if (root.tapTracker) return;
    root.tapTracker = true;
    try {
      document.addEventListener(
        "click",
        function (event) {
          root.lastTapAt = Date.now();
          var path = typeof event.composedPath === "function" ? event.composedPath() : null;
          var target = (path && path.length ? path[0] : event.target) || null;
          if (!target) return;
          var v = resolveTappedVideo(target);
          if (v) {
            // The user tapped this player. Approving it is NOT enough: sites
            // often act on pointerup/touchend, which fire BEFORE this click —
            // so their play attempt was already rejected by our patches, and
            // they won't try again. WE must start the video (reviveVideo also
            // approves it, restores autoplay, and un-mutes what we muted).
            // Only start it when this is a fresh intent — first approval, or a
            // player still stuck at the very beginning. A tap on an already-
            // RUNNING approved video is the user pausing it: leave that alone.
            root.lastTapVideo = v;
            var firstIntent = !v.hasAttribute(APPROVED_ATTR);
            if (firstIntent || (v.paused && v.currentTime === 0)) {
              reviveVideo(v);
              // The site may reset the element right after this gesture —
              // check back shortly and give it one more nudge if it never left
              // the starting line.
              if (typeof setTimeout === "function") {
                setTimeout(function () {
                  if (v.paused && v.currentTime === 0) {
                    try {
                      var pr = v.play();
                      if (pr && typeof pr.catch === "function") pr.catch(function () {});
                    } catch (e) { /* one nudge only */ }
                  }
                }, 350);
              }
            }
            // Open the grace window either way (the theater/watch page may
            // re-mount the same content as a NEW element — grace +
            // sessionStorage covers that).
            markRevealGrace();
            return;
          }
          // No mounted video here — maybe a video LINK or thumbnail (Facebook
          // gates these at the still stage). A tap on one is still "I chose to
          // watch": open the grace window so the destination page/theater plays.
          var p = target;
          for (var i = 0; i < 40 && p && p !== document.body; i += 1) {
            if (
              (p.getAttribute && p.getAttribute("data-video-id") != null) ||
              (p.tagName === "A" && /\/(watch|videos|reel)/.test(p.getAttribute("href") || ""))
            ) {
              markRevealGrace();
              break;
            }
            p = climbUp(p);
          }
        },
        true
      );
    } catch (e) { /* worst case: fall back to userActivation only */ }
  }

  /** True when the user's LAST tap (within a short window) was on this video. */
  function tapWasOnVideo(video) {
    if (!root.lastTapAt || Date.now() - root.lastTapAt > 8000) return false;
    return root.lastTapVideo === video;
  }

  /**
   * Stop a video that is autoplaying: pause it, mute it (marking that WE muted
   * it, so we can un-mute later if the user chooses to play), and clear its
   * autoplay flag so it stays stopped.
   */
  function stopAutoplay(video) {
    try {
      if (typeof video.pause === "function") video.pause();
    } catch (e) {
      /* host-managed player */
    }
    if (video.muted === false) {
      video.muted = true;
      video.setAttribute("data-valyou-muted", "1");
    }
    video.autoplay = false;
  }

  /**
   * The user tapped to reveal a gated post/video: un-gate every <video> inside
   * `node`, un-mute the ones we muted, and try to start playback. Marks each
   * with APPROVED_ATTR so the guards below leave it alone from now on.
   */
  /**
   * True during a short window after the user reveals a gated video post. In
   * that window we stop gating videos, so the one they asked to watch actually
   * plays — even on Facebook, which opens the tapped video in a separate theater
   * view (a new <video> outside the revealed post that would otherwise be
   * re-gated). Without this, "Show anyway" reveals the post but the video never
   * plays.
   */
  function inRevealGrace() {
    var t = root.revealGraceAt || 0;
    // Also honour a grace stamp in sessionStorage, which survives a Facebook
    // page navigation (tapping a video can load a new video page — a fresh
    // window where root would be reset, losing the grace).
    try {
      var st = parseInt(sessionStorage.getItem("__valyou_grace") || "0", 10);
      if (st > t) t = st;
    } catch (e) {}
    return !!(t && Date.now() - t < 15000);
  }

  /** Open (or extend) the reveal grace window, persisting it across navigation. */
  function markRevealGrace() {
    root.revealGraceAt = Date.now();
    try { sessionStorage.setItem("__valyou_grace", String(root.revealGraceAt)); } catch (e) {}
  }

  /** Collect <video> elements inside `node`, piercing open shadow roots. */
  function collectVideosIn(node) {
    var out = [];
    function scan(r) {
      if (!r || typeof r.querySelectorAll !== "function") return;
      var vids = r.querySelectorAll("video");
      for (var i = 0; i < vids.length; i += 1) out.push(vids[i]);
      // Facebook/Instagram mount the real player's <video> inside a shadow root,
      // which querySelectorAll can't reach directly — descend into every host.
      var all = r.querySelectorAll("*");
      for (var j = 0; j < all.length; j += 1) {
        if (all[j].shadowRoot) scan(all[j].shadowRoot);
      }
    }
    try { scan(node); } catch (e) { /* return whatever we collected */ }
    return out;
  }

  /** Revive one <video> we previously paused/muted: approve, unmute, play. */
  function reviveVideo(v) {
    v.setAttribute(APPROVED_ATTR, "1");
    // We killed autoplay when we stopped it — allow it to keep itself playing.
    try { v.autoplay = true; } catch (e) {}
    if (v.getAttribute("data-valyou-muted")) {
      v.muted = false;
      v.removeAttribute("data-valyou-muted");
    }
    try {
      var p = typeof v.play === "function" ? v.play() : null;
      // If the browser rejects an un-muted play outside a gesture, fall back to a
      // muted play (always permitted) so the video at least starts — the user can
      // tap unmute. Better a silent video than a frozen one.
      if (p && typeof p.catch === "function") {
        p.catch(function () {
          try { v.muted = true; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}); } catch (e) {}
        });
      }
    } catch (e) {
      /* the user's own tap will start it */
    }
  }

  function approveAndPlay(node) {
    // The user chose to watch: open the grace window so their video can play
    // wherever the site opens it.
    markRevealGrace();
    if (typeof node.querySelectorAll !== "function") return;

    // 1) Revive any <video> that already exists inside the post — INCLUDING ones
    //    inside shadow DOM. Feed video posts autoplay a muted <video> that we
    //    already paused; it lives in a shadow root the plain querySelector misses,
    //    which is why "Show anyway" left it frozen. Pierce shadow and play it.
    var vids = collectVideosIn(node);
    for (var i = 0; i < vids.length; i += 1) reviveVideo(vids[i]);

    // 2) Also click the site's own thumbnail/play trigger inside this gesture, so
    //    Facebook mounts/starts its player (needed when no <video> exists yet, and
    //    harmless when one already does — Reels navigate to their page from here).
    try {
      var trigger =
        node.querySelector('[aria-label*="play" i]') ||
        node.querySelector("[data-video-id]") ||
        node.querySelector('[aria-label*="video" i],[aria-label*="reel" i]') ||
        node.querySelector('a[href*="/videos/"],a[href*="/watch/"],a[href*="/reel/"]');
      // Only click if nothing is already playing — avoid pausing a video we just
      // revived (Facebook's play toggle would stop it).
      if (!vids.length && trigger && typeof trigger.click === "function") trigger.click();
    } catch (e) {
      /* the user can tap the thumbnail themselves — grace is already open */
    }

    // 3) The player often mounts its <video> a moment AFTER the tap. Poll for a
    //    short while (still inside the grace window) and revive whatever appears.
    if (typeof setTimeout === "function") {
      [150, 400, 800, 1500].forEach(function (delay) {
        setTimeout(function () {
          if (!inRevealGrace()) return;
          var later = collectVideosIn(node);
          for (var k = 0; k < later.length; k += 1) {
            if (!later[k].hasAttribute(APPROVED_ATTR)) reviveVideo(later[k]);
          }
        }, delay);
      });
    }
  }

  /**
   * Walk UP the DOM tree from `node` looking for the post/comment "unit" that
   * contains it, using the current platform's CSS selectors. Returns that
   * ancestor element, or null if none matches before reaching <body>. We gate
   * the whole unit, not just the raw <video>, so the surrounding post is hidden.
   */
  function enclosingUnit(node) {
    var rules = Extractors.PLATFORM_RULES[state.platform] || [];
    var current = node;
    while (current && current !== document.body) {
      // element.matches(selector) tests whether an element matches a CSS rule.
      for (var i = 0; i < rules.length; i += 1) {
        if (typeof current.matches === "function" && current.matches(rules[i].selector)) return current;
      }
      current = current.parentElement; // step one level up and try again
    }
    return null;
  }

  /**
   * Fallback when no known unit encloses the video: climb up to 3 parents to
   * find a reasonably-sized wrapper element to gate instead.
   */
  function videoContainer(video) {
    var el = video;
    for (var i = 0; i < 3 && el.parentElement && el.parentElement !== document.body; i += 1) el = el.parentElement;
    return el;
  }

  /**
   * Cover a node with a "swipe to play" shield unless it is already handled.
   * Returns true if it newly gated the node, false if there was nothing to do.
   */
  function gateNode(node) {
    if (!node) return false;
    // Skip if we already acted on this node (any of these states).
    var st = Apply.stateOf(node);
    if (st === "revealed" || st === "hidden" || st === "blurred" || st === "tagged") return false;
    // Apply a "blur" decision. The onReveal callback runs when the user taps the
    // shield: play the video and report the reveal as a counter event.
    Apply.applyDecision(
      node,
      { action: "blur", category: null, reason: "Video hidden until you swipe to play it" },
      {
        onReveal: function () {
          approveAndPlay(node);
          report("revealed", null);
        },
      }
    );
    report("filtered", null, "blur", "reel"); // count this as one filtered unit
    return true;
  }

  /**
   * Gate the unit around a single <video> element, unless the user already
   * approved that video. Prefers the enclosing post; falls back to a wrapper.
   */
  /**
   * Find the best element to cover for a given video: an ancestor that actually
   * contains the video's visible box. On mobile the post selectors often don't
   * match, so the old "climb exactly 3 levels" fallback could land on a tiny
   * wrapper that doesn't visually cover the video (so it kept playing). Instead,
   * climb until we reach an ancestor clearly larger than the video (a real card),
   * capped at 6 levels.
   */
  function bestVideoContainer(video) {
    try {
      var vr = video.getBoundingClientRect();
      var cur = video.parentElement;
      var best = cur || video;
      for (var i = 0; i < 6 && cur && cur !== document.body; i += 1) {
        best = cur;
        var r = cur.getBoundingClientRect();
        // Stop at the first ancestor that's meaningfully taller than the video
        // and at least as wide — a genuine container, not a thin wrapper.
        if (r.height >= vr.height * 1.12 && r.width >= vr.width * 0.9) break;
        cur = cur.parentElement;
      }
      return best;
    } catch (e) {
      return videoContainer(video); // getBoundingClientRect can throw in edge cases
    }
  }

  function coverVideoElement(video) {
    if (video.hasAttribute(APPROVED_ATTR)) return false;
    // Expand so the cover includes the post's header/subject line (siblings
    // of the player), not just the video box itself.
    var base = enclosingUnit(video) || bestVideoContainer(video);
    return gateNode(Extractors.expandUnit(base));
  }

  /**
   * Sweep every <video> currently in the page and enforce the video policy:
   * in "hide" mode cover each one, and in either "hide" or "block" mode stop any
   * that are actively autoplaying. Does nothing if filtering is off.
   */
  /**
   * True when the video sits inside a unit the user already revealed. Once a
   * video POST is un-gated (tap to play), any <video> that then loads inside it
   * must NOT be re-paused or re-covered — otherwise revealing a video and tapping
   * it would immediately gate it again. We climb looking for our "revealed" mark.
   */
  /** Step one level up, crossing shadow-DOM boundaries (via the shadow host). */
  function climbUp(node) {
    if (node.parentElement) return node.parentElement;
    var r = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    return r && r.host ? r.host : null;
  }

  function inRevealedUnit(node) {
    var p = node;
    while (p && p !== document.body) {
      if (p.getAttribute && p.getAttribute(Apply.PROCESSED_ATTR) === "revealed") return true;
      p = climbUp(p);
    }
    return false;
  }

  function sweepVideos() {
    var s = settings();
    if (!s || !s.enabled) return;
    var mode = s.media && s.media.video;
    if (mode !== "block" && mode !== "hide") return;
    var vids = collectVideos();
    var grace = inRevealGrace();
    for (var i = 0; i < vids.length; i += 1) {
      var v = vids[i];
      // ALWAYS attach a per-element guard — even during the grace window and even
      // for shadow-DOM videos — so their play events can keep the grace alive and
      // approve the video (Facebook's theater re-creates its <video> in shadow DOM
      // where document-level "play" events never reach us).
      attachVideoGuard(v);
      if (v.hasAttribute(APPROVED_ATTR)) continue;
      // Playing WITH SOUND can only follow a user action (sites always autoplay
      // muted, and we mute whatever we pause) — approve it.
      if (!v.paused && !v.muted) { v.setAttribute(APPROVED_ATTR, "1"); continue; }
      if (grace) continue; // user just chose to watch — don't gate for now
      // The user revealed the post this video is in — leave it alone.
      if (inRevealedUnit(v)) { v.setAttribute(APPROVED_ATTR, "1"); continue; }
      // The user tapped THIS video's player moments ago: that is a request to
      // watch it. Approve it — and if a guard already paused the play that tap
      // started, restart it so the tap still ends in playback. Shadow players
      // never deliver "play" to the document guard, so this sweep is also the
      // recovery path for them.
      if (tapWasOnVideo(v)) { reviveVideo(v); continue; }
      if (mode === "hide") coverVideoElement(v);
      // Pause aggressively (feed players resume themselves).
      stopAutoplay(v);
    }
  }

  /** Collect <video> elements from the document AND all open shadow roots. */
  function collectVideos() {
    var out = [];
    function scan(root) {
      if (!root || typeof root.querySelectorAll !== "function") return;
      var vids = root.querySelectorAll("video");
      for (var i = 0; i < vids.length; i += 1) out.push(vids[i]);
      // Descend into any element that hosts an open shadow root — that is where
      // Facebook/Instagram video players often live and querySelectorAll can't
      // reach directly.
      var all = root.querySelectorAll("*");
      for (var j = 0; j < all.length; j += 1) {
        if (all[j].shadowRoot) scan(all[j].shadowRoot);
      }
    }
    try { scan(document); } catch (e) { /* return whatever we collected */ }
    // Roots we captured at creation time, including any that were requested
    // closed — element.shadowRoot cannot find these, so the walk above misses
    // them entirely.
    try {
      var known = root.shadowRoots || [];
      for (var k = 0; k < known.length; k += 1) scan(known[k]);
    } catch (e) {}
    return out;
  }

  /** Attach a one-time per-video guard that re-pauses un-approved playback. */
  /**
   * ONE shared decision for every play attempt, used by both the per-element
   * guard and the document-level guard so they can never disagree.
   *
   * The critical rule learned the hard way: grace must NEVER be extended (nor
   * videos approved) by MUTED plays during the window. Paused feed players
   * retry play() constantly, and treating those retries as "playback continues"
   * kept the grace window open forever — every feed video ended up autoplaying.
   * An UNMUTED play, by contrast, can only follow a user action (no site
   * autoplays with sound), so it approves its video and refreshes grace.
   */
  /**
   * The single allow/deny decision for a play attempt. Returns true when the
   * play is (or should be treated as) user-initiated; may permanently approve
   * the video as a side effect. Used by the play() patch, both event guards,
   * and the sweep — one brain, no disagreement.
   */
  function shouldAllowPlay(video) {
    var s = settings();
    if (!s || !s.enabled) return true;
    var mode = s.media && s.media.video;
    if (mode !== "block" && mode !== "hide") return true;
    if (video.hasAttribute(APPROVED_ATTR)) return true;

    // A video that is NOT IN THE PAGE cannot be one the user asked to watch —
    // you cannot tap what is not on screen. This is checked before every softer
    // rule below, because a detached element slips past all of them.
    //
    // The device proved this one: Facebook's SEARCH RESULTS create a <video> in
    // JavaScript and play it while it is still detached from the document. It
    // is invisible to every collector, so the sweep can never clean up after
    // it, and it defaults to muted === false, so the "sound means the user did
    // it" rule waved it straight through. The guard was not blind to those
    // videos; it was approving them.
    if (video.isConnected === false && !tapWasOnVideo(video)) return false;

    // Sound on, AND the user tapped THIS player. Both halves are required.
    // A generic "has the user interacted recently" test is far too loose: any
    // scroll or tap anywhere on the page satisfies it, which is most of the
    // time on a feed.
    if (!video.muted && tapWasOnVideo(video)) {
      video.setAttribute(APPROVED_ATTR, "1");
      markRevealGrace();
      return true;
    }
    if (tapWasOnVideo(video) || inRevealedUnit(video)) {
      video.setAttribute(APPROVED_ATTR, "1");
      return true;
    }
    if (inRevealGrace()) {
      // Let it play while the window lasts — but the window is NEVER extended
      // by a muted play: paused feed players retry play() constantly, and
      // extending on retries kept the window open forever (the autoplay leak).
      // If this page JUST loaded, this play IS the video the user navigated to
      // (the tap on a reel/watch link opened the grace before navigating) —
      // approve it outright so it isn't paused mid-watch when the window ends.
      if (justStarted()) video.setAttribute(APPROVED_ATTR, "1");
      return true;
    }
    return false;
  }

  function handlePlayAttempt(video) {
    if (shouldAllowPlay(video)) return;
    var s = settings();
    var mode = s && s.media && s.media.video;
    if (mode === "block" || mode === "hide") {
      stopAutoplay(video);
      if (mode === "hide") coverVideoElement(video);
    }
  }

  /**
   * THE autoplay stopper: patch HTMLMediaElement.prototype.play so every
   * programmatic play attempt is vetted BEFORE any frame renders. Unlike a
   * browser extension's isolated content script, our code runs in the page's
   * own JS context — so this patch governs the site's calls too, including
   * players buried in shadow DOM (whose events never reach the document
   * guard, and which the periodic sweep could only pause AFTER they had
   * visibly started — the "still autoplaying" leak). A blocked call gets the
   * same NotAllowedError the browser itself produces under autoplay policy /
   * Low Power Mode, a rejection Facebook's player already handles gracefully
   * (it shows its play button and stops hammering).
   */
  function installPlayPatch() {
    if (root.playPatched) return;
    root.playPatched = true;
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (!proto || typeof proto.play !== "function") return;
      var origPlay = proto.play;
      proto.play = function () {
        try {
          if (this.tagName === "VIDEO" && !shouldAllowPlay(this)) {
            var err;
            try {
              err = new DOMException("play() blocked by valyou", "NotAllowedError");
            } catch (e2) {
              err = new Error("NotAllowedError: play() blocked by valyou");
            }
            return Promise.reject(err);
          }
        } catch (e) {
          /* on ANY internal error, fall through — never break the site */
        }
        return origPlay.apply(this, arguments);
      };
    } catch (e) {
      /* prototype locked down — the event guards still cover us */
    }
  }

  /**
   * Autoplay WITHOUT play(): a parser-created `<video autoplay muted>` starts
   * natively — there is no JS call for the play() patch to intercept. This is
   * exactly how Facebook's FEED post player works (their Reels player calls
   * play(), which is why reels behaved and feed posts didn't). Close every
   * path the autoplay flag can take into the page:
   *   1. the `autoplay` PROPERTY setter,
   *   2. setAttribute("autoplay", ...),
   *   3. markup parsed straight in (innerHTML/append) — caught by per-root
   *      MutationObservers that strip the flag and pause the element the
   *      instant it appears (see watchRootForVideos),
   *   4. shadow roots — attachShadow is hooked so every NEW root gets its own
   *      observer, because a document-level observer cannot see into shadow.
   */
  /**
   * May this video carry the native autoplay flag / be running unattended?
   * Like shouldAllowPlay but for flag-setting rather than play attempts: no
   * approval side effects, and NO "unmuted = user" shortcut (an unmuted video
   * ELEMENT existing is not evidence of a user action the way an unmuted PLAY
   * is — sites can create elements unmuted and mute them later).
   */
  function allowsAutoplayFlag(video) {
    var s = settings();
    if (!s || !s.enabled) return true;
    var mode = s.media && s.media.video;
    if (mode !== "block" && mode !== "hide") return true;
    if (video.hasAttribute(APPROVED_ATTR)) return true;
    if (tapWasOnVideo(video) || inRevealedUnit(video)) return true;
    return inRevealGrace();
  }

  function installAutoplayPatch() {
    if (root.autoplayPatched) return;
    root.autoplayPatched = true;
    // (1) the property setter
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, "autoplay");
      if (desc && desc.set && desc.configurable) {
        Object.defineProperty(proto, "autoplay", {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () { return desc.get.call(this); },
          set: function (v) {
            try {
              if (v && this.tagName === "VIDEO" && !allowsAutoplayFlag(this)) return;
            } catch (e) { /* never break the site */ }
            desc.set.call(this, v);
          },
        });
      }
    } catch (e) { /* observers below still cover us */ }
    // (2) setAttribute — name is checked first so the hot path stays cheap
    try {
      var eproto = window.Element && window.Element.prototype;
      if (eproto && typeof eproto.setAttribute === "function") {
        var origSetAttr = eproto.setAttribute;
        eproto.setAttribute = function (name, value) {
          try {
            if (
              typeof name === "string" &&
              name.length === 8 &&
              name.toLowerCase() === "autoplay" &&
              this.tagName === "VIDEO" &&
              !allowsAutoplayFlag(this)
            ) {
              return;
            }
          } catch (e) { /* never break the site */ }
          return origSetAttr.apply(this, arguments);
        };
      }
    } catch (e) { /* observers below still cover us */ }
    // (4) hook attachShadow so new shadow roots get a video observer
    try {
      var ep = window.Element && window.Element.prototype;
      if (ep && typeof ep.attachShadow === "function") {
        var origAttach = ep.attachShadow;
        ep.attachShadow = function (init) {
          // FORCE THE ROOT OPEN. A closed root makes element.shadowRoot return
          // null, so querySelectorAll can never reach inside it — and the
          // device reported ZERO <video> elements while a video was plainly
          // playing, because Facebook's player lives in exactly such a root.
          // Rewriting the mode is invisible to the site (it still gets a
          // working shadow root back) and is the only way a filter can see the
          // content it exists to filter.
          var opts = init;
          try {
            if (opts && opts.mode === "closed") {
              opts = { mode: "open" };
              // Preserve any other options the caller passed.
              for (var k in init) if (k !== "mode") opts[k] = init[k];
            }
          } catch (e) { opts = init; }
          var sr = origAttach.call(this, opts);
          try {
            // Belt and braces: remember every root, so even a root we somehow
            // could not force open is still reachable for the sweep.
            (root.shadowRoots || (root.shadowRoots = [])).push(sr);
            watchRootForVideos(sr);
          } catch (e) { /* sweep still covers it */ }
          return sr;
        };
      }
    } catch (e) { /* sweep still covers shadow videos */ }
  }

  /**
   * Neutralise one just-added <video>: attach the play guard, and if it isn't
   * user-approved, strip its autoplay flag and stop it BEFORE it gets going.
   */
  function guardNewVideo(v) {
    attachVideoGuard(v);
    if (allowsAutoplayFlag(v)) return;
    // Only touch it if it is actually primed to run on its own — stripping the
    // flag and pausing an inert element would be needless interference.
    if (v.autoplay || v.hasAttribute("autoplay") || !v.paused) {
      try { v.removeAttribute("autoplay"); } catch (e) { /* host player */ }
      stopAutoplay(v);
    }
  }

  /**
   * Watch one DOM root (document or a shadow root) and neutralise any <video>
   * the moment it is inserted — the periodic sweep alone leaves up to 500ms of
   * visible playback for parser-inserted autoplay videos.
   */
  function watchRootForVideos(rootNode) {
    if (!rootNode || rootNode.__valyouVideoWatch) return;
    rootNode.__valyouVideoWatch = true;
    if (typeof MutationObserver !== "function") return;
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i += 1) {
          var added = muts[i].addedNodes || [];
          for (var j = 0; j < added.length; j += 1) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue; // elements only
            if (n.tagName === "VIDEO") { guardNewVideo(n); continue; }
            if (typeof n.querySelectorAll === "function") {
              var vs = n.querySelectorAll("video");
              for (var k = 0; k < vs.length; k += 1) guardNewVideo(vs[k]);
            }
          }
        }
      });
      mo.observe(rootNode, { childList: true, subtree: true });
    } catch (e) { /* the sweep remains as the safety net */ }
  }

  /** Attach video watchers to a root AND (recursively) every open shadow root
   *  already inside it — needed on SPA re-entry, where roots pre-date our
   *  attachShadow hook. */
  function watchAllRoots(rootNode) {
    watchRootForVideos(rootNode);
    if (!rootNode || typeof rootNode.querySelectorAll !== "function") return;
    try {
      var all = rootNode.querySelectorAll("*");
      for (var j = 0; j < all.length; j += 1) {
        if (all[j].shadowRoot) watchAllRoots(all[j].shadowRoot);
      }
    } catch (e) { /* best effort */ }
  }

  /** True for a few seconds after the engine boots on a fresh page load. */
  function justStarted() {
    return !!(state.startedAt && Date.now() - state.startedAt < 6000);
  }

  function attachVideoGuard(video) {
    if (video.__valyouGuarded) return;
    video.__valyouGuarded = true;
    var onPlay = function () { handlePlayAttempt(video); };
    try {
      video.addEventListener("play", onPlay);
      video.addEventListener("playing", onPlay);
    } catch (e) {
      /* some host players block listener attachment */
    }
  }

  /**
   * Install a single global listener that catches videos the instant they start
   * playing — even ones added after our scan. This closes the gap where a site
   * autoplays a video before sweepVideos runs. Guarded so it installs only once.
   */
  function installVideoPlayGuard() {
    if (root.videoGuard) return;
    root.videoGuard = true;
    // addEventListener with the 3rd arg `true` listens in the CAPTURE phase, so
    // we see the "play" event on its way DOWN to the target — earlier than the
    // page's own bubbling-phase handlers, giving us first chance to intervene.
    document.addEventListener(
      "play",
      function (event) {
        var s = settings();
        if (!s || !s.enabled) return;
        var video = event.target;
        if (!video || video.tagName !== "VIDEO") return;
        handlePlayAttempt(video); // same decision as the per-element guard
      },
      true
    );
  }

  /* ----- the scan loop ----- */

  /**
   * Classify one content unit (a post/comment/ad, already extracted) and apply
   * the resulting decision to its DOM node. Scores the text, asks the Scorer to
   * pick an action given the user's settings, then hides/blurs/tags/leaves it.
   * Finally emits a counter event unless the action was "off" (do nothing).
   */
  function processUnit(unit) {
    var s = settings();
    var local = Scorer.scoreText(unit.text, s.rules);
    var decision = Scorer.decide(local.scores, s, {
      author: unit.author,
      signals: local.signals,
      hasVideo: unit.hasVideo,
    });
    // Hide/blur the whole CARD — Facebook puts the post header/subject line
    // as a SIBLING of the article, so covering only the article leaves it
    // readable. expandUnit grows to the largest wrapper exclusive to this
    // post; tags stay on the unit itself.
    var target =
      decision.action === "hide" || decision.action === "blur"
        ? Extractors.expandUnit(unit.node)
        : unit.node;
    Apply.applyDecision(target, decision, {
      onReveal: function () {
        if (unit.hasVideo) approveAndPlay(unit.node);
        report("revealed", decision.category);
      },
    });
    // Mirror the marker onto the inner unit so re-scans skip it (see the
    // extension's processUnit for the full why).
    if (target !== unit.node && typeof unit.node.setAttribute === "function") {
      unit.node.setAttribute(Apply.PROCESSED_ATTR, Apply.stateOf(target) || "clean");
    }
    if (decision.action !== "off") report("filtered", decision.category, decision.action, unit.kind);

    // A meme's payload is text baked into pixels — invisible to everything
    // above. If this unit survived on its words alone, ask native to read any
    // images in it (Apple Vision, on-device) and judge it again with what they
    // say. Only for units we did NOT already act on, so OCR never overrides a
    // decision the text already justified.
    if (decision.action === "off" || decision.action === "tag") requestUnitOcr(unit);
  }

  /* ----- image text (OCR) ----------------------------------------------- *
   * Native reads the words in an image with Apple's Vision framework: fully
   * offline, no model to ship, nothing about the image leaves the device. The
   * engine only decides WHICH images are worth reading and what to do with the
   * words that come back. */

  /** Images we have already sent for reading, so a re-render cannot resend. */
  var ocrSeen = root.ocrSeen || (root.ocrSeen = {});
  /** Pending requests by id, so the reply can find its unit again. */
  var ocrPending = root.ocrPending || (root.ocrPending = {});
  var ocrNextId = 1;

  /** Budget per page: OCR is cheap but not free, and a feed is endless. */
  var OCR_MAX_PER_PAGE = 40;
  var ocrCount = 0;

  /**
   * Is this image worth reading? Feeds are full of avatars, icons, emoji and
   * tracking pixels; reading them wastes work and invites junk text.
   */
  function worthOcr(img) {
    if (!img || img.tagName !== "IMG") return false;
    var src = img.currentSrc || img.src || "";
    if (!src || src.indexOf("blob:") === 0) return false; // cannot be fetched natively
    if (ocrSeen[src]) return false;
    var rect;
    try { rect = img.getBoundingClientRect(); } catch (e) { return false; }
    // Big enough to carry readable text, and actually rendered.
    if (rect.width < 160 || rect.height < 160) return false;
    return true;
  }

  /** Ask native to read every worthwhile image inside this unit. */
  function requestUnitOcr(unit) {
    var s = settings();
    // Respect the user's ML/assist setting: image reading is the same kind of
    // help, and someone who turned the assist off did not ask for it.
    if (!s || !s.enabled || !s.ml || !s.ml.enabled) return;
    if (ocrCount >= OCR_MAX_PER_PAGE) return;
    if (!unit.node || typeof unit.node.querySelectorAll !== "function") return;
    var imgs = unit.node.querySelectorAll("img");
    for (var i = 0; i < imgs.length && ocrCount < OCR_MAX_PER_PAGE; i += 1) {
      var img = imgs[i];
      if (!worthOcr(img)) continue;
      var src = img.currentSrc || img.src;
      ocrSeen[src] = true;
      ocrCount += 1;
      var id = "ocr" + ocrNextId++;
      ocrPending[id] = unit;
      toNative({ type: "ocr", id: id, src: src });
    }
  }

  /**
   * Native calls this with the words it found. Re-judge the unit using its
   * page text PLUS the image text.
   *
   * The image text is appended to the unit's own text rather than scored alone,
   * so a sign in the background of a photo is read in context instead of as a
   * standalone statement — and so the same capped, pattern-led scoring applies.
   */
  function onOcrResult(id, text) {
    var unit = ocrPending[id];
    delete ocrPending[id];
    if (!unit || !text || text.length < 8) return;
    var node = unit.node;
    if (!node || !node.isConnected) return;
    // The unit was already judged on its words; only an image can change the
    // verdict now, and only toward MORE filtering (we never un-filter here).
    var state = Apply.stateOf(node);
    if (state === "hidden" || state === "blurred" || state === "revealed") return;
    var s = settings();
    var combined = (unit.text || "") + " " + text;
    var local = Scorer.scoreText(combined, s.rules);
    var decision = Scorer.decide(local.scores, s, {
      author: unit.author,
      signals: local.signals,
      hasVideo: unit.hasVideo,
    });
    if (decision.action === "off" || decision.action === "tag") return;
    // Clear the earlier "clean"/"tagged" mark so applyDecision will act.
    try {
      node.removeAttribute(Apply.PROCESSED_ATTR);
      node.removeAttribute(Apply.REASON_ATTR);
    } catch (e) { /* fall through — applyDecision guards itself */ }
    var target = Extractors.expandUnit(node);
    Apply.applyDecision(target, decision, {
      onReveal: function () {
        if (unit.hasVideo) approveAndPlay(node);
        report("revealed", decision.category);
      },
    });
    if (target !== node && typeof node.setAttribute === "function") {
      node.setAttribute(Apply.PROCESSED_ATTR, Apply.stateOf(target) || "clean");
    }
    report("filtered", decision.category, decision.action, unit.kind);
  }

  // Native replies land here.
  root.onOcrResult = onOcrResult;

  /**
   * Scan a subtree of the page for content units and process each one. Called
   * on start, on settings changes, and (debounced) whenever the page mutates.
   *
   * @param rootNode DOM element to scan under; defaults to the whole <body>.
   */
  function scan(rootNode) {
    var s = settings();
    if (!s || !s.enabled || !state.platform) return;
    var units = Extractors.findUnits(rootNode || document.body, {
      platform: state.platform,
      surfaces: s.surfaces, // which surfaces (feed/comments/ads/…) the user filters
      minLength: Scorer.MIN_LENGTH, // ignore trivially short snippets
    });
    // Cap the number handled per pass so a huge DOM change can't freeze the UI.
    for (var i = 0; i < units.length && i < MAX_UNITS_PER_SCAN; i += 1) {
      var unit = units[i];
      if (!Apply.needsWork(unit.node)) continue; // already handled — skip
      try {
        processUnit(unit);
      } catch (e) {
        // If classifying one unit throws, mark it clean so we never retry it in
        // a loop, and move on. One bad post must not break the whole page.
        Apply.mark(unit.node, "clean");
      }
    }
    sweepVideos();
  }

  /**
   * Debounce scans: many DOM mutations can fire in a burst as you scroll, so we
   * schedule at most one scan after a short quiet period (SCAN_DEBOUNCE_MS)
   * rather than scanning on every single mutation. The `if (state.scanTimer)`
   * guard means a scan already pending is left as-is.
   */
  function scheduleScan() {
    if (state.scanTimer) return;
    // setTimeout(fn, ms) runs fn once after ms milliseconds.
    state.scanTimer = setTimeout(function () {
      state.scanTimer = null;
      scan(document.body);
    }, SCAN_DEBOUNCE_MS);
  }

  /**
   * Start watching the page for changes. A MutationObserver fires a callback
   * whenever the DOM changes — new posts loading as you scroll, etc. We filter
   * out our own injected elements (class prefixed "valyou-") to avoid reacting
   * to changes we caused, then schedule a debounced re-scan.
   */
  function observe() {
    if (state.observer) return;
    state.observer = new MutationObserver(function (mutations) {
      var relevant = mutations.some(function (m) {
        return Array.prototype.slice.call(m.addedNodes || []).some(function (n) {
          return n.nodeType === 1 && !(n.className && String(n.className).indexOf("valyou-") === 0);
        });
      });
      if (relevant) scheduleScan();
    });
    // Watch the whole body: childList = direct child add/remove, subtree = at
    // any depth beneath it.
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Re-run from scratch after the native app pushes new settings. The native
   * side updates window.__VALYOU__.settings then calls this. We expose it on
   * `root` (window.__VALYOU__) precisely so the native App can reach it from
   * outside this IIFE via injectJavaScript. It undoes all prior filtering
   * (removes our markers, un-collapses/un-blurs, deletes our overlay chrome)
   * and then rescans the whole page with the new rules — so a settings change
   * takes effect instantly, with no page reload.
   *
   * @param next The new resolved settings object.
   */
  root.applySettings = function (next) {
    root.settings = next;
    syncModel();
    // Clear our "already processed" markers from every element we touched, so
    // the fresh scan below re-evaluates them under the new settings.
    var marked = document.querySelectorAll("[" + Apply.PROCESSED_ATTR + "]");
    for (var i = 0; i < marked.length; i += 1) {
      marked[i].removeAttribute(Apply.PROCESSED_ATTR);
      marked[i].removeAttribute(Apply.REASON_ATTR);
      marked[i].classList.remove("valyou-collapsed", "valyou-blurred");
    }
    // Remove the overlay elements we inserted (shields, bars, badges).
    var chrome = document.querySelectorAll(".valyou-shield, .valyou-bar, .valyou-badge");
    for (var j = 0; j < chrome.length; j += 1) {
      if (chrome[j].parentElement) chrome[j].parentElement.removeChild(chrome[j]);
    }
    scan(document.body); // re-filter the clean page under the new settings
  };

  /**
   * Entry point, run once at the bottom of this file. Bails out early if this
   * isn't a supported platform or if settings haven't been injected yet, then
   * wires everything up: load the ML model, guard autoplay, do the first scan,
   * start observing for changes, and finally tell native we're ready.
   */
  function start() {
    if (!state.platform) return;
    if (!settings()) return; // native must inject settings before the engine
    syncModel();
    state.startedAt = Date.now(); // lets justStarted() spot a fresh page load
    installPlayPatch();
    installAutoplayPatch();
    installTapTracker();
    installVideoPlayGuard();
    watchAllRoots(document); // instant-neutralise videos as they are inserted
    scan(document.body);
    observe();
    // SAFETY SWEEP (important on mobile). Mobile web is heavily lazy-loaded and
    // navigates as a single-page app, so a <video> can appear (or a new feed can
    // load) without a mutation the observer treats as relevant — and then a clip
    // autoplays un-gated. A low-frequency timer re-covers/pauses any videos that
    // slipped through and re-scans for new posts. sweepVideos() is cheap (it just
    // queries <video>); scheduleScan() is debounced and skips already-handled
    // nodes, so this stays light.
    if (typeof setInterval === "function" && !state.sweepTimer) {
      state.sweepTimer = setInterval(function () {
        try { sweepVideos(); scheduleScan(); } catch (e) { /* never throw into the host page */ }
      }, 500);
    }
    toNative({ type: "ready", platform: state.platform });
  }

  start();
})();
