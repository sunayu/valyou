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
 * Applying a decision to the page.
 *
 * ------------------------------------------------------------------------
 * BEGINNER ORIENTATION
 * ------------------------------------------------------------------------
 * This file is the WRITE half of the extension. Its partner, extractors.js,
 * only reads the page to find content units; this file takes a "decision"
 * (hide / blur / tag) that another layer produced and actually changes the
 * page to carry it out. Keeping reading and writing in separate files means
 * all the risky DOM-mutation logic lives in exactly one place.
 *
 * The functions here CREATE small elements (a bar, a shield overlay, a badge)
 * with document.createElement, wire up click handlers on them, and toggle CSS
 * classes on the target unit so the stylesheet can visually collapse or blur
 * it. They also pause/mute videos inside filtered units.
 *
 * Three principles shape this file:
 *
 * 1. NOTHING VANISHES SILENTLY. Every filtered unit leaves a visible, labelled
 *    marker explaining what was hidden and why, with one click to reveal.
 *    A filter that disappears content without a trace is indistinguishable
 *    from a bug, and it denies the user the information they need to tune it.
 *
 * 2. NO LAYOUT DESTRUCTION. We never remove nodes from the DOM. Facebook and
 *    Instagram are virtual-scrolled React apps that own their own subtrees;
 *    deleting a node they still hold a reference to causes reconciliation
 *    crashes. We overlay and collapse instead. ("Virtual scrolling" means the
 *    site constantly recycles the same handful of DOM nodes as you scroll, so
 *    a node we delete may be one React still expects to reuse.)
 *
 * 3. IDEMPOTENCE. A unit carries a data attribute recording what was done to
 *    it, so re-running over an already-processed subtree is a no-op.
 *    ("Idempotent" = running it twice has the same effect as running it once.)
 *    React re-renders constantly and the mutation observer fires on our own
 *    DOM writes, so this is what stops a feedback loop.
 */
// See extractors.js for a full explanation of this UMD/IIFE wrapper. In short:
// it runs immediately, keeps our helpers out of the global scope, and exposes
// the returned module as VALYOU.Apply in the browser and via module.exports
// for the Node test runner.
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Apply = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Two HTML attribute names we stamp onto units. `data-*` attributes are the
  // standard, spec-blessed way to store your own custom data directly on an
  // element without clashing with the site's own attributes. PROCESSED_ATTR
  // must match the one extractors.js checks, so a handled unit is skipped on
  // the next scan. REASON_ATTR stores the human-readable "why" for debugging.
  const PROCESSED_ATTR = "data-valyou";
  const REASON_ATTR = "data-valyou-reason";

  /**
   * Mark a unit as handled so later passes skip it.
   *
   * This is how idempotence (principle 3) is enforced: writing our state onto
   * the node is the record that stops us processing it again.
   *
   * @param {Element} node Unit root.
   * @param {string} state One of clean | hidden | blurred | tagged | revealed.
   * @param {string} [reason] Explanation shown to the user.
   */
  function mark(node, state, reason) {
    // `setAttribute(name, value)` writes an attribute onto the element, e.g.
    // it produces data-valyou="hidden" in the HTML.
    node.setAttribute(PROCESSED_ATTR, state);
    if (reason) node.setAttribute(REASON_ATTR, reason);
  }

  /**
   * Read the current state of a unit.
   *
   * @param {Element} node Unit root.
   * @returns {string|null} Stored state, or null when never processed.
   */
  function stateOf(node) {
    // `getAttribute` reads back what `setAttribute` stored (or null if absent).
    // The typeof guard keeps this safe on stub nodes used in tests.
    return typeof node.getAttribute === "function" ? node.getAttribute(PROCESSED_ATTR) : null;
  }

  /**
   * Should this unit be (re)processed?
   *
   * `revealed` is sticky: once a user has explicitly chosen to see something,
   * we never re-hide it, even if a settings change would now filter it. That
   * would override a deliberate user action.
   *
   * @param {Element} node Unit root.
   * @returns {boolean}
   */
  function needsWork(node) {
    const state = stateOf(node);
    // null means "never touched", so it needs work. ANY stored state (including
    // "revealed") means leave it alone — which is what makes reveal sticky.
    return state === null;
  }

  /**
   * Silence and stop every video inside a filtered unit.
   *
   * Hiding is done with display:none and blurring with a CSS filter — and an
   * HTML5 video keeps PLAYING through both. Without this step, "hiding" a
   * hateful video would remove the pixels while its audio track carried on,
   * which is worse than not filtering at all.
   *
   * Feed players also love to resume themselves (autoplay observers,
   * scroll-position restoration), so pausing once is not enough: a guard
   * listener re-pauses any playback attempt for as long as the unit remains
   * filtered. The guard consults live state, so after a reveal it stands
   * down without needing to be unhooked.
   *
   * @param {Element} unitNode Filtered unit root.
   */
  function neutralizeMedia(unitNode) {
    if (typeof unitNode.querySelectorAll !== "function") return;

    // Loop over every <video> element inside the filtered unit.
    for (const video of unitNode.querySelectorAll("video")) {
      // try/catch runs risky code and catches any error instead of crashing.
      // Calling pause() on a detached or site-controlled player can throw, and
      // we'd rather quietly move on than break the whole apply pass.
      try {
        if (typeof video.pause === "function") video.pause();
      } catch {
        /* detached or host-managed player; nothing to do */
      }

      // Remember that WE muted it, so reveal can restore the user's state
      // rather than leaving a mystery-muted player behind. We only touch mute
      // if the user hadn't already muted it themselves (muted === false).
      if (video.muted === false) {
        video.muted = true;
        video.setAttribute("data-valyou-muted", "1");
      }
      video.autoplay = false;

      // Install a one-time "resume guard". `addEventListener("play", fn)`
      // registers `fn` to run every time the video starts playing. Feeds try
      // to auto-resume videos, so pausing once isn't enough — this listener
      // re-pauses on each play attempt. The data-valyou-guard attribute is a
      // flag so we attach the listener only once per video, not on every pass.
      if (typeof video.addEventListener === "function" && !video.getAttribute("data-valyou-guard")) {
        video.setAttribute("data-valyou-guard", "1");
        video.addEventListener("play", () => {
          // The listener reads LIVE state each time it fires. Once the unit is
          // "revealed" this condition is false, so the guard stops interfering
          // on its own — no need to ever remove the listener.
          const state = stateOf(unitNode);
          if (state === "hidden" || state === "blurred") {
            try {
              if (typeof video.pause === "function") video.pause();
            } catch {
              /* ignore */
            }
            video.muted = true;
          }
        });
      }
    }
  }

  /**
   * Undo the parts of media neutralization that belong to the user.
   *
   * Videos stay paused — auto-resuming revealed content would be a jump
   * scare — but mute is restored where we imposed it, so pressing play
   * behaves exactly as it would have without valyou.
   *
   * @param {Element} unitNode Revealed unit root.
   */
  function restoreMedia(unitNode) {
    if (typeof unitNode.querySelectorAll !== "function") return;
    for (const video of unitNode.querySelectorAll("video")) {
      // Only unmute videos WE muted (they carry our marker attribute); leave
      // the user's own manual mutes untouched. removeAttribute cleans up the
      // marker afterward so the state is fully reset.
      if (video.getAttribute("data-valyou-muted")) {
        video.muted = false;
        video.removeAttribute("data-valyou-muted");
      }
    }
  }

  /**
   * Build the interactive shield element.
   *
   * @param {Document} doc Owning document.
   * @param {{action: string, category: string|null, reason: string, onReveal: function}} options
   * @returns {Element} Shield element ready to insert.
   */
  function buildShield(doc, options) {
    // `doc.createElement("div")` makes a brand-new, detached <div> element in
    // memory. It isn't on the page until something appends it (done later).
    const shield = doc.createElement("div");
    // `className` sets the element's CSS class(es) as one space-separated
    // string. The backtick `...` is a template literal, letting us splice a
    // value in with ${...}: e.g. action "blur" yields "valyou-shield valyou-blur".
    shield.className = `valyou-shield valyou-${options.action}`;
    // Keep the shield out of the accessibility tree's reading order until the
    // user interacts; the button inside remains reachable.
    shield.setAttribute("role", "group");
    shield.setAttribute("aria-label", `Content filtered by valyou: ${options.reason}`);

    // The label is a <span> showing the reason text. `textContent = ...` sets
    // its text SAFELY: unlike innerHTML it never interprets the value as HTML,
    // so a reason string can't inject markup.
    const label = doc.createElement("span");
    label.className = "valyou-label";
    label.textContent = options.reason;

    const button = doc.createElement("button");
    button.className = "valyou-reveal";
    button.type = "button";
    button.textContent = "Show anyway";
    // Run this callback when the button is clicked. The `event` object carries
    // details and controls about the click.
    button.addEventListener("click", (event) => {
      // preventDefault stops the browser's default reaction to the click.
      event.preventDefault();
      // stopPropagation keeps the click from "bubbling" up to parent elements —
      // without it the underlying post (a link) would also register the click.
      event.stopPropagation(); // never let the click reach the post underneath
      options.onReveal();
    });

    // `appendChild` inserts an element as the last child of the parent, so the
    // label then the button become the shield's contents.
    shield.appendChild(label);
    shield.appendChild(button);
    return shield;
  }

  /**
   * Hide a unit by collapsing it to a single labelled bar.
   *
   * The original subtree stays in the DOM (see principle 2) but is visually
   * removed via a class, so the page's own scripts keep working on it.
   *
   * @param {Element} node Unit root.
   * @param {{reason: string, category: string|null, onReveal?: function}} decision
   * @returns {Element} The inserted bar.
   */
  function hide(node, decision) {
    // `ownerDocument` is the Document the node belongs to; we use it to create
    // new elements in the same page (important when inside an iframe).
    const doc = node.ownerDocument;
    // `classList.add(name)` adds a CSS class without disturbing existing ones.
    // Our stylesheet uses .valyou-collapsed to visually shrink the unit to
    // nothing — the node stays in the DOM (principle 2), just hidden by CSS.
    node.classList.add("valyou-collapsed");

    const bar = doc.createElement("div");
    bar.className = "valyou-bar";

    const label = doc.createElement("span");
    label.className = "valyou-label";
    label.textContent = `Hidden by valyou — ${decision.reason}`;

    const button = doc.createElement("button");
    button.className = "valyou-reveal";
    button.type = "button";
    button.textContent = "Show";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Clicking "Show" reveals the unit and removes this bar, then notifies
      // any caller-supplied onReveal callback (e.g. to log the choice).
      reveal(node, bar);
      if (decision.onReveal) decision.onReveal();
    });

    bar.appendChild(label);
    bar.appendChild(button);
    // `insertBefore(newNode, referenceChild)` puts newNode just before
    // referenceChild among the parent's children. Passing `node.firstChild`
    // makes the bar the FIRST child, INSIDE the unit. We do this rather than
    // inserting the bar as a sibling BEFORE the unit because virtual scrollers
    // recycle siblings, and a sibling we injected can end up orphaned. (`|| null`
    // handles an empty unit with no first child.)
    node.insertBefore(bar, node.firstChild || null);

    mark(node, "hidden", decision.reason);
    neutralizeMedia(node); // after mark: the resume guard reads unit state
    return bar;
  }

  /**
   * Blur a unit behind a click-to-reveal shield. Layout is preserved, so the
   * feed does not jump as items resolve.
   *
   * @param {Element} node Unit root.
   * @param {{reason: string, category: string|null, action?: string, onReveal?: function}} decision
   * @returns {Element} The inserted shield.
   */
  function blur(node, decision) {
    const doc = node.ownerDocument;
    // Unlike hide's collapse, .valyou-blurred keeps the unit at full size but
    // applies a CSS blur filter, so the feed's layout doesn't jump around.
    node.classList.add("valyou-blurred");

    const shield = buildShield(doc, {
      action: "blur",
      category: decision.category,
      reason: decision.reason,
      onReveal: () => {
        reveal(node, shield);
        if (decision.onReveal) decision.onReveal();
      },
    });

    node.insertBefore(shield, node.firstChild || null);
    mark(node, "blurred", decision.reason);
    neutralizeMedia(node); // after mark: the resume guard reads unit state
    return shield;
  }

  /**
   * Leave the unit fully visible and attach a small badge. For users who want
   * awareness without filtering.
   *
   * @param {Element} node Unit root.
   * @param {{reason: string, category: string|null}} decision
   * @returns {Element} The inserted badge.
   */
  function tag(node, decision) {
    const doc = node.ownerDocument;
    // The lightest action: no class on the unit, no hiding — just a small
    // badge inserted at the top. The content stays fully visible.
    const badge = doc.createElement("div");
    badge.className = "valyou-badge";
    badge.textContent = decision.reason;
    node.insertBefore(badge, node.firstChild || null);
    mark(node, "tagged", decision.reason);
    return badge;
  }

  /**
   * Undo a hide or blur: strip our classes, remove the injected chrome, and
   * record the reveal so no later pass re-filters this unit.
   *
   * @param {Element} node Unit root.
   * @param {Element} [chrome] The bar or shield to remove.
   */
  function reveal(node, chrome) {
    // "chrome" here means the UI furniture we added (the bar or shield), not
    // the browser. Remove our visual classes so the unit shows normally...
    node.classList.remove("valyou-collapsed");
    node.classList.remove("valyou-blurred");
    // ...then detach the injected bar/shield. `chrome.parentElement` is the
    // element containing it; removeChild takes it back out of the DOM. We check
    // parentElement first so we never call removeChild on an already-gone node.
    if (chrome && chrome.parentElement) chrome.parentElement.removeChild(chrome);
    // Record "revealed" — a sticky state (see needsWork) that prevents any
    // future pass from re-filtering this unit the user deliberately opened.
    mark(node, "revealed");
    restoreMedia(node); // after mark: the resume guard must see "revealed"
  }

  /**
   * Apply a decision to a unit. Single entry point used by main.js.
   *
   * @param {Element} node Unit root.
   * @param {{action: string, category: string|null, reason: string}} decision
   * @param {{onReveal?: function}} [handlers] Optional callbacks.
   * @returns {string} The state that was applied.
   */
  function applyDecision(node, decision, handlers) {
    // `Object.assign(target, ...sources)` copies properties into target. Start
    // from a fresh `{}` so we neither mutate the caller's decision nor handlers,
    // then merge both into one combined options object for the action helpers.
    const opts = Object.assign({}, decision, handlers || {});

    // Dispatch on the requested action. `switch` compares decision.action
    // against each `case`; anything unrecognized falls through to `default`,
    // where we simply mark the unit "clean" (seen, but nothing to filter).
    switch (decision.action) {
      case "hide":
        hide(node, opts);
        return "hidden";
      case "blur":
        blur(node, opts);
        return "blurred";
      case "tag":
        tag(node, opts);
        return "tagged";
      default:
        mark(node, "clean");
        return "clean";
    }
  }

  // Exported as VALYOU.Apply (and via module.exports for tests). applyDecision
  // is the single entry point main.js calls; the rest are exposed so tests can
  // drive the individual behaviors directly.
  return {
    PROCESSED_ATTR,
    REASON_ATTR,
    mark,
    stateOf,
    needsWork,
    buildShield,
    hide,
    blur,
    tag,
    reveal,
    applyDecision,
    neutralizeMedia,
    restoreMedia,
  };
});
