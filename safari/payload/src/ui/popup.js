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
 * Toolbar popup: the at-a-glance controls.
 *
 * WHAT THIS SCREEN IS: In a browser extension, clicking the toolbar icon opens
 * a tiny HTML page — the "popup". This file is the JavaScript that brings that
 * page to life: it reads the little checkboxes/labels in popup.html, reacts
 * when the user clicks them, and paints numbers (today's / all-time counts)
 * back onto the page.
 *
 * HOW IT TALKS TO THE REST OF THE EXTENSION: The popup does not own the real
 * settings or statistics. Those live in the extension's "service worker" (a
 * background script that keeps running even when no popup is open). This file
 * asks the service worker for data and sends changes back to it using
 * `chrome.runtime.sendMessage(...)` — think of it as a small request/response
 * conversation between this page and the background brain of the extension.
 *
 * Scope is deliberately narrow — a master switch, today's counts, and a
 * per-category on/off. Anything that needs thought (thresholds, custom rules,
 * encryption mode) lives in options, so the popup stays a one-second
 * interaction.
 */
// This whole file is wrapped in an IIFE (Immediately Invoked Function
// Expression): a function that is defined and then immediately called by the
// `()` at the very bottom. WHY: everything declared inside (variables, helper
// functions) stays private to this file instead of leaking into the page's
// shared global namespace, where it could clash with other scripts.
(function () {
  // "use strict" opts this file into JavaScript's stricter rules, which turn
  // silent mistakes (like assigning to an undeclared variable) into loud
  // errors. It is a common safety habit at the top of a script.
  "use strict";

  // The extension attaches its shared code to a single global object,
  // `window.VALYOU`. Here we pull out `Taxonomy` (the list of content
  // categories, actions, and defaults) using object destructuring — a shorthand
  // for `const Taxonomy = window.VALYOU.Taxonomy;`.
  const { Taxonomy } = window.VALYOU;

  // Look up every HTML element we care about ONCE, up front, and stash them in
  // an `el` object so the rest of the code can say `el.enabled` instead of
  // re-searching the page each time. `document.getElementById("enabled")` finds
  // the element in popup.html whose id attribute is "enabled".
  const el = {
    enabled: document.getElementById("enabled"),
    categories: document.getElementById("categories"),
    today: document.getElementById("today"),
    allTime: document.getElementById("alltime"),
    locked: document.getElementById("locked"),
    body: document.getElementById("body"),
    passphrase: document.getElementById("passphrase"),
    unlock: document.getElementById("unlock"),
    unlockError: document.getElementById("unlock-error"),
    openOptions: document.getElementById("open-options"),
  };

  // A local COPY of the settings the service worker gave us. We read from this
  // copy to draw the UI, and after every change we send the copy back so the
  // worker can save it. It starts as `null` because we have not loaded anything
  // yet (see boot()).
  /** Local mirror of settings; written back on every change. */
  let settings = null;

  /**
   * Send a message to the service worker (the extension's background script)
   * and get its reply back.
   *
   * `chrome.runtime.sendMessage` returns a Promise, so callers use
   * `await send(...)` to pause until the worker answers. Centralizing it in one
   * tiny helper means the rest of the file just calls `send({ type: "..." })`.
   *
   * @param {object} message Payload. By convention it has a `type` field that
   *   tells the worker which action to run (e.g. "getSettings").
   * @returns {Promise<object>} Reply from the worker.
   */
  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  /**
   * Render the per-category toggle list.
   *
   * A category is "on" when its action is anything other than `off`. Turning
   * one back on restores the taxonomy default action rather than guessing,
   * so the behaviour matches what a fresh install would do.
   */
  function renderCategories() {
    // Wipe whatever list was drawn before. Setting `.innerHTML = ""` empties the
    // container element, so we can rebuild the list cleanly from current
    // settings instead of trying to patch individual rows.
    el.categories.innerHTML = "";

    // Build one list item per category. `Taxonomy.CATEGORIES` is the master list
    // of content types (harassment, spam, etc.); `for...of` walks each one.
    for (const category of Taxonomy.CATEGORIES) {
      // This category's current config from our local settings copy, looked up
      // by the category's id.
      const config = settings.categories[category.id];
      // Create DOM elements in memory. Nothing appears on screen until we attach
      // them to the page further down. <li> = one list row.
      const item = document.createElement("li");

      // A <label> wraps the checkbox and text so clicking the text also toggles
      // the box. `.className` sets the CSS class; `.title` is the tooltip shown
      // on hover.
      const label = document.createElement("label");
      label.className = "category";
      label.title = category.description;

      // The on/off checkbox. Setting `.type = "checkbox"` makes this <input> a
      // checkbox; `.checked` controls whether it is ticked. A category counts as
      // "on" whenever its action is anything other than "off".
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = config.action !== "off";
      // `addEventListener("change", ...)` registers a callback that runs each
      // time the user toggles this box. The callback is `async` so it can
      // `await` the save. WHY restore a "fallback": turning a category back on
      // reinstates the taxonomy's DEFAULT action for it, matching a fresh
      // install, rather than guessing which action the user wanted.
      checkbox.addEventListener("change", async () => {
        const fallback = Taxonomy.DEFAULT_SETTINGS.categories[category.id].action;
        settings.categories[category.id].action = checkbox.checked ? fallback : "off";
        await persist();
      });

      // The category's display name. `.textContent` sets plain text safely
      // (unlike innerHTML, it never interprets the string as HTML).
      const name = document.createElement("span");
      name.className = "category-name";
      name.textContent = category.label;

      // A small badge showing which action is active (blank when "off").
      const action = document.createElement("span");
      action.className = "category-action";
      action.textContent = config.action === "off" ? "" : config.action;

      // Now stitch the pieces together and attach the finished row to the page.
      // `.append(...)` adds children in order; `.appendChild(...)` adds one.
      // This is the moment the row actually becomes visible in the popup.
      label.append(checkbox, name, action);
      item.appendChild(label);
      el.categories.appendChild(item);
    }
  }

  /**
   * Save the current settings and redraw the parts of the UI they affect.
   *
   * WHY re-render from the reply: the worker is the source of truth. It may
   * clean up or adjust what we sent, so we overwrite our local copy with the
   * `settings` it echoes back, then redraw so the screen reflects reality.
   */
  async function persist() {
    const reply = await send({ type: "saveSettings", settings });
    // `reply && reply.settings` guards against a missing/empty reply before we
    // read `reply.settings` — reading a property of `null` would throw.
    if (reply && reply.settings) {
      settings = reply.settings;
      renderCategories();
    }
  }

  /**
   * Ask the worker for the counters and write them into the popup.
   *
   * `String(...)` converts the number to text because `.textContent` expects a
   * string. `stats.total || 0` falls back to 0 when the value is missing.
   */
  async function loadStats() {
    const reply = await send({ type: "getStats" });
    const stats = (reply && reply.stats) || {};
    el.today.textContent = String(stats.total || 0);
    el.allTime.textContent = String(stats.allTime || 0);
  }

  /**
   * Swap the popup into its "locked" state.
   *
   * We do not create/destroy elements; both the unlock form and the main body
   * already exist in the HTML. Toggling a CSS class named "hidden" (which the
   * stylesheet sets to `display:none`) shows one and hides the other.
   * `classList.add`/`remove` add or remove that class.
   */
  function showLocked() {
    el.locked.classList.remove("hidden");
    el.body.classList.add("hidden");
  }

  /**
   * Try to unlock a passphrase-protected vault using what the user typed.
   *
   * Reads the passphrase from the input box, sends it to the worker to verify,
   * then either reveals the main UI (success) or shows an error message. No
   * return value — its whole job is the side effects on screen.
   */
  async function handleUnlock() {
    // Clear any previous error text before we try again.
    el.unlockError.textContent = "";
    // `el.passphrase.value` is whatever the user typed into the <input>. We copy
    // it into a small object so we can null it out below alongside the field.
    const box = { value: el.passphrase.value };
    const reply = await send({ type: "security.unlock", passphrase: box.value });

    // Clear the field immediately whether or not it worked, so the passphrase
    // does not sit in a DOM node while the popup stays open.
    el.passphrase.value = "";
    box.value = "";

    if (reply && reply.ok) {
      // Unlocked: hide the lock screen, reveal the body, then load real data.
      el.locked.classList.add("hidden");
      el.body.classList.remove("hidden");
      await boot();
    } else {
      // Failed: show a specific message for a wrong passphrase, otherwise a
      // generic one. This is a ternary (`condition ? a : b`) — a compact
      // if/else that produces a value.
      el.unlockError.textContent =
        reply && reply.error === "BAD_PASSPHRASE"
          ? "Incorrect passphrase."
          : "Could not unlock.";
    }
  }

  /**
   * Entry point: fetch the current state from the worker and paint the popup.
   *
   * Runs once when the popup opens (called at the bottom of the file), and again
   * right after a successful unlock. If the vault is locked, it shows the unlock
   * form and stops early instead of trying to render settings we do not have.
   */
  async function boot() {
    const reply = await send({ type: "getSettings" });
    if (!reply) return; // No answer from the worker; nothing we can draw.

    if (reply.locked) {
      showLocked();
      return; // `return` here stops boot() early — the rest only runs unlocked.
    }

    // Unlocked path: store the settings, tick the master switch to match, draw
    // the category list, and fill in the counters.
    settings = reply.settings;
    el.enabled.checked = settings.enabled;
    renderCategories();
    await loadStats();
  }

  // --- Wire up the fixed controls that exist for the whole life of the popup.
  // These listeners are registered once, here at the top level, rather than
  // inside a function that runs repeatedly.

  // The master on/off switch in the header.
  el.enabled.addEventListener("change", async () => {
    // The master switch sits in the header, outside the section showLocked()
    // hides, so it stays clickable while the vault is locked — at which point
    // there are no settings to mutate. Revert the visual state and bail.
    // `el.enabled.checked = !el.enabled.checked` flips the box back to how it
    // was, so it does not look changed when we could not actually save.
    if (!settings) {
      el.enabled.checked = !el.enabled.checked;
      return;
    }
    settings.enabled = el.enabled.checked;
    await persist();
  });

  // Clicking the "Unlock" button runs handleUnlock. Passing the function by name
  // (no parentheses) hands it to the listener to call later on each click.
  el.unlock.addEventListener("click", handleUnlock);
  // Let the user press Enter in the passphrase field instead of clicking.
  // `keydown` fires for every key; we act only when it is the Enter key.
  el.passphrase.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleUnlock();
  });

  // The "Open options" link asks Chrome to open the full settings page.
  el.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Kick everything off: load state and draw the popup.
  boot();
// The trailing `()` immediately calls the wrapper function defined at the top,
// running all of the above the moment the popup's script loads.
})();
