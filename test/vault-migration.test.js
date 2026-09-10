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
 * Regression tests for the device-key -> passphrase migration.
 *
 * This sequence had three separate bugs on the first pass, each of which
 * silently destroyed user data or bricked the vault. The logic is reproduced
 * here rather than imported because it lives in the service worker, which
 * cannot be loaded outside a browser — so these tests pin the *behaviour* the
 * worker must implement, and any change to that flow has to keep them green.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv } = require("./helpers/env.js");

const RECORDS = ["settings", "secrets", "stats", "install"];
const PASSPHRASE = "a sufficiently long passphrase";

/**
 * The migration, exactly as the service worker performs it.
 *
 * @param {object} env Environment from setupEnv().
 * @param {string} passphrase Chosen passphrase.
 * @returns {Promise<object>} The wrapped-key blob that was persisted.
 */
async function migrate(env, passphrase) {
  const { Crypto, Store } = env;

  // 1. Read everything out UNDER THE OLD KEY, before it is replaced.
  const carried = {};
  for (const id of RECORDS) carried[id] = await Store.get(id, null);

  // 2. Mint the new key and persist its wrapped form unencrypted.
  const blob = await Crypto.createWrappedKey(passphrase, 1000);
  await Store.setRaw("wrappedKey", blob);

  // 3. Re-seal everything under the new key.
  for (const [id, value] of Object.entries(carried)) {
    if (value !== null) await Store.set(id, value);
  }

  // 4. Destroy the old unprotected key last.
  await Crypto.destroyDeviceKey();
  return blob;
}

test("migration preserves settings and stored secrets", async () => {
  const env = setupEnv();
  const { Store, Settings } = env;

  await Settings.save({ enabled: false, categories: { violence: { threshold: 0.4 } } });
  await Settings.setSecret("licenseKey", "VAL-1234-5678-ABCD");
  await Store.set("stats", { total: 42, allTime: 100 });

  await migrate(env, PASSPHRASE);

  // The original bug: enabling passphrase mode minted a new key without
  // re-encrypting anything, so every record became permanently unreadable.
  const settings = await Settings.load();
  assert.equal(settings.enabled, false);
  assert.equal(settings.categories.violence.threshold, 0.4);
  assert.equal(await Settings.getSecret("licenseKey"), "VAL-1234-5678-ABCD");
  assert.equal((await Store.get("stats")).total, 42);
});

test("the wrapped-key blob is stored unencrypted so the vault can be opened", async () => {
  const env = setupEnv();
  const { Store, Crypto } = env;

  const blob = await migrate(env, PASSPHRASE);

  // The original bug: the blob was written through the encrypting path, so
  // reading it required the key it contained — an unopenable vault.
  Crypto.lock();
  const readBack = await Store.getRaw("wrappedKey");

  assert.deepEqual(readBack, blob);
  assert.ok(readBack.salt && readBack.wrapped, "blob must be usable while locked");
  await Crypto.unlock(PASSPHRASE, readBack);
  assert.equal(Crypto.status().unlocked, true);
});

test("the wrapped blob leaks nothing usable to an attacker", async () => {
  const env = setupEnv();
  const { local } = env;
  await env.Settings.setSecret("licenseKey", "VAL-1234-5678-ABCD");
  await migrate(env, PASSPHRASE);

  // Storing it in the clear is only acceptable because it is self-protecting:
  // AES-KW ciphertext plus non-secret KDF parameters.
  const raw = JSON.stringify(Object.fromEntries(local._data));
  assert.ok(!raw.includes(PASSPHRASE), "passphrase must not appear on disk");
  assert.ok(!raw.includes("VAL-1234"), "secret must not appear on disk");
});

test("the old device key is destroyed, so residual data cannot be recovered", async () => {
  const env = setupEnv();
  const { keyStore } = env;

  await env.Settings.save({ enabled: true });
  assert.ok(await keyStore.get("data-key-v1"), "device key should exist beforehand");

  await migrate(env, PASSPHRASE);

  // Leaving it behind would defeat the entire point of the passphrase: an
  // attacker with disk access could still decrypt anything the browser had
  // not fully overwritten.
  assert.equal(await keyStore.get("data-key-v1"), undefined);
});

test("after migration the vault is locked until the passphrase is supplied", async () => {
  const env = setupEnv();
  const { Crypto, Store } = env;

  await env.Settings.save({ enabled: true });
  const blob = await migrate(env, PASSPHRASE);

  Crypto.lock();
  assert.equal(Crypto.status().unlocked, false);
  await assert.rejects(
    () => Store.get("settings", null),
    (err) => err.code === "LOCKED"
  );

  await Crypto.unlock(PASSPHRASE, blob);
  assert.equal((await env.Settings.load()).enabled, true);
});

test("key mode is derived from the blob's presence, not from encrypted settings", async () => {
  const env = setupEnv();
  const { Store, Crypto } = env;

  // Before migration there is no blob, so device mode is correct.
  assert.equal(await Store.getRaw("wrappedKey"), null);

  await env.Settings.save({ enabled: true });
  await migrate(env, PASSPHRASE);

  // After migration the blob is the signal. The original bug read the mode
  // from `settings.security.keyMode` — a field inside an encrypted record,
  // which cannot be read before the mode is known. A deadlock on every boot.
  const blob = await Store.getRaw("wrappedKey");
  assert.ok(blob, "the blob must be readable with no key at all");

  Crypto.configure({ keyStore: env.keyStore, mode: blob ? "passphrase" : "device" });
  assert.equal(Crypto.status().mode, "passphrase");
  assert.equal(Crypto.status().unlocked, false);
});

test("a wipe destroys the key, making leftover ciphertext unrecoverable", async () => {
  const env = setupEnv();
  const { Store, Crypto, keyStore } = env;

  await Store.set("secrets", { licenseKey: "VAL-1234-5678-ABCD" });
  const orphan = Object.fromEntries(env.local._data).secrets;

  await Store.wipe();
  await Crypto.destroyDeviceKey();

  assert.equal(await keyStore.get("data-key-v1"), undefined);

  // A fresh key cannot read the old ciphertext, which is the guarantee that
  // makes "delete everything" meaningful even if the browser leaves fragments
  // of the LevelDB file on disk.
  await Crypto.getDataKey();
  await assert.rejects(
    () => Crypto.decryptJSON("secrets", orphan),
    (err) => err.code === "DECRYPT_FAILED"
  );
});
