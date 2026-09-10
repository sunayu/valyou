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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv } = require("./helpers/env.js");
const Text = require("../src/lib/text.js");

test("encryptJSON produces an authenticated envelope, not plaintext", async () => {
  const { Crypto } = setupEnv();
  const secret = { licenseKey: "VAL-supersecret-value" };

  const envelope = await Crypto.encryptJSON("secrets", secret);

  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, "A256GCM");
  assert.ok(envelope.iv, "must carry an IV");
  assert.ok(envelope.ct, "must carry ciphertext");

  // The whole point: the secret must not be recoverable from the stored form.
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes("supersecret"), "plaintext leaked into the envelope");
  assert.ok(!serialized.includes("licenseKey"), "field names leaked into the envelope");
});

test("decryptJSON round-trips every JSON value shape", async () => {
  const { Crypto } = setupEnv();
  const values = [
    { nested: { deep: [1, 2, { x: true }] } },
    [1, 2, 3],
    "a plain string",
    42,
    true,
    null,
  ];

  for (const value of values) {
    const envelope = await Crypto.encryptJSON("settings", value);
    assert.deepEqual(await Crypto.decryptJSON("settings", envelope), value);
  }
});

test("each encryption uses a fresh IV, so identical plaintexts differ", async () => {
  const { Crypto } = setupEnv();
  const a = await Crypto.encryptJSON("settings", { same: "value" });
  const b = await Crypto.encryptJSON("settings", { same: "value" });

  // IV reuse under GCM is catastrophic (it leaks the XOR of plaintexts and
  // can expose the authentication key), so this is a security-critical check.
  assert.notEqual(a.iv, b.iv, "IV must never repeat");
  assert.notEqual(a.ct, b.ct, "ciphertext must not be deterministic");
});

test("the IV is 96 bits, GCM's native size", async () => {
  const { Crypto } = setupEnv();
  const envelope = await Crypto.encryptJSON("settings", { x: 1 });
  assert.equal(Text.fromBase64Url(envelope.iv).length, 12);
});

test("decrypting with the wrong record id fails the AAD check", async () => {
  const { Crypto } = setupEnv();
  const envelope = await Crypto.encryptJSON("secrets", { licenseKey: "VAL-x" });

  // This is the record-swap defence: an attacker who copies the `secrets`
  // blob over the `settings` slot must not get a usable decryption.
  await assert.rejects(
    () => Crypto.decryptJSON("settings", envelope),
    (err) => err.code === "DECRYPT_FAILED"
  );
});

test("tampering with the ciphertext is detected", async () => {
  const { Crypto } = setupEnv();
  const envelope = await Crypto.encryptJSON("settings", { enabled: true });

  // Flip one byte of ciphertext. GCM's tag must reject it rather than
  // returning attacker-influenced settings.
  const bytes = Text.fromBase64Url(envelope.ct);
  bytes[0] ^= 0x01;
  const tampered = Object.assign({}, envelope, { ct: Text.toBase64Url(bytes) });

  await assert.rejects(
    () => Crypto.decryptJSON("settings", tampered),
    (err) => err.code === "DECRYPT_FAILED"
  );
});

test("tampering with the IV is detected", async () => {
  const { Crypto } = setupEnv();
  const envelope = await Crypto.encryptJSON("settings", { enabled: true });

  const iv = Text.fromBase64Url(envelope.iv);
  iv[0] ^= 0xff;
  const tampered = Object.assign({}, envelope, { iv: Text.toBase64Url(iv) });

  await assert.rejects(
    () => Crypto.decryptJSON("settings", tampered),
    (err) => err.code === "DECRYPT_FAILED"
  );
});

test("a downgraded or unknown envelope version is rejected", async () => {
  const { Crypto } = setupEnv();
  const envelope = await Crypto.encryptJSON("settings", { enabled: true });

  for (const bad of [
    Object.assign({}, envelope, { v: 0 }),
    Object.assign({}, envelope, { alg: "A128GCM" }),
    null,
    undefined,
    {},
  ]) {
    await assert.rejects(
      () => Crypto.decryptJSON("settings", bad),
      (err) => err.code === "DECRYPT_FAILED"
    );
  }
});

test("the device data key is non-extractable and persisted for reuse", async () => {
  const { Crypto, keyStore } = setupEnv();

  const first = await Crypto.getDataKey();
  assert.equal(first.extractable, false, "key material must not be exportable");
  assert.deepEqual(first.usages.sort(), ["decrypt", "encrypt"]);

  // Reset the in-memory handle; the key must come back from the store rather
  // than being regenerated, or every restart would orphan all stored data.
  Crypto.configure({ keyStore, mode: "device" });
  const second = await Crypto.getDataKey();
  assert.equal(second, first, "must reuse the persisted key");
});

test("a non-extractable key cannot be exported even by us", async () => {
  const { Crypto } = setupEnv();
  const key = await Crypto.getDataKey();

  // Demonstrates the guarantee: code running inside the extension can use the
  // key but cannot exfiltrate its bytes.
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));
});

test("data written under one installation's key is unreadable under another", async () => {
  const envA = setupEnv();
  const envelope = await envA.Crypto.encryptJSON("secrets", { licenseKey: "VAL-aaa" });

  // A second install generates an independent key.
  const envB = setupEnv();
  await envB.Crypto.getDataKey();

  await assert.rejects(
    () => envB.Crypto.decryptJSON("secrets", envelope),
    (err) => err.code === "DECRYPT_FAILED"
  );
});

test("passphrase mode wraps the key and never persists usable material", async () => {
  const { Crypto } = setupEnv({ mode: "device" });

  // Low iteration count keeps the test fast; production uses 600,000.
  const blob = await Crypto.createWrappedKey("correct horse battery staple", 1000);

  assert.equal(blob.kdf, "PBKDF2-SHA256");
  assert.equal(blob.iterations, 1000);
  assert.equal(Text.fromBase64Url(blob.salt).length, 16, "salt must be 128 bits");
  // AES-KW of a 256-bit key is 40 bytes (key + 8-byte integrity block).
  assert.equal(Text.fromBase64Url(blob.wrapped).length, 40);
});

test("passphrase mode leaves the live key non-extractable after setup", async () => {
  const { Crypto } = setupEnv();
  await Crypto.createWrappedKey("correct horse battery staple", 1000);

  const key = await Crypto.getDataKey();
  assert.equal(key.extractable, false, "the long-lived handle must not be exportable");
});

test("unlock restores the same key, so data written before it stays readable", async () => {
  const { Crypto } = setupEnv();

  const blob = await Crypto.createWrappedKey("correct horse battery staple", 1000);
  const envelope = await Crypto.encryptJSON("secrets", { licenseKey: "VAL-zzz" });

  Crypto.lock();
  await Crypto.unlock("correct horse battery staple", blob);

  assert.deepEqual(await Crypto.decryptJSON("secrets", envelope), { licenseKey: "VAL-zzz" });
});

test("unlock with the wrong passphrase fails cleanly", async () => {
  const { Crypto } = setupEnv();
  const blob = await Crypto.createWrappedKey("the right passphrase", 1000);
  Crypto.lock();

  await assert.rejects(
    () => Crypto.unlock("the wrong passphrase", blob),
    (err) => err.code === "BAD_PASSPHRASE"
  );
});

test("a locked vault refuses to encrypt or decrypt", async () => {
  const { Crypto } = setupEnv();
  const blob = await Crypto.createWrappedKey("a passphrase for locking", 1000);
  const envelope = await Crypto.encryptJSON("settings", { enabled: true });

  Crypto.lock();

  assert.equal(Crypto.status().unlocked, false);
  await assert.rejects(
    () => Crypto.encryptJSON("settings", { enabled: false }),
    (err) => err.code === "LOCKED"
  );
  await assert.rejects(
    () => Crypto.decryptJSON("settings", envelope),
    (err) => err.code === "LOCKED"
  );

  // And unlocking restores service.
  await Crypto.unlock("a passphrase for locking", blob);
  assert.equal(Crypto.status().unlocked, true);
});

test("device mode reports unlocked without any passphrase", () => {
  const { Crypto } = setupEnv({ mode: "device" });
  const status = Crypto.status();
  assert.equal(status.mode, "device");
  assert.equal(status.unlocked, true);
});

test("the derived KEK is bound to both passphrase and salt", async () => {
  const { Crypto } = setupEnv();
  const saltA = new Uint8Array(16).fill(1);
  const saltB = new Uint8Array(16).fill(2);

  const k1 = await Crypto._deriveKek("passphrase", saltA, 1000);
  const k2 = await Crypto._deriveKek("passphrase", saltB, 1000);

  // Different salts must not produce interchangeable keys, otherwise one
  // cracked passphrase would compromise every installation that shares it.
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, k1, "AES-KW");

  await assert.rejects(() =>
    crypto.subtle.unwrapKey("raw", wrapped, k2, "AES-KW", { name: "AES-GCM" }, false, ["decrypt"])
  );
});

test("randomHex returns the requested length and does not repeat", () => {
  const { Crypto } = setupEnv();
  const a = Crypto.randomHex(16);
  const b = Crypto.randomHex(16);

  assert.equal(a.length, 32, "16 bytes is 32 hex characters");
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
});

test("AAD binds both the record id and the envelope version", () => {
  const { Crypto } = setupEnv();
  const aad = new TextDecoder().decode(Crypto._aadFor("secrets"));
  assert.equal(aad, "valyou:v1:secrets");
});

test("scrub overwrites the contents of a secret container", () => {
  const { Crypto } = setupEnv();
  const box = { value: "a-secret-passphrase" };
  Crypto.scrub(box);
  assert.equal(box.value, "");
});

test("encryption of a realistic settings record stays fast", async () => {
  const { Crypto, Taxonomy } = setupEnv();
  const settings = Taxonomy.DEFAULT_SETTINGS;

  const started = performance.now();
  for (let i = 0; i < 200; i += 1) {
    const envelope = await Crypto.encryptJSON("settings", settings);
    await Crypto.decryptJSON("settings", envelope);
  }
  const perOperation = (performance.now() - started) / 200;

  // AES-GCM is hardware-accelerated; a round trip should be well under a
  // millisecond. A regression here would mean the crypto layer had crept into
  // the interactive path.
  assert.ok(perOperation < 5, `round trip took ${perOperation.toFixed(3)}ms, expected < 5ms`);
});
