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
 * Service worker: the extension's trusted core.
 *
 * Everything sensitive lives here and nowhere else: the encryption key handle
 * and every encrypted record. Content scripts share an origin with Facebook
 * and Instagram, so they are treated as untrusted callers — they may ask for
 * settings and report counters, and every message they send is validated
 * before use.
 *
 * This worker makes NO network requests. Classification happens entirely in
 * the content scripts; the manifest grants no host permission beyond the two
 * social sites, and the extension-pages CSP pins connect-src to 'none'. That
 * is a product guarantee, not an accident — valyou must never depend on any
 * external service.
 *
 * MV3 workers are killed aggressively when idle and restarted on demand, so
 * all state here is either derived on demand or restored from encrypted
 * storage in ensureReady().
 *
 * BEGINNER ORIENTATION — WHAT A SERVICE WORKER IS
 *   In a Manifest V3 extension the "service worker" is the background brain.
 *   Unlike the content script (src/content/main.js) it is NOT attached to any
 *   web page: it has no DOM, no window. It exists to hold shared state and
 *   respond to messages. Chrome starts it when it is needed (a message arrives,
 *   the extension installs, the browser starts) and STOPS it again once idle to
 *   save memory. Because it can be torn down at any moment, it must never keep
 *   important data only in memory — every restart re-derives its state via
 *   ensureReady(). The `state` object below is just a warm cache on top of the
 *   real source of truth, which is encrypted browser storage.
 *
 *   How the pieces talk: content scripts / popup / options page send messages
 *   with chrome.runtime.sendMessage; this worker receives them through the
 *   chrome.runtime.onMessage listener at the bottom of the file and replies.
 */

/* Shared libraries. importScripts requires a classic (non-module) worker,
 * which is why the manifest omits "type": "module" — it lets the exact same
 * files be loaded by the content script and by the Node test runner.
 *
 * importScripts() is the classic-worker way to load other scripts
 * synchronously: it runs each file in order, top to bottom, in THIS worker's
 * global scope, before any code after this call executes. Each library file
 * attaches its exports onto the shared self.VALYOU object (see the
 * destructuring on the next line), which is how the pieces below become
 * available. Order matters: a file may depend on ones listed before it. */
// CROSS-BROWSER: On Chrome this file runs as a service worker, where
// importScripts() loads the dependencies here. On Safari — which does not run
// MV3 service workers reliably — the manifest instead lists this same file plus
// its dependencies in `background.scripts`, so they load as <script> tags in a
// non-persistent background PAGE *before* this file runs. In that page context
// importScripts does not exist and the modules are already present. So only call
// importScripts when we are actually in a worker AND the modules aren't loaded.
if (typeof importScripts === "function" && !(self.VALYOU && self.VALYOU.Scorer)) {
  importScripts(
    "/src/lib/text.js",
    "/src/lib/taxonomy.js",
    "/src/lib/crypto.js",
    "/src/lib/store.js",
    "/src/lib/lexicon.js",
    "/src/lib/ml.js",
    "/src/model/model-data.js",
    "/src/lib/scorer.js",
    "/src/lib/settings.js"
  );
}

// Pull the loaded library namespaces off the shared global. `self` is the
// worker's global object (there is no `window` in a worker).
const { Taxonomy, Crypto, Store, Settings, Scorer, ML, ModelData } = self.VALYOU;

/**
 * Load or unload the ML assist so the worker's "Try it" scoring matches what
 * a feed would do. Same load-time gating as the content script.
 *
 * @param {object} settings Current settings.
 */
function syncModel(settings) {
  if (!ML) return; // no ML module in this build
  const want = settings && settings.ml && settings.ml.enabled;
  // Load the model when wanted and absent; unload it when no longer wanted.
  if (want && ModelData && !ML.ready()) ML.load(ModelData);
  else if (!want && ML.ready()) ML.load(null);
}

/** Cached hot state, rebuilt after every worker restart. Because MV3 can kill
 *  the worker at any time, treat this as a cache, not durable storage. */
const state = {
  ready: null, // in-flight or resolved boot promise (see ensureReady memoization)
  settings: null, // sanitized settings, once loaded/decrypted
  install: null, // install metadata (first-seen time, etc.)
};

/**
 * Boot the worker: determine the key mode, then restore settings and install
 * metadata.
 *
 * The key mode is derived from whether a wrapped-key blob exists, NOT from the
 * `security.keyMode` setting. That ordering is load-bearing: the setting lives
 * inside an encrypted record, so consulting it first would require the key we
 * are still trying to determine how to obtain. The blob's presence is the only
 * signal readable before any key exists.
 *
 * Memoized on `state.ready` so concurrent messages arriving during startup
 * share one initialization rather than racing to create separate keys.
 *
 * @returns {Promise<void>}
 */
function ensureReady() {
  // Memoization: if a boot promise already exists (in flight or resolved),
  // return the SAME promise so concurrent callers await one shared boot rather
  // than each starting their own. Cleared to null on wipe to force a re-boot.
  if (state.ready) return state.ready;

  // Assign the promise BEFORE awaiting anything inside it, so a second call
  // during startup sees the in-flight promise on the line above.
  state.ready = (async () => {
    // getRaw reads storage without decrypting. The mere presence of a wrapped
    // key blob tells us the user enabled passphrase mode — the only key-mode
    // signal we can read before we have a key.
    const wrapped = await Store.getRaw(Taxonomy.RECORDS.WRAPPED_KEY);
    Crypto.configure({ mode: wrapped ? "passphrase" : "device" });

    // In passphrase mode nothing can be decrypted until the user unlocks, so
    // run on defaults until then rather than throwing on every message.
    if (!Crypto.status().unlocked) {
      state.settings = Settings.sanitize(null); // sanitize(null) => safe defaults
      syncModel(state.settings);
      return;
    }

    // Device mode (or already unlocked): decrypt the real settings.
    state.settings = await Settings.load();
    state.install = await Settings.getInstall();
    syncModel(state.settings);
  })().catch((err) => {
    // Never let a boot failure leave the worker with no settings — fall back to
    // defaults so message handling still works.
    console.error("[valyou] startup failed", err);
    state.settings = Settings.sanitize(null);
  });

  return state.ready;
}

/* ------------------------------------------------------------------ *
 * Statistics                                                          *
 * ------------------------------------------------------------------ */

/**
 * Increment the encrypted stats record.
 *
 * Only counters are stored — never text, authors, or URLs. The point is to
 * let a user see "valyou hid 41 things today", not to build a history of
 * what they read.
 *
 * @param {{event: string, category?: string, action?: string, kind?: string}} event
 * @returns {Promise<void>}
 */
async function recordStat(event) {
  // "YYYY-MM-DD" for today (UTC). toISOString() is like
  // "2026-08-05T12:00:00.000Z"; slice(0, 10) keeps just the date part.
  const today = new Date().toISOString().slice(0, 10);

  // Store.update reads the record, runs our updater to produce the new value,
  // and writes it back atomically. Arg 2 is the default used when no record
  // exists yet. Arg 3 is the updater callback.
  await Store.update(
    Taxonomy.RECORDS.STATS,
    { day: today, total: 0, byCategory: {}, byAction: {}, revealed: 0, allTime: 0 },
    (stats) => {
      // Roll over at midnight; only today's detail is retained.
      if (stats.day !== today) {
        stats = { day: today, total: 0, byCategory: {}, byAction: {}, revealed: 0, allTime: stats.allTime || 0 };
      }
      if (event.event === "filtered") {
        stats.total += 1;
        stats.allTime += 1;
        // Defense in depth: only ever use a KNOWN category/action as an object
        // key. The sender is our own (first-party) content script, but if it
        // were ever compromised this stops arbitrary or `__proto__`-style keys
        // from being written into the stored stats object.
        if (Taxonomy.CATEGORY_IDS.includes(event.category)) {
          stats.byCategory[event.category] = (stats.byCategory[event.category] || 0) + 1;
        }
        if (Taxonomy.ACTIONS.includes(event.action)) {
          stats.byAction[event.action] = (stats.byAction[event.action] || 0) + 1;
        }
      } else if (event.event === "revealed") {
        stats.revealed += 1;
      }
      return stats; // the returned object becomes the new stored record
    }
  ).catch(() => {}); // stats are best-effort; never break filtering over them

  // Only repaint the toolbar badge when the user opted into it and something
  // was actually filtered (a "revealed" event should not bump the count).
  if (state.settings && state.settings.showBadge && event.event === "filtered") {
    await refreshBadge();
  }
}

/**
 * Paint today's filtered count onto the toolbar icon.
 *
 * @returns {Promise<void>}
 */
async function refreshBadge() {
  try {
    const stats = await Store.get(Taxonomy.RECORDS.STATS, null);
    const count = stats && stats.total ? stats.total : 0;
    // chrome.action is the toolbar button API. setBadgeText draws a small label
    // over the icon; empty string clears it. We cap the number at 999 and show
    // nothing when the count is 0.
    await chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 999)) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#5b8def" });
  } catch {
    /* action API unavailable during teardown; ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Message routing                                                     *
 * ------------------------------------------------------------------ */

/**
 * Handle one message from a content script, the popup, or the options page.
 *
 * Kept as a separate async function because chrome.runtime.onMessage cannot
 * take an async listener directly — it must return `true` synchronously to
 * keep the response channel open.
 *
 * @param {object} message Incoming message.
 * @param {object} sender Chrome sender metadata.
 * @returns {Promise<object>} Response payload.
 */
async function handleMessage(message, sender) {
  await ensureReady(); // make sure settings/crypto are booted before we answer

  // Every message carries a string `type`; we branch on it. Each case returns
  // the object that becomes the caller's reply.
  switch (message.type) {
    case "getSettings":
      // The content script calls this on load. `locked` tells callers whether
      // passphrase mode is engaged but not yet unlocked.
      return { settings: state.settings, locked: !Crypto.status().unlocked };

    case "saveSettings": {
      // Persist, cache, sync the model, then push the change to open tabs.
      const saved = await Settings.save(message.settings);
      state.settings = saved;
      syncModel(saved);
      await broadcastSettings(saved); // live-update any open feeds
      return { settings: saved };
    }

    case "stats":
      await recordStat(message); // increment the encrypted counters
      return { ok: true };

    case "getStats": {
      // Read-only fetch for the popup's "hidden today" display; return zeros
      // when no record exists yet.
      const stats = await Store.get(Taxonomy.RECORDS.STATS, null);
      return { stats: stats || { day: null, total: 0, byCategory: {}, byAction: {}, revealed: 0, allTime: 0 } };
    }

    case "testText": {
      // Powers the "try it" box in options, so a user can see exactly how a
      // phrase scores before changing thresholds.
      const local = Scorer.scoreText(String(message.text || ""), state.settings.rules);
      const decision = Scorer.decide(local.scores, state.settings, { signals: local.signals });
      return { scores: local.scores, signals: local.signals, decision };
    }

    case "security.status":
      return { status: Crypto.status() }; // mode + locked/unlocked, for the UI

    case "security.enablePassphrase": {
      // Refuse if already in passphrase mode — re-minting would strand data.
      if (Crypto.status().mode === "passphrase") {
        return { ok: false, error: "already_enabled" };
      }

      // Turning on passphrase mode mints a BRAND NEW data key. Everything
      // already on disk is encrypted under the old one, so it has to be read
      // out first and written back afterwards — otherwise enabling this
      // feature would silently destroy the user's settings.
      // Read every record out under the CURRENT key so we can re-encrypt it
      // under the new one below. `carried` maps record id -> decrypted value.
      const carried = {};
      for (const id of [
        Taxonomy.RECORDS.SETTINGS,
        Taxonomy.RECORDS.SECRETS,
        Taxonomy.RECORDS.STATS,
        Taxonomy.RECORDS.INSTALL,
      ]) {
        carried[id] = await Store.get(id, null);
      }

      const blob = await Crypto.createWrappedKey(
        message.passphrase,
        state.settings.security.kdfIterations
      );

      // Written unencrypted on purpose: the blob is AES-KW ciphertext under
      // the passphrase-derived key, and encrypting it with the key it holds
      // would make the vault impossible to open. See Store.setRaw.
      await Store.setRaw(Taxonomy.RECORDS.WRAPPED_KEY, blob);

      // Re-seal every carried record under the new key. Object.entries turns
      // the map into [id, value] pairs; skip records that did not exist (null).
      for (const [id, value] of Object.entries(carried)) {
        if (value !== null) await Store.set(id, value);
      }

      state.settings = await Settings.save(
        Object.assign({}, carried[Taxonomy.RECORDS.SETTINGS] || state.settings, {
          security: Object.assign({}, state.settings.security, { keyMode: "passphrase" }),
        })
      );

      // Finally remove the old unprotected key. Doing this last means a crash
      // partway through leaves the original key still able to read everything.
      await Crypto.destroyDeviceKey();

      return { ok: true };
    }

    case "security.unlock": {
      // Fetch the wrapped-key blob and try to unwrap it with the passphrase.
      const blob = await Store.getRaw(Taxonomy.RECORDS.WRAPPED_KEY);
      if (!blob) return { ok: false, error: "no_vault" }; // nothing to unlock
      try {
        await Crypto.unlock(message.passphrase, blob); // throws on wrong passphrase
        // ensureReady() ran while the vault was still locked, so state.settings
        // currently holds defaults. Loading here is what makes the user's saved
        // configuration take effect — without it, passphrase mode would run on
        // defaults forever and the next save would overwrite the real settings.
        state.settings = await Settings.load();
        state.install = await Settings.getInstall();
        syncModel(state.settings);
        return { ok: true, settings: state.settings };
      } catch (err) {
        // err.code distinguishes e.g. wrong passphrase from a corrupt blob.
        return { ok: false, error: err.code || "unlock_failed" };
      }
    }

    case "security.lock":
      Crypto.lock(); // drop the in-memory key; records become unreadable again
      return { ok: true };

    case "wipe": {
      // Order matters: destroy the key last so any storage fragments the
      // browser leaves behind after clear() are permanently undecryptable.
      await Store.wipe();
      await Crypto.destroyDeviceKey();
      Crypto.lock();
      Crypto.configure({ mode: "device" });
      state.settings = Settings.sanitize(null);
      state.install = null;
      state.ready = null; // force ensureReady() to re-boot from a clean slate
      return { ok: true };
    }

    default:
      // Unrecognized type — reply with an error instead of hanging the caller.
      return { error: "unknown_message" };
  }
}

/**
 * Push updated settings to every open feed tab so filters re-apply without a
 * reload.
 *
 * @param {object} settings Sanitized settings.
 * @returns {Promise<void>}
 */
async function broadcastSettings(settings) {
  // Cross-browser tabs API. Like storage and sendMessage, `chrome.tabs.query`
  // returns a Promise on Chrome (MV3) but not on Safari, whose promise-based
  // equivalent is `browser.tabs`. Prefer `browser.tabs` where present so the
  // awaited query and the per-tab `.catch(...)` below both work in Safari.
  const tabsApi = (typeof browser !== "undefined" && browser.tabs) ? browser.tabs : chrome.tabs;
  // tabsApi.query finds open tabs whose URL matches these patterns (the
  // only sites valyou runs on). `*` are wildcards.
  const tabs = await tabsApi.query({
    url: [
      "https://*.facebook.com/*",
      "https://*.instagram.com/*",
      "https://*.messenger.com/*",
      "https://*.x.com/*",
      "https://*.twitter.com/*",
    ],
  });
  // Send each matching tab's content script a "settingsChanged" message. Note
  // chrome.tabs.sendMessage targets a specific TAB (worker -> content script),
  // whereas chrome.runtime.sendMessage goes the other direction. Promise.all
  // fires them in parallel; each .catch ignores tabs without a live listener.
  await Promise.all(
    tabs.map((tab) =>
      Promise.resolve(tabsApi.sendMessage(tab.id, { type: "settingsChanged", settings })).catch(() => {})
    )
  );
}

// The single entry point for all incoming messages. onMessage runs this
// listener for every chrome.runtime.sendMessage / chrome.tabs.sendMessage aimed
// at the extension. `sendResponse` is the reply callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject malformed messages up front. Returning false closes the channel
  // immediately (we will not reply).
  if (!message || typeof message.type !== "string") return false;
  // handleMessage is async, but a listener cannot BE async: Chrome needs a
  // synchronous return value telling it whether a reply is coming. So we start
  // the async work, wire its result to sendResponse, and...
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String((err && err.code) || err) }));
  return true; // ...return true to tell Chrome "keep the channel open for the async reply"
});

// Fired once when the extension is installed or updated. Good moment to boot
// state and paint the badge.
chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureReady();
  await refreshBadge();
  if (details.reason === "install") {
    // Land the user on options so they can review defaults before browsing.
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

// Fired when the browser starts (and thus wakes this worker). Warm the state
// and badge so the first feed load has settings ready.
chrome.runtime.onStartup.addListener(() => {
  ensureReady().then(refreshBadge);
});
