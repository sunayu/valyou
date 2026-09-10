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
 * Encryption at rest for every byte valyou persists.
 *
 * THREAT MODEL
 * ------------
 * What this defends against: anyone who can read the extension's storage
 * files on disk (another local account, a stolen laptop, a backup, a
 * forensic image, malware without code execution inside this extension).
 * chrome.storage.local is an unencrypted LevelDB on disk by default, so an
 * API key or a browsing-derived cache written there in plaintext is readable
 * by anything that can open the file.
 *
 * What this cannot defend against: code running inside this extension's own
 * origin. If an attacker executes JavaScript in our service worker they can
 * simply ask us to decrypt. Non-extractable keys still help — they cannot
 * exfiltrate the key itself, only use it while they have execution — but
 * treat that as damage limitation, not prevention.
 *
 * DESIGN
 * ------
 * AES-256-GCM for every record. GCM is an AEAD: it authenticates as well as
 * encrypts, so a tampered record fails to decrypt rather than silently
 * yielding attacker-chosen settings. It is also hardware-accelerated (AES-NI)
 * on every machine Chrome runs on, so a record costs microseconds — the
 * encryption is nowhere near the hot path for feed classification.
 *
 * Each record is sealed with:
 *   - a fresh 96-bit random IV (never reused; 96 bits is the GCM-native size,
 *     which avoids the extra GHASH step required for other lengths), and
 *   - additional authenticated data (AAD) binding the ciphertext to its
 *     record name and format version. AAD is what stops a "record swap"
 *     attack: an attacker cannot copy the (validly encrypted) `settings`
 *     blob over the `secrets` blob, because decryption of `secrets` supplies
 *     different AAD and the tag check fails.
 *
 * KEY MANAGEMENT — two modes
 * --------------------------
 * "device" (default): the data key is generated as a NON-EXTRACTABLE
 *   CryptoKey and stored in IndexedDB via structured clone. Chrome keeps the
 *   key material inside the crypto implementation; JavaScript — ours or an
 *   attacker's — can never read the raw bytes back out, only pass the handle
 *   to subtle.encrypt/decrypt. No user interaction is required, so background
 *   classification works from browser start.
 *
 * "passphrase" (opt-in): the data key is wrapped with AES-KW under a key
 *   derived from a user passphrase (PBKDF2-HMAC-SHA-256, 600k iterations,
 *   128-bit random salt — meeting OWASP's 2023 guidance). Only the wrapped
 *   blob is persisted; nothing usable exists on disk until the user unlocks.
 *   The unwrapped key is imported non-extractable and held in memory only.
 *   This is strictly stronger at rest, at the cost of an unlock per browser
 *   session. Trade-off is documented in the options UI.
 */

/*
 * ---------------------------------------------------------------------------
 * BEGINNER PRIMER — the concepts and APIs this file uses, in plain language
 * ---------------------------------------------------------------------------
 * ENCRYPTION AT REST means: before we save anything to disk we scramble it so
 * that only someone with the right key can read it back. "At rest" = while it
 * sits in storage (as opposed to "in transit" over the network).
 *
 * AES-256-GCM is the specific encryption algorithm.
 *   - AES is a standard, fast, trusted cipher; 256 is the key size in bits.
 *   - GCM is a *mode* that does two jobs at once: it encrypts the data AND
 *     produces an authentication *tag* that proves the data was not altered.
 *     Algorithms that do both are called AEAD. If even one bit of the stored
 *     ciphertext (or its metadata) is changed, decryption FAILS loudly instead
 *     of quietly handing back wrong data. That failure is a feature.
 *
 * IV (initialization vector) is a small random value fed in alongside the key
 *   each time we encrypt. It makes the output different every time even when
 *   the plaintext is identical. The critical rule for GCM: NEVER reuse the same
 *   IV with the same key — doing so breaks the security — so we generate a
 *   fresh random IV for every single record.
 *
 * AAD (additional authenticated data) is extra context that is NOT encrypted
 *   but IS covered by the authentication tag. We put the record's name and
 *   format version in the AAD. Result: a ciphertext will only decrypt when you
 *   supply the exact same context, so an attacker cannot take a valid encrypted
 *   "settings" blob and pass it off as the "secrets" blob — the tags won't match.
 *
 * KEY WRAPPING / ENVELOPE ENCRYPTION: instead of encrypting data directly with
 *   a password, we use two keys. A random "data key" encrypts the actual
 *   records. In passphrase mode, that data key is itself encrypted ("wrapped")
 *   by a second key. Only the wrapped data key is stored. To read anything you
 *   first unwrap the data key. This is the "envelope" — a key sealed inside
 *   another key.
 *
 * PBKDF2 turns a human passphrase into a cryptographic key. Passphrases are
 *   low-entropy and guessable, so PBKDF2 deliberately runs a hash MANY times
 *   (here 600,000 "iterations"). That makes each guess slow, so brute-forcing
 *   a stolen wrapped key becomes impractical. A random per-vault "salt" ensures
 *   two users with the same passphrase get different keys.
 *
 * NON-EXTRACTABLE KEYS: the Web Crypto API can hold a key as an opaque handle
 *   (a CryptoKey object) whose raw bytes JavaScript can never read back. We can
 *   ask it to encrypt/decrypt with the key, but we cannot copy the key out.
 *   Even hostile code running in our extension cannot steal the key material.
 *
 * ASYNC / AWAIT / PROMISES: crypto operations are asynchronous — they return a
 *   *Promise*, a placeholder for a value that will be ready later. An `async`
 *   function is one that can pause on `await`, which waits for a Promise to
 *   resolve and yields its value, without freezing the browser. So
 *   `const key = await getDataKey()` means "wait for the key, then continue".
 *
 * BYTES: `Uint8Array` is an array of raw bytes (0..255); `ArrayBuffer` is the
 *   underlying block of memory. `TextEncoder` converts a string to bytes (UTF-8)
 *   and `TextDecoder` converts bytes back to a string. Web Crypto works in
 *   bytes, so we encode before encrypting and decode after decrypting.
 *
 * `crypto.subtle.*` is the browser's built-in Web Crypto engine — the real
 *   implementation of all of the above. `crypto.getRandomValues(...)` fills a
 *   byte array with cryptographically strong random numbers (used for IVs and
 *   salts, where predictability would be fatal).
 * ---------------------------------------------------------------------------
 */

/*
 * MODULE WRAPPER (the "UMD" pattern): the same file works in the browser
 * extension (publishing itself as `VALYOU.Crypto`) and in Node.js for the tests
 * (publishing via `module.exports`). `factory()` builds the module once.
 */
(function (root, factory) {
  const mod = factory();
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Crypto = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // Stricter JS error checking (see the same note in ml.js).
  "use strict";

  // Shared text helpers (base64 encode/decode). Prefer the browser global,
  // fall back to Node's require for the test environment.
  const Text = (typeof self !== "undefined" && self.VALYOU && self.VALYOU.Text)
    || (typeof require === "function" ? require("./text.js") : null);

  /** Envelope format version. Bumping this invalidates old records by design. */
  const ENVELOPE_VERSION = 1;

  /** GCM's native IV size. Using 12 bytes avoids the GHASH-derived IV path. */
  const IV_BYTES = 12;

  /** PBKDF2 salt size for passphrase mode. */
  const SALT_BYTES = 16;

  /** IndexedDB database and store names for the "device" key mode. */
  const DB_NAME = "valyou-keystore";
  const DB_STORE = "keys";
  const DB_KEY = "data-key-v1";

  /**
   * Module state. `dataKey` is the live CryptoKey handle; in passphrase mode
   * it is null until unlock() succeeds and is cleared by lock().
   */
  const state = {
    dataKey: null,
    keyStore: null, // injected persistence layer; defaults to IndexedDB
    mode: "device",
  };

  /* ------------------------------------------------------------------ *
   * Key store abstraction                                              *
   * ------------------------------------------------------------------ */

  /**
   * The default key store, backed by IndexedDB. CryptoKey objects are
   * structured-cloneable, so a non-extractable key can round-trip through
   * IndexedDB without its material ever being exposed to JavaScript.
   *
   * The tests swap this for an in-memory implementation, which is why the
   * store is an injectable object rather than direct IDB calls.
   *
   * @returns {{get: function(string): Promise<*>, put: function(string, *): Promise<void>, remove: function(string): Promise<void>}}
   */
  function indexedDbKeyStore() {
    /** Open (and if needed create) the key database. */
    function open() {
      // IndexedDB is event-based (onsuccess/onerror callbacks), which is older
      // and clunkier than Promises. We wrap it in a Promise so the rest of the
      // file can use clean `await`. `resolve` hands back the value on success;
      // `reject` reports an error. (A Promise is the "value that arrives later"
      // from the primer.)
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        // Fires only when the DB is first created or its version changes — the
        // one chance to create our object store (a table-like key/value bucket).
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    /** Run one transaction against the key store and resolve its result. */
    function transact(mode, run) {
      // `.then(cb)` runs cb once the previous Promise resolves — here, once the
      // database is open. `run` is the caller's operation (get/put/delete). We
      // wait for the whole transaction to finish (oncomplete) before resolving,
      // and always close the db to release it. `mode` is "readonly" or
      // "readwrite" — read-only transactions can run concurrently and safely.
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, mode);
            const req = run(tx.objectStore(DB_STORE));
            tx.oncomplete = () => {
              db.close();
              resolve(req ? req.result : undefined);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          })
      );
    }

    // The three-method interface the rest of the module depends on. put/remove
    // deliberately resolve to `undefined` (they are side effects, not lookups).
    return {
      get: (name) => transact("readonly", (store) => store.get(name)),
      put: (name, value) =>
        transact("readwrite", (store) => store.put(value, name)).then(() => undefined),
      remove: (name) =>
        transact("readwrite", (store) => store.delete(name)).then(() => undefined),
    };
  }

  /**
   * Override the key store (tests inject an in-memory implementation) and/or
   * the key mode. Calling this resets any cached key handle so the next
   * operation re-reads from the new store.
   *
   * @param {{keyStore?: object, mode?: "device"|"passphrase"}} options
   */
  function configure(options) {
    if (options && options.keyStore) state.keyStore = options.keyStore;
    if (options && options.mode) state.mode = options.mode;
    state.dataKey = null;
  }

  /** Lazily resolve the active key store. */
  function store() {
    if (!state.keyStore) state.keyStore = indexedDbKeyStore();
    return state.keyStore;
  }

  /* ------------------------------------------------------------------ *
   * Key lifecycle                                                       *
   * ------------------------------------------------------------------ */

  /**
   * Return the AES-GCM data key, creating and persisting one on first use.
   * Only valid in "device" mode; in passphrase mode the key must arrive via
   * unlock() and this throws if the vault is still locked.
   *
   * @returns {Promise<CryptoKey>} Non-extractable AES-256-GCM key.
   * @throws {Error} LOCKED when passphrase mode is active but not unlocked.
   */
  async function getDataKey() {
    // Fast path: reuse the key handle we already have in memory.
    if (state.dataKey) return state.dataKey;

    // In passphrase mode the key only exists after unlock(); refuse until then.
    if (state.mode === "passphrase") {
      const err = new Error("valyou vault is locked");
      err.code = "LOCKED";
      throw err;
    }

    // Device mode: try to load the previously generated key from IndexedDB.
    // Because CryptoKey objects are structured-cloneable, the non-extractable
    // key round-trips through storage without its raw bytes ever being exposed.
    const existing = await store().get(DB_KEY);
    if (existing) {
      state.dataKey = existing;
      return existing;
    }

    // First run: generate a brand-new AES-256-GCM key. The three arguments to
    // generateKey are (algorithm, extractable, usages):
    //   - extractable=false: the raw bytes can never be read back by any script.
    //   - ["encrypt","decrypt"]: the only operations this key is allowed to do.
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    // Persist it so the same key is reused on the next browser start, then cache.
    await store().put(DB_KEY, key);
    state.dataKey = key;
    return key;
  }

  /**
   * Derive a key-encryption key (KEK) from a passphrase.
   *
   * PBKDF2-HMAC-SHA-256 with a high iteration count is the strongest option
   * available in the WebCrypto standard set (Argon2id is not exposed to the
   * platform). 600,000 iterations matches OWASP's current recommendation for
   * PBKDF2-SHA-256 and costs roughly a quarter second — acceptable for a
   * once-per-session unlock, prohibitive for offline guessing at scale.
   *
   * @param {string} passphrase User passphrase.
   * @param {Uint8Array} salt 128-bit random salt, stored alongside the blob.
   * @param {number} iterations PBKDF2 iteration count.
   * @returns {Promise<CryptoKey>} AES-KW key usable only for wrap/unwrap.
   */
  async function deriveKek(passphrase, salt, iterations) {
    // Step 1: turn the passphrase text into bytes and import it as raw "key
    // material" that PBKDF2 is allowed to stretch (usage: "deriveKey"). This is
    // not yet a usable encryption key — just the seed PBKDF2 works from.
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    // Step 2: run PBKDF2 (salt + many iterations + SHA-256) to derive the actual
    // key-encryption key (KEK). It is an AES-KW key restricted to wrap/unwrap
    // only, and non-extractable (the `false`) so it can never be exported.
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      material,
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"]
    );
  }

  /**
   * Create a fresh data key, wrap it under a passphrase, and return the blob
   * to persist. Nothing usable by an attacker is produced: the returned value
   * is the AES-KW ciphertext of the key plus its KDF parameters.
   *
   * @param {string} passphrase User passphrase.
   * @param {number} [iterations=600000] PBKDF2 iterations.
   * @returns {Promise<{v:number,kdf:string,iterations:number,salt:string,wrapped:string}>}
   */
  async function createWrappedKey(passphrase, iterations = 600000) {
    // Fresh random salt so the derived KEK is unique to this vault even if two
    // users pick the same passphrase. It is not secret; we store it alongside.
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const kek = await deriveKek(passphrase, salt, iterations);

    // The data key must be extractable to be wrappable. It exists in that
    // state only inside this function; the copy we later unwrap at unlock
    // time is imported non-extractable.
    const dataKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    // wrapKey encrypts the data key's raw bytes under the KEK using AES-KW.
    // `wrapped` is the only form of the data key we will persist to disk.
    const wrapped = await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW");

    state.mode = "passphrase";
    // Re-import non-extractable so the in-memory handle is as locked down as
    // the device-mode key.
    state.dataKey = await reimportNonExtractable(dataKey);

    // Return the persistable blob: the wrapped key plus everything needed to
    // re-derive the KEK later (version, KDF name, iteration count, salt). All of
    // it is base64-encoded so it can live as plain text in storage. Note there
    // is nothing here an attacker can use without the passphrase.
    return {
      v: ENVELOPE_VERSION,
      kdf: "PBKDF2-SHA256",
      iterations,
      salt: Text.toBase64Url(salt),
      wrapped: Text.toBase64Url(new Uint8Array(wrapped)),
    };
  }

  /**
   * Re-import an extractable key as non-extractable. Used immediately after
   * wrapping so the long-lived handle cannot be exported again.
   *
   * @param {CryptoKey} key Extractable AES-GCM key.
   * @returns {Promise<CryptoKey>} Equivalent non-extractable key.
   */
  async function reimportNonExtractable(key) {
    // Export the raw bytes (only possible because `key` was made extractable),
    // then import them straight back with extractable=false. The returned handle
    // is functionally identical but can never be exported again.
    const raw = await crypto.subtle.exportKey("raw", key);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  /**
   * Unlock a passphrase-mode vault. A wrong passphrase produces a KEK that
   * fails the AES-KW integrity check, so unwrapKey throws and we surface a
   * clean BAD_PASSPHRASE rather than a cryptic DOMException.
   *
   * @param {string} passphrase User passphrase.
   * @param {{salt:string,wrapped:string,iterations:number}} blob Stored blob.
   * @returns {Promise<boolean>} true on success.
   * @throws {Error} BAD_PASSPHRASE when the passphrase does not match.
   */
  async function unlock(passphrase, blob) {
    // Recover the salt and wrapped-key bytes from their base64 text, then
    // re-derive the same KEK using the stored iteration count. A wrong
    // passphrase produces a DIFFERENT KEK here, which is what makes the unwrap
    // below fail cleanly.
    const salt = Text.fromBase64Url(blob.salt);
    const wrapped = Text.fromBase64Url(blob.wrapped);
    const kek = await deriveKek(passphrase, salt, blob.iterations);

    let key;
    try {
      // unwrapKey decrypts the wrapped data key with the KEK and imports the
      // result directly as a non-extractable AES-GCM key (the `false`). AES-KW
      // has a built-in integrity check, so a wrong KEK makes this throw rather
      // than yield a garbage key.
      key = await crypto.subtle.unwrapKey(
        "raw",
        wrapped,
        kek,
        "AES-KW",
        { name: "AES-GCM" },
        false, // unwrap straight into a non-extractable handle
        ["encrypt", "decrypt"]
      );
    } catch (cause) {
      // Translate the low-level failure into a friendly, specific error. `cause`
      // preserves the original exception for debugging.
      const err = new Error("Incorrect passphrase");
      err.code = "BAD_PASSPHRASE";
      err.cause = cause;
      throw err;
    }

    // Success: remember we are in passphrase mode and hold the key in memory.
    state.mode = "passphrase";
    state.dataKey = key;
    return true;
  }

  /**
   * Drop the in-memory key handle. After this, every read and write fails
   * with LOCKED until unlock() runs again. Called on explicit user lock.
   */
  function lock() {
    state.dataKey = null;
  }

  /**
   * Delete the device key from persistent storage.
   *
   * Called in two places, both of which depend on it for their security
   * guarantee: after migrating to passphrase mode (otherwise the old
   * unprotected key would still be sitting in IndexedDB, able to decrypt any
   * storage fragment left behind), and during a full wipe (destroying the key
   * last makes any residual on-disk data permanently unrecoverable).
   *
   * @returns {Promise<void>}
   */
  async function destroyDeviceKey() {
    await store().remove(DB_KEY);
    if (state.mode === "device") state.dataKey = null;
  }

  /**
   * Report whether cryptographic operations can currently proceed.
   *
   * @returns {{mode: string, unlocked: boolean}}
   */
  function status() {
    // Device mode is always considered "unlocked" because the key is available
    // without any user action; passphrase mode is unlocked only once a key
    // handle is held in memory (i.e. after a successful unlock()).
    return { mode: state.mode, unlocked: state.dataKey !== null || state.mode === "device" };
  }

  /* ------------------------------------------------------------------ *
   * Record sealing                                                      *
   * ------------------------------------------------------------------ */

  /**
   * Build the additional authenticated data for a record. Binding both the
   * record id and the envelope version means a ciphertext is only ever valid
   * in the exact slot and format it was written for.
   *
   * @param {string} recordId Logical record name, e.g. "secrets".
   * @returns {Uint8Array} AAD bytes.
   */
  function aadFor(recordId) {
    // Build a short context string like "valyou:v1:secrets" and encode it to
    // bytes. Passed as AAD, it is authenticated but not encrypted, so the
    // ciphertext is cryptographically bound to this exact record name and
    // version (see the AAD note in the primer). The backticks are a JS template
    // literal: `${x}` inserts the value of x into the string.
    return new TextEncoder().encode(`valyou:v${ENVELOPE_VERSION}:${recordId}`);
  }

  /**
   * Encrypt a JSON-serializable value into a storable envelope.
   *
   * @param {string} recordId Logical record name; must match on decrypt.
   * @param {*} value Any JSON-serializable value.
   * @returns {Promise<{v:number,alg:string,iv:string,ct:string}>} Envelope.
   */
  async function encryptJSON(recordId, value) {
    const key = await getDataKey();
    // A FRESH random IV for every record — never reused with this key (see the
    // primer). getRandomValues fills the 12-byte array with secure randomness.
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    // Turn the value into a JSON string, then into UTF-8 bytes to encrypt.
    const plaintext = new TextEncoder().encode(JSON.stringify(value));

    // Encrypt under AES-GCM with our IV and this record's AAD. tagLength: 128
    // requests the full-strength 128-bit authentication tag. The result is an
    // ArrayBuffer of ciphertext (with the tag appended by GCM).
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(recordId), tagLength: 128 },
      key,
      plaintext
    );

    // Return the "envelope": everything needed to decrypt later except the key.
    // The IV and ciphertext are base64-encoded so the record is plain-text-safe
    // storage. The IV is not secret — only its uniqueness matters.
    return {
      v: ENVELOPE_VERSION,
      alg: "A256GCM",
      iv: Text.toBase64Url(iv),
      ct: Text.toBase64Url(new Uint8Array(ciphertext)),
    };
  }

  /**
   * Decrypt an envelope previously produced by encryptJSON.
   *
   * Any tampering — flipped ciphertext bits, a swapped record, a downgraded
   * version field — fails the GCM tag check and throws DECRYPT_FAILED. Callers
   * treat that as "no stored value" and fall back to defaults rather than
   * trusting anything partial.
   *
   * @param {string} recordId Logical record name used at encrypt time.
   * @param {{v:number,alg:string,iv:string,ct:string}} envelope Stored value.
   * @returns {Promise<*>} The original value.
   * @throws {Error} DECRYPT_FAILED on any authentication or format failure.
   */
  async function decryptJSON(recordId, envelope) {
    // Reject anything that is not an envelope we wrote in a format we support,
    // before touching the crypto engine.
    if (!envelope || envelope.v !== ENVELOPE_VERSION || envelope.alg !== "A256GCM") {
      const err = new Error("Unsupported or missing envelope");
      err.code = "DECRYPT_FAILED";
      throw err;
    }

    const key = await getDataKey();
    try {
      // Decrypt with the SAME iv and AAD used at encrypt time. GCM verifies the
      // authentication tag first: if the ciphertext, IV, or AAD (record name /
      // version) has changed at all, this throws instead of returning data.
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Text.fromBase64Url(envelope.iv),
          additionalData: aadFor(recordId),
          tagLength: 128,
        },
        key,
        Text.fromBase64Url(envelope.ct)
      );
      // Bytes -> UTF-8 string -> original JavaScript value.
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (cause) {
      // A locked vault is a distinct condition (not a tamper) — re-throw as-is
      // so callers can prompt for unlock rather than assuming corruption.
      if (cause && cause.code === "LOCKED") throw cause;
      // Any other failure (bad tag, wrong key, malformed data) collapses to one
      // opaque DECRYPT_FAILED so callers fall back to defaults, never partial data.
      const err = new Error(`Could not decrypt record "${recordId}"`);
      err.code = "DECRYPT_FAILED";
      err.cause = cause;
      throw err;
    }
  }

  /**
   * Generate a random hex string, used for the per-installation cache salt
   * and the install id.
   *
   * @param {number} [bytes=16] Number of random bytes.
   * @returns {string} Lowercase hex.
   */
  function randomHex(bytes = 16) {
    // Fill a byte array with secure random values, then render each byte as a
    // 2-digit hex string. toString(16) is base-16; padStart(2, "0") keeps a
    // leading zero (e.g. 5 -> "05") so every byte is exactly two characters.
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Best-effort zeroization of a string held in a mutable container. JS
   * strings are immutable and garbage-collected, so a passphrase cannot truly
   * be scrubbed; the practical mitigation is to keep it in a single-field
   * object, overwrite the field, and drop the reference promptly.
   *
   * @param {{value: string}} box Container holding sensitive text.
   */
  function scrub(box) {
    // Overwrite the stored text (with same-length filler), then empty it and
    // let the reference drop. This cannot guarantee the old string is erased
    // from memory — JS strings are immutable and reclaimed by the garbage
    // collector on its own schedule — but it shortens how long a passphrase
    // lingers in this container.
    if (box && typeof box.value === "string") {
      box.value = " ".repeat(box.value.length);
      box.value = "";
    }
  }

  // The module's public API. Names prefixed with "_" are exported only so the
  // test suite can reach otherwise-internal helpers.
  return {
    ENVELOPE_VERSION,
    configure,
    getDataKey,
    createWrappedKey,
    unlock,
    lock,
    destroyDeviceKey,
    status,
    encryptJSON,
    decryptJSON,
    randomHex,
    scrub,
    // exported for tests
    _aadFor: aadFor,
    _deriveKek: deriveKek,
  };
});
