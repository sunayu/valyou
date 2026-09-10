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
 * Options page.
 *
 * WHAT THIS SCREEN IS: The full settings page for the extension (its own HTML
 * page, options.html, opened from the popup's "Open options" link or the
 * browser's extension menu). Where the popup is a quick toggle, this page is the
 * detailed control panel: per-category actions and sensitivity, which parts of
 * the site to filter, video handling, custom allow/block lists, a "try it" test
 * box, and security/passphrase setup.
 *
 * HOW IT TALKS TO THE REST OF THE EXTENSION: Just like the popup, it does not
 * store settings itself. It keeps a local COPY, lets the user edit that copy
 * through form controls, and sends the whole object back to the background
 * "service worker" with `chrome.runtime.sendMessage(...)`. The worker is the
 * authority: it cleans up / validates whatever arrives (rules live in
 * lib/settings.js) and echoes back the truth, which we then trust.
 *
 * The page holds a local mirror of settings and writes the whole object back
 * on change (debounced). The service worker sanitizes whatever arrives, so
 * this file can stay focused on presentation rather than validation — the
 * authoritative rules live in lib/settings.js and are enforced regardless of
 * what this page sends.
 */
// IIFE (Immediately Invoked Function Expression): the whole file is a function
// that runs itself via the `()` at the bottom. WHY: it keeps every variable and
// helper below private to this file instead of polluting the page's shared
// globals.
(function () {
  // Opt into JavaScript's stricter error-checking mode (see popup.js for more).
  "use strict";

  // --- TEMPORARY self-diagnostic. If the page comes up blank, show WHY at the
  // top instead of failing silently. Distinguishes: taxonomy.js not loaded vs.
  // the worker not answering vs. a worker/storage error. Remove once resolved.
  function diag(msg) {
    try {
      let b = document.getElementById("valyou-diag");
      if (!b) {
        b = document.createElement("pre");
        b.id = "valyou-diag";
        b.style.cssText =
          "position:sticky;top:0;z-index:99999;margin:0;padding:10px 14px;" +
          "background:#3a0d16;color:#ffd0d8;white-space:pre-wrap;" +
          "font:12px/1.5 ui-monospace,Menlo,monospace;border-bottom:1px solid #ff8095;";
        document.body.insertBefore(b, document.body.firstChild);
      }
      b.textContent += (b.textContent ? "\n" : "") + msg;
    } catch (e) {
      /* if even this fails there is nothing more we can do */
    }
  }

  // Pull `Taxonomy` (categories, actions, surfaces, defaults) out of the
  // extension's shared global object. Guarded: if ../lib/taxonomy.js failed to
  // load (a script/CSP/path problem, common when porting to Safari), report it
  // and fall back to empty lists so the page doesn't throw on the next line.
  const VALYOU = window.VALYOU;
  if (!VALYOU || !VALYOU.Taxonomy) {
    diag(
      "valyou: window.VALYOU.Taxonomy is MISSING — ../lib/taxonomy.js did not load.\n" +
        "typeof VALYOU=" + typeof VALYOU +
        "; keys=" + (VALYOU ? Object.keys(VALYOU).join(",") : "n/a")
    );
  }
  const Taxonomy =
    (VALYOU && VALYOU.Taxonomy) ||
    { CATEGORIES: [], SURFACES: [], ACTIONS: [], DEFAULT_SETTINGS: { categories: {} } };

  // Our working COPY of the settings. We edit this as the user changes controls,
  // then send it to the worker; the worker's echoed-back version replaces it.
  /** Local mirror; never trusted as authoritative — the worker echoes back truth. */
  let settings = null;

  // Holds the pending save timer so we can cancel it (see scheduleSave). Lets us
  // wait until edits settle before writing, instead of saving on every keystroke.
  /** Debounce handle for the settings write. */
  let saveTimer = null;

  // Shorthand helper: `$("foo")` == `document.getElementById("foo")`, i.e. find
  // the element in options.html whose id is "foo". Saves a lot of typing since
  // this page touches many elements.
  const $ = (id) => document.getElementById(id);

  /**
   * Send a message to the background service worker and return its reply.
   *
   * `chrome.runtime.sendMessage` returns a Promise, so callers `await` it.
   *
   * @param {object} message Payload (its `type` field names the action).
   * @returns {Promise<object>} Reply from the worker.
   */
  // Cross-browser messaging. Chrome's `chrome.runtime.sendMessage(msg)` returns
  // a Promise; Safari's `chrome.*` does NOT (it replies via callback, or via the
  // promise-based `browser.*` API). Relying on the Promise return would make
  // `await send(...)` resolve to undefined in Safari, so settings/categories
  // never load. Use `browser` (promise) when present, else wrap Chrome's
  // callback form in a Promise.
  const send = (message) => {
    if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
      return browser.runtime.sendMessage(message);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply);
        });
      } catch (e) {
        resolve(undefined);
      }
    });
  };

  /**
   * Persist the mirror, coalescing rapid edits (slider drags) into one write
   * so a slider drag does not produce dozens of encrypted writes and
   * broadcasts.
   */
  function scheduleSave() {
    // Immediately show "Saving…" so the user sees their edit registered.
    $("save-state").textContent = "Saving…";
    // This is the "debounce": cancel any save that was already scheduled...
    clearTimeout(saveTimer);
    // ...then schedule a new one 250ms in the future. If the user keeps editing
    // (e.g. dragging a slider), each call clears the last timer and starts over,
    // so the actual save only runs once things go quiet for 250ms.
    saveTimer = setTimeout(async () => {
      const reply = await send({ type: "saveSettings", settings });
      if (reply && reply.settings) {
        // Replace our copy with the worker's cleaned-up version, then show
        // "Saved" and clear that message after 1.5 seconds.
        settings = reply.settings;
        $("save-state").textContent = "Saved";
        setTimeout(() => ($("save-state").textContent = ""), 1500);
      }
    }, 250);
  }

  /* ---------------------------------------------------------------- *
   * Category table                                                    *
   * ---------------------------------------------------------------- */

  /**
   * Build the category table: one <tr> row per category, each with an action
   * dropdown and a sensitivity slider. Called on load and reflects current
   * settings. No return value — it rebuilds the table in the page.
   */
  function renderCategories() {
    // `<tbody>` is the table's body. Emptying it with innerHTML = "" lets us
    // rebuild every row cleanly from the current settings.
    const tbody = $("category-rows");
    tbody.innerHTML = "";

    for (const category of Taxonomy.CATEGORIES) {
      const config = settings.categories[category.id];
      // A table ROW; the three cells (<td>) below become its columns.
      const row = document.createElement("tr");

      // --- Column 1: the category name plus a muted description underneath.
      const nameCell = document.createElement("td");
      const name = document.createElement("strong");
      name.textContent = category.label;
      const description = document.createElement("p");
      description.className = "muted small";
      description.textContent = category.description;
      nameCell.append(name, description);

      // --- Column 2: a dropdown (<select>) to pick what to do with this
      // category. We add one <option> per possible action.
      const actionCell = document.createElement("td");
      const select = document.createElement("select");
      for (const action of Taxonomy.ACTIONS) {
        const option = document.createElement("option");
        option.value = action; // machine value stored in settings
        // Map the internal action name to a friendly label via an object used
        // as a lookup table: `{...}[action]` reads the property named by action.
        option.textContent = { hide: "Hide", blur: "Blur", tag: "Label only", off: "Ignore" }[action];
        // Pre-select the option matching the saved action so the dropdown opens
        // showing the current choice.
        option.selected = config.action === action;
        select.appendChild(option);
      }
      // When the user picks a different option, `select.value` is the chosen
      // action; store it and schedule a save.
      select.addEventListener("change", () => {
        settings.categories[category.id].action = select.value;
        scheduleSave();
      });
      actionCell.appendChild(select);

      // --- Column 3: a slider (<input type="range">) for sensitivity, plus an
      // <output> that shows a words-not-numbers readout beside it.
      const thresholdCell = document.createElement("td");
      const slider = document.createElement("input");
      slider.type = "range";
      // Inverted presentation: users think in "sensitivity", the engine works
      // in "threshold". High sensitivity == low threshold.
      // min/max/step define the slider's allowed range and increment; note they
      // are strings because HTML input attributes are always text.
      slider.min = "0.2";
      slider.max = "0.95";
      slider.step = "0.05";
      slider.value = String(config.threshold);
      const readout = document.createElement("output");
      readout.textContent = describeSensitivity(config.threshold);
      // `input` fires continuously as the slider is dragged (unlike `change`,
      // which waits until release), so the readout updates live. `Number(...)`
      // converts the slider's string value to an actual number for storage.
      slider.addEventListener("input", () => {
        const value = Number(slider.value);
        settings.categories[category.id].threshold = value;
        readout.textContent = describeSensitivity(value);
        scheduleSave();
      });
      thresholdCell.append(slider, readout);

      // Assemble the row from its three cells and attach it to the table body.
      row.append(nameCell, actionCell, thresholdCell);
      tbody.appendChild(row);
    }
  }

  /**
   * Translate a numeric threshold into words. Numbers alone give a user no
   * way to predict behaviour; these labels do.
   *
   * @param {number} threshold Value in 0..1.
   * @returns {string} Human label.
   */
  function describeSensitivity(threshold) {
    if (threshold <= 0.35) return "very sensitive";
    if (threshold <= 0.5) return "sensitive";
    if (threshold <= 0.7) return "balanced";
    if (threshold <= 0.85) return "cautious";
    return "only the clearest cases";
  }

  /* ---------------------------------------------------------------- *
   * Surfaces                                                          *
   * ---------------------------------------------------------------- */

  // Maps each internal "surface" id to the label shown to the user. A "surface"
  // is a place on the site where filtering can apply (the feed, comments, etc.).
  const SURFACE_LABELS = {
    feed: "Feed posts",
    comments: "Comments",
    ads: "Ads & sponsored posts",
    messages: "Direct messages",
    reels: "Reels & short video",
  };

  /**
   * Draw one checkbox per surface so the user can pick where filtering runs.
   * No return value — it fills the "surface-toggles" container in the page.
   */
  function renderSurfaces() {
    const container = $("surface-toggles");
    container.innerHTML = ""; // clear before rebuilding

    for (const surface of Taxonomy.SURFACES) {
      // A <label> wrapping the checkbox and its text, so clicking the words also
      // toggles the box.
      const label = document.createElement("label");
      label.className = "inline";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      // Tick the box if this surface is currently enabled in settings.
      checkbox.checked = settings.surfaces[surface];
      checkbox.addEventListener("change", () => {
        settings.surfaces[surface] = checkbox.checked;
        scheduleSave();
      });

      // `document.createTextNode(...)` makes a plain-text node to sit next to the
      // checkbox. `SURFACE_LABELS[surface] || surface` uses the friendly label,
      // falling back to the raw id if none is defined.
      label.append(checkbox, document.createTextNode(SURFACE_LABELS[surface] || surface));
      container.appendChild(label);
    }
  }

  /* ---------------------------------------------------------------- *
   * Video handling                                                    *
   * ---------------------------------------------------------------- */

  /** Honest one-line consequence for each mode. */
  const VIDEO_MODE_NOTES = {
    hide: "Every video is blocked and covered — nothing plays or even shows until you click to play it. One click reveals and starts the video you chose.",
    block: "No video autoplays. Each stays visible but paused and muted until you click it — a real click always plays it. Posts are still filtered on text.",
    allow: "Videos autoplay as normal and are filtered only if their text trips the rules.",
  };

  /**
   * Connect the existing (already-in-HTML) video controls to settings: the
   * mode dropdown, the explanatory note that updates with it, and the
   * "blur flagged videos" checkbox. No return value.
   */
  function renderVideoMode() {
    // Unlike the tables above, these controls already exist in options.html, so
    // we just look them up and set their current value / wire their events.
    const select = $("video-mode");
    select.value = settings.media.video; // reflect the saved choice
    // Show the plain-language consequence for the current mode.
    $("video-mode-note").textContent = VIDEO_MODE_NOTES[settings.media.video] || "";
    select.addEventListener("change", () => {
      settings.media.video = select.value;
      // Keep the note in sync when the mode changes.
      $("video-mode-note").textContent = VIDEO_MODE_NOTES[select.value] || "";
      scheduleSave();
    });

    const flaggedBlur = $("flagged-video-blur");
    flaggedBlur.checked = settings.media.flaggedVideoBlur;
    flaggedBlur.addEventListener("change", () => {
      settings.media.flaggedVideoBlur = flaggedBlur.checked;
      scheduleSave();
    });
  }

  /* ---------------------------------------------------------------- *
   * Rules                                                             *
   * ---------------------------------------------------------------- */

  /**
   * Connect a multi-line text box (<textarea>) to a list-of-strings setting,
   * where each line in the box is one list entry (e.g. blocked terms).
   *
   * @param {string} elementId The id of the textarea in options.html.
   * @param {string} path The key inside `settings.rules` to read/write.
   */
  function bindList(elementId, path) {
    const field = $(elementId);
    // Show the saved list as text: `join("\n")` turns an array into one string
    // with a newline between items. `settings.rules[path] || []` guards against
    // a missing list.
    field.value = (settings.rules[path] || []).join("\n");
    field.addEventListener("change", () => {
      // Convert the text back into a clean array when the user leaves the field:
      settings.rules[path] = field.value
        .split("\n")          // one string -> array of lines
        .map((line) => line.trim()) // trim spaces from each line
        .filter(Boolean);     // drop empty lines ("" is falsy, so filtered out)
      scheduleSave();
    });
  }

  /* ---------------------------------------------------------------- *
   * Try-it box                                                        *
   * ---------------------------------------------------------------- */

  /**
   * Score whatever is in the test box and show the breakdown — the same
   * classifier, thresholds, and rules the feed uses, so what this box says
   * is exactly what would happen in the wild.
   */
  async function runTest() {
    // Read the text the user typed into the try-it box.
    const text = $("test-input").value;
    const output = $("test-output");
    // `text.trim()` removes surrounding whitespace; an empty result is falsy, so
    // for a blank box we clear the output and stop early.
    if (!text.trim()) {
      output.textContent = "";
      return;
    }

    // Ask the worker to score the text with the real classifier.
    const reply = await send({ type: "testText", text });
    if (!reply || !reply.scores) return; // bail if no usable answer

    output.innerHTML = ""; // clear previous results before drawing new ones

    // --- Verdict line: would this text be filtered, and how?
    // Lookup table turning an action into its past-tense word for the sentence.
    const PAST_TENSE = { hide: "hidden", blur: "blurred", tag: "labelled" };
    const verdict = document.createElement("p");
    verdict.className = "verdict";
    // Template literal (backticks with `${...}`) builds a string with values
    // slotted in. "off" means no action, so we say it would not be filtered.
    verdict.textContent =
      reply.decision.action === "off"
        ? "Would not be filtered."
        : `Would be ${PAST_TENSE[reply.decision.action]}: ${reply.decision.reason}`;
    output.appendChild(verdict);

    // --- Score bars: one row per category showing how strongly it scored.
    const list = document.createElement("ul");
    list.className = "score-list";
    for (const category of Taxonomy.CATEGORIES) {
      const score = reply.scores[category.id] || 0; // 0..1, default 0
      const item = document.createElement("li");
      const bar = document.createElement("span");
      bar.className = "score-bar";
      // Set the bar's width via inline CSS. Score 0..1 becomes a 0..100%
      // percentage so the bar's length visually represents the score.
      bar.style.width = `${Math.round(score * 100)}%`;
      const label = document.createElement("span");
      label.className = "score-label";
      // `score.toFixed(2)` formats the number to two decimal places.
      label.textContent = `${category.label}: ${score.toFixed(2)}`;
      item.append(bar, label);
      list.appendChild(item);
    }
    output.appendChild(list);

    // --- "Why" list: the individual signals that pushed the score up or down.
    // Only shown when the worker returned any (`.length` is truthy for non-empty
    // arrays).
    if (reply.signals && reply.signals.length) {
      const why = document.createElement("ul");
      why.className = "signal-list";
      for (const signal of reply.signals) {
        const item = document.createElement("li");
        // Positive weight = pushed toward filtering (▲), negative = away (▼).
        item.textContent = `${signal.weight > 0 ? "▲" : "▼"} ${signal.why}`;
        why.appendChild(item);
      }
      output.appendChild(why);
    }
  }

  /* ---------------------------------------------------------------- *
   * Security section                                                  *
   * ---------------------------------------------------------------- */

  /**
   * Wire the security section: the two "key mode" radio buttons (device key vs.
   * passphrase), the passphrase setup form, and the "wipe everything" button.
   * No return value — all effects are on screen / via messages to the worker.
   */
  function renderSecurity() {
    // Radio buttons are mutually exclusive; exactly one is checked. Reflect the
    // saved mode by ticking the matching radio.
    const isPassphrase = settings.security.keyMode === "passphrase";
    $("keymode-device").checked = !isPassphrase;
    $("keymode-passphrase").checked = isPassphrase;
    // The setup form is always hidden on load: in device mode there is nothing
    // to set up yet, and in passphrase mode it is already configured. It only
    // appears when the user actively selects the passphrase radio.
    $("passphrase-setup").classList.add("hidden");

    // Choosing the passphrase radio just reveals the setup form...
    $("keymode-passphrase").addEventListener("change", () => {
      // Do not flip the stored mode yet — it only changes once a passphrase
      // has actually been set, otherwise the user could lock themselves out
      // of their own data with no key to unlock it.
      $("passphrase-setup").classList.remove("hidden");
    });

    // ...and switching back to device key hides it again.
    $("keymode-device").addEventListener("change", () => {
      $("passphrase-setup").classList.add("hidden");
    });

    // The "Enable passphrase" button: validate the two fields, then ask the
    // worker to turn on passphrase protection.
    $("enable-passphrase").addEventListener("click", async () => {
      const error = $("security-error");
      error.textContent = ""; // clear any earlier error

      const passphrase = $("new-passphrase").value;
      const confirm = $("confirm-passphrase").value;

      // Client-side sanity checks with early returns: too short, or the two
      // entries do not match. `return` stops here so we never send a bad value.
      if (passphrase.length < 12) {
        error.textContent = "Use at least 12 characters — this key protects everything valyou stores.";
        return;
      }
      if (passphrase !== confirm) {
        error.textContent = "Those do not match.";
        return;
      }

      const reply = await send({ type: "security.enablePassphrase", passphrase });

      // Clear both fields as soon as the message is sent, so the secret does not
      // linger in the page's inputs.
      $("new-passphrase").value = "";
      $("confirm-passphrase").value = "";

      if (reply && reply.ok) {
        // Success: record the new mode locally, hide the form, and confirm.
        settings.security.keyMode = "passphrase";
        $("passphrase-setup").classList.add("hidden");
        error.textContent = "";
        $("save-state").textContent = "Passphrase enabled";
      } else {
        error.textContent = "Could not enable passphrase protection.";
      }
    });

    // The "Wipe" button deletes everything. `window.confirm(...)` pops up a
    // native OK/Cancel dialog and returns true only if the user clicks OK —
    // a guard against accidental, irreversible deletion.
    $("wipe").addEventListener("click", async () => {
      const ok = window.confirm(
        "Delete all valyou settings and counters? This cannot be undone."
      );
      if (!ok) return; // user cancelled
      await send({ type: "wipe" });
      // Reload the page so it re-reads the now-empty state from scratch.
      window.location.reload();
    });
  }

  /* ---------------------------------------------------------------- *
   * Boot                                                              *
   * ---------------------------------------------------------------- */

  /**
   * Entry point: fetch settings from the worker, store them, then render/wire
   * every section of the page. Runs once when the options page loads (called at
   * the very bottom of the file).
   */
  async function boot() {
    // Diagnostic: capture exactly what the worker returns so a blank page tells
    // us its cause. (Temporary — remove with the diag banner above.)
    let reply;
    try {
      reply = await send({ type: "getSettings" });
    } catch (e) {
      diag("valyou: getSettings threw: " + ((e && e.message) || e));
      return;
    }
    if (!reply) {
      diag(
        "valyou: the service worker sent NO reply to getSettings.\n" +
          "Likely the background service worker is not running in Safari.\n" +
          "Check Develop → Web Extension Background Content → valyou for errors."
      );
      return;
    }
    if (reply.error) {
      diag("valyou: worker replied with an error: " + reply.error);
      return;
    }
    if (reply.locked) {
      diag("valyou: the vault is locked (passphrase mode) — unlock in the popup.");
      return;
    }
    if (!reply.settings) {
      diag("valyou: reply had no .settings. reply keys=" + Object.keys(reply).join(","));
      return;
    }
    settings = reply.settings;

    // Build each section from the loaded settings.
    renderCategories();
    renderSurfaces();
    // Wire the three custom-list textareas to their settings keys.
    bindList("allow-authors", "allowAuthors");
    bindList("block-terms", "blockTerms");
    bindList("allow-terms", "allowTerms");
    renderSecurity();

    // The machine-learning on/off checkbox.
    const mlToggle = $("ml-enabled");
    mlToggle.checked = settings.ml.enabled;
    mlToggle.addEventListener("change", () => {
      settings.ml.enabled = mlToggle.checked;
      scheduleSave();
    });

    renderVideoMode();

    // Debounce the try-it box the same way as saves: wait until the user pauses
    // typing for 200ms before running the test, instead of scoring on every
    // keystroke. `input` fires on each change to the field.
    let testTimer = null;
    $("test-input").addEventListener("input", () => {
      clearTimeout(testTimer);
      testTimer = setTimeout(runTest, 200);
    });
  }

  // Start everything.
  boot();
// The trailing `()` immediately invokes the wrapper function, running all of
// the setup above as soon as the options page's script loads.
})();
