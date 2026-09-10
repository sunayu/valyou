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
 * Test environment: in-memory replacements for the two browser services the
 * library code depends on — chrome.storage and the IndexedDB key store.
 *
 * Both are injected through the same `configure()` seams the production code
 * exposes, so the modules under test run entirely unmodified. Web Crypto
 * itself is NOT stubbed: Node's implementation is the same specification
 * Chrome implements, so the encryption tests exercise real AES-GCM, real
 * PBKDF2, and real AES-KW rather than a mock that could hide a bug.
 */
"use strict";

const path = require("node:path");

const LIB = (name) => require(path.join(__dirname, "..", "..", "src", "lib", name));

/**
 * An in-memory chrome.storage area.
 *
 * Values are round-tripped through JSON on write so the tests catch anything
 * that is not actually serializable — a real chrome.storage would reject it,
 * and an object-identity-preserving stub would not.
 *
 * @returns {{get: function, set: function, remove: function, clear: function, _data: Map}}
 */
function memoryStorageArea() {
  const data = new Map();
  return {
    _data: data,

    /**
     * @param {string|string[]|null} keys Key(s) to read; null reads everything.
     * @returns {Promise<object>} Map of key to value.
     */
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(data);
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (data.has(key)) out[key] = JSON.parse(JSON.stringify(data.get(key)));
      }
      return out;
    },

    /** @param {object} items Key/value pairs to write. @returns {Promise<void>} */
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, JSON.parse(JSON.stringify(value)));
      }
    },

    /** @param {string|string[]} keys Key(s) to delete. @returns {Promise<void>} */
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) data.delete(key);
    },

    /** @returns {Promise<void>} */
    async clear() {
      data.clear();
    },
  };
}

/**
 * An in-memory replacement for the IndexedDB CryptoKey store.
 *
 * Holds live CryptoKey objects exactly as IndexedDB's structured clone would,
 * which means the non-extractable property of the key is genuinely preserved
 * and the tests can assert on it.
 *
 * @returns {{get: function, put: function, remove: function, _data: Map}}
 */
function memoryKeyStore() {
  const data = new Map();
  return {
    _data: data,
    async get(name) {
      return data.get(name);
    },
    async put(name, value) {
      data.set(name, value);
    },
    async remove(name) {
      data.delete(name);
    },
  };
}

/**
 * Wire a fresh, isolated environment for one test.
 *
 * Every call produces new storage areas and a new key store, so tests cannot
 * leak encrypted state (or a data key) into one another.
 *
 * @param {{mode?: "device"|"passphrase"}} [options]
 * @returns {{local: object, session: object, keyStore: object, Crypto: object, Store: object, Settings: object, Taxonomy: object}}
 */
function setupEnv(options = {}) {
  const Crypto = LIB("crypto.js");
  const Store = LIB("store.js");
  const Settings = LIB("settings.js");
  const Taxonomy = LIB("taxonomy.js");

  const local = memoryStorageArea();
  const session = memoryStorageArea();
  const keyStore = memoryKeyStore();

  Crypto.configure({ keyStore, mode: options.mode || "device" });
  Store.configure({ local, session });

  return { local, session, keyStore, Crypto, Store, Settings, Taxonomy };
}

module.exports = {
  LIB,
  memoryStorageArea,
  memoryKeyStore,
  setupEnv,
};
