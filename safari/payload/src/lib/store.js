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
 * Encrypted persistence layer over chrome.storage.
 *
 * Every value written through this module is sealed by lib/crypto.js first,
 * so chrome.storage.local on disk contains nothing but AES-GCM envelopes.
 * There is deliberately no general "write this one in the clear" escape
 * hatch: a uniform ciphertext layout means an observer cannot even
 * distinguish the settings record from the secrets record by shape. (The
 * single, narrow exception is getRaw/setRaw for the self-protecting
 * wrapped-key blob — see below.)
 *
 * Two backing areas are used:
 *   local   - survives browser restarts (settings, secrets, stats, install id)
 *   session - memory-backed, cleared when the browser closes; available for
 *             any future ephemeral state
 *
 * Reads are fail-safe rather than fail-open: a record that fails its
 * authentication tag is reported as absent, and the caller falls back to
 * defaults. That prevents a tampered record from being partially trusted.
 *
 * ---------------------------------------------------------------------------
 * BEGINNER ORIENTATION
 *
 * "chrome.storage" is the browser-extension key/value database. Unlike a web
 * page's localStorage, it is asynchronous (every call returns a Promise) and
 * it is shared across all parts of the extension (popup, options page, and the
 * background service worker). We use two of its "areas":
 *   - chrome.storage.local   persists to disk across browser restarts.
 *   - chrome.storage.session lives only in memory and is wiped on browser exit.
 *
 * "Encrypted at rest" means the bytes actually saved on disk are ciphertext.
 * This file never hands plaintext to chrome.storage; it always runs the value
 * through lib/crypto.js (AES-GCM) first. An "envelope" below is that sealed
 * ciphertext bundle (nonce + tag + ciphertext).
 *
 * A note on async/await used throughout: an `async` function always returns a
 * Promise, and `await somedPromise` pauses this function until that Promise
 * resolves, yielding the resolved value. It lets asynchronous storage calls be
 * written in a straight, top-to-bottom style.
 */

// --- Module wrapper (UMD / IIFE pattern) ------------------------------------
// The whole file is one function that is called immediately -- an IIFE
// (Immediately Invoked Function Expression). This keeps helper variables
// private instead of leaking them into the global namespace.
//
// It is also a UMD (Universal Module Definition) wrapper: the same file works
// whether it is loaded as a plain <script> in the browser (where it attaches
// to the global VALYOU.Store) or `require()`d in Node during tests (where it
// sets module.exports). `root` is the global object; `factory` is the second
// function argument that actually builds and returns the module.
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Store = mod;
  // In Node/test environments `module.exports` exists; in the browser it does
  // not, so this line is simply skipped there.
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // Opt into strict mode: turns silent mistakes (e.g. assigning an undeclared
  // variable) into thrown errors, which catches bugs earlier.
  "use strict";

  // `scope` is the global object. In a service worker there is no `window`, so
  // `self` is used; `globalThis` is the portable fallback for Node tests.
  const scope = typeof self !== "undefined" ? self : globalThis;
  // Grab the crypto module. In the browser it was already attached to the
  // global VALYOU object by an earlier script; in Node tests we `require` it.
  const Crypto = (scope.VALYOU && scope.VALYOU.Crypto)
    || (typeof require === "function" ? require("./crypto.js") : null);

  /** Injectable chrome.storage shim so tests can run without a browser. */
  // When null, the real chrome.storage is used (see `area` below). Tests call
  // configure() to swap in a fake in-memory implementation instead.
  let areas = null;

  /**
   * Point the store at a storage implementation. Called by tests; in the
   * extension the default resolves to the real chrome.storage areas.
   *
   * @param {{local: object, session: object}} impl Storage areas exposing
   *   promise-returning get/set/remove, matching the MV3 chrome.storage API.
   */
  function configure(impl) {
    areas = impl;
  }

  /** Resolve the active storage areas, defaulting to chrome.storage. */
  // `name` is "local" or "session". If a test shim was injected, use it;
  // otherwise reach for the real browser API, e.g. chrome.storage.local.
  function area(name) {
    if (areas) return areas[name];
    return chrome.storage[name];
  }

  /**
   * Read and decrypt a record.
   *
   * @param {string} recordId Logical record name, doubles as the AAD binding.
   * @param {*} [fallback=null] Returned when absent or unreadable.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<*>} Decrypted value, or `fallback`.
   */
  // WHY: callers should never touch chrome.storage or crypto directly. This is
  // the single read path that guarantees whatever comes back is either the
  // real decrypted value or a safe fallback -- never raw ciphertext.
  async function get(recordId, fallback = null, where = "local") {
    // chrome.storage.get returns an OBJECT keyed by the names requested, e.g.
    // { "settings": <envelope> } -- not the value directly. So we index into it.
    const raw = await area(where).get(recordId);
    const envelope = raw ? raw[recordId] : null;
    // Nothing stored under this key yet -> hand back the caller's default.
    if (!envelope) return fallback;

    try {
      // Decrypt and JSON-parse in one step. `recordId` is passed again as the
      // AAD (Additional Authenticated Data): decryption fails if the record was
      // moved or relabeled, binding each envelope to its own key name.
      return await Crypto.decryptJSON(recordId, envelope);
    } catch (err) {
      // A locked vault is a real error the caller must handle; a corrupt or
      // tampered record is treated as "not present" so the extension keeps
      // working with defaults instead of bricking.
      if (err && err.code === "LOCKED") throw err;
      return fallback;
    }
  }

  /**
   * Encrypt and write a record.
   *
   * @param {string} recordId Logical record name.
   * @param {*} value Any JSON-serializable value.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<void>}
   */
  // WHY: the mirror of get() -- the single write path that guarantees plaintext
  // is sealed before it ever reaches disk.
  async function set(recordId, value, where = "local") {
    // Serialize + encrypt. The result is an opaque envelope, never plaintext.
    const envelope = await Crypto.encryptJSON(recordId, value);
    // `{ [recordId]: envelope }` is a "computed property name": the object key
    // is the runtime value of recordId (e.g. "settings"), not the literal text
    // "recordId". chrome.storage.set takes an object of key/value pairs to save.
    await area(where).set({ [recordId]: envelope });
  }

  /**
   * Delete a record outright.
   *
   * @param {string} recordId Logical record name.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<void>}
   */
  // Deletes the whole record for this key. There is no plaintext involved, so
  // no crypto step is needed here.
  async function remove(recordId, where = "local") {
    await area(where).remove(recordId);
  }

  /**
   * Read-modify-write a record under a single logical operation.
   *
   * Note this is not atomic across concurrent callers — chrome.storage offers
   * no compare-and-swap. All writes in valyou originate from the single
   * service worker, so serialization comes from the JS event loop; the helper
   * exists to keep call sites short, not to provide transactional guarantees.
   *
   * @param {string} recordId Logical record name.
   * @param {*} fallback Value to start from when the record is absent.
   * @param {function(*): *} mutate Receives the current value, returns the new one.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<*>} The newly written value.
   */
  // A convenience "read-modify-write" helper: fetch the current value, run the
  // caller's `mutate` function on it to compute the new value, then store that.
  // WHY it exists: it saves every call site from repeating the get/set dance.
  async function update(recordId, fallback, mutate, where = "local") {
    const current = await get(recordId, fallback, where);
    // `mutate` is a callback the caller supplies; it turns the old value into
    // the new one (e.g. current => ({ ...current, count: current.count + 1 })).
    const next = mutate(current);
    await set(recordId, next, where);
    return next;
  }

  /**
   * Read a record WITHOUT decrypting it.
   *
   * This exists for exactly one record: the passphrase-wrapped data key. That
   * blob cannot go through the normal path, because reading it would require
   * the very key it contains — a chicken-and-egg deadlock that would make a
   * passphrase vault permanently unopenable.
   *
   * It is safe precisely because the blob is already self-protecting: it is
   * AES-KW ciphertext under a PBKDF2-derived key, and the salt and iteration
   * count beside it are not secrets.
   *
   * Do not use this for anything else.
   *
   * @param {string} recordId Logical record name.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<*>} The stored value, or null.
   */
  // Note the deliberate absence of any Crypto call: this returns the stored
  // bytes exactly as-is. Only the self-protecting wrapped-key blob is allowed
  // to use this path (see the JSDoc above for the chicken-and-egg reason).
  async function getRaw(recordId, where = "local") {
    const raw = await area(where).get(recordId);
    return raw && raw[recordId] !== undefined ? raw[recordId] : null;
  }

  /**
   * Write a record WITHOUT encrypting it. See getRaw for why this exists and
   * why it must not be used for anything but the wrapped-key blob.
   *
   * @param {string} recordId Logical record name.
   * @param {*} value Self-protecting value to store.
   * @param {"local"|"session"} [where="local"] Backing storage area.
   * @returns {Promise<void>}
   */
  // The write counterpart to getRaw: stores `value` verbatim, with no crypto.
  async function setRaw(recordId, value, where = "local") {
    await area(where).set({ [recordId]: value });
  }

  /**
   * Erase every valyou record from both storage areas. Used by the "delete
   * all my data" control in options. The encryption key itself is removed
   * separately by the caller, which makes any leftover on-disk fragments
   * cryptographically unrecoverable.
   *
   * @returns {Promise<void>}
   */
  async function wipe() {
    // clear() empties an entire storage area at once.
    await area("local").clear();
    // The session area may not exist in every environment (e.g. some test
    // shims), so guard before calling clear() to avoid a crash.
    if (area("session") && area("session").clear) await area("session").clear();
  }

  // The module's public surface: only these helpers are exposed to the rest of
  // the extension. Everything else above (area, scope, areas) stays private.
  return { configure, get, set, remove, update, wipe, getRaw, setRaw };
});
