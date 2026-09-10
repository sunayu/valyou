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

test("set then get round-trips a value", async () => {
  const { Store } = setupEnv();
  await Store.set("settings", { enabled: true, count: 3 });
  assert.deepEqual(await Store.get("settings"), { enabled: true, count: 3 });
});

test("nothing readable is written to the underlying storage area", async () => {
  const { Store, local } = setupEnv();
  await Store.set("secrets", { licenseKey: "VAL-do-not-leak-me" });

  // Inspect the raw bytes as they would sit on disk.
  const raw = JSON.stringify(Object.fromEntries(local._data));
  assert.ok(!raw.includes("do-not-leak-me"), "secret found in raw storage");
  assert.ok(!raw.includes("licenseKey"), "field name found in raw storage");
  assert.match(raw, /"alg":"A256GCM"/, "should be a sealed envelope");
});

test("get returns the fallback when the record is absent", async () => {
  const { Store } = setupEnv();
  assert.equal(await Store.get("settings", null), null);
  assert.deepEqual(await Store.get("settings", { d: 1 }), { d: 1 });
});

test("a corrupted record reads as absent rather than throwing", async () => {
  const { Store, local } = setupEnv();
  await Store.set("settings", { enabled: true });

  // Simulate bit rot or tampering on disk.
  const envelope = local._data.get("settings");
  envelope.ct = envelope.ct.slice(0, -4) + "AAAA";
  local._data.set("settings", envelope);

  // Fail safe: fall back to defaults instead of trusting a broken record or
  // bricking the extension.
  assert.deepEqual(await Store.get("settings", { enabled: false }), { enabled: false });
});

test("a record moved to a different key fails to decrypt", async () => {
  const { Store, local } = setupEnv();
  await Store.set("secrets", { licenseKey: "VAL-x" });

  // Copy the (validly encrypted) secrets blob into the settings slot.
  local._data.set("settings", local._data.get("secrets"));

  assert.equal(await Store.get("settings", null), null, "AAD binding must reject the swap");
});

test("remove deletes a record", async () => {
  const { Store } = setupEnv();
  await Store.set("secrets", { licenseKey: "VAL-x" });
  await Store.remove("secrets");
  assert.equal(await Store.get("secrets", null), null);
});

test("update applies a mutation to the current value", async () => {
  const { Store } = setupEnv();
  await Store.set("stats", { total: 5 });

  const result = await Store.update("stats", { total: 0 }, (stats) => {
    stats.total += 1;
    return stats;
  });

  assert.equal(result.total, 6);
  assert.deepEqual(await Store.get("stats"), { total: 6 });
});

test("update seeds from the fallback when nothing is stored", async () => {
  const { Store } = setupEnv();
  const result = await Store.update("stats", { total: 0 }, (stats) => {
    stats.total += 10;
    return stats;
  });
  assert.equal(result.total, 10);
});

test("session records are kept separate from local records", async () => {
  const { Store, local, session } = setupEnv();

  await Store.set("cache", [["a", 1]], "session");
  await Store.set("settings", { enabled: true }, "local");

  assert.ok(session._data.has("cache"));
  assert.ok(!local._data.has("cache"), "session data must not land in local storage");
  assert.deepEqual(await Store.get("cache", null, "session"), [["a", 1]]);
});

test("session records are encrypted too", async () => {
  const { Store, session } = setupEnv();
  await Store.set("cache", [["fingerprint", { scores: { violence: 0.9 } }]], "session");

  const raw = JSON.stringify(Object.fromEntries(session._data));
  assert.ok(!raw.includes("violence"), "cache contents leaked into session storage");
});

test("wipe clears both storage areas", async () => {
  const { Store, local, session } = setupEnv();
  await Store.set("settings", { enabled: true });
  await Store.set("cache", [["a", 1]], "session");

  await Store.wipe();

  assert.equal(local._data.size, 0);
  assert.equal(session._data.size, 0);
});

test("a locked vault surfaces the LOCKED error rather than silently failing", async () => {
  const { Store, Crypto } = setupEnv();
  await Crypto.createWrappedKey("a passphrase for the vault", 1000);
  await Store.set("settings", { enabled: true });

  Crypto.lock();

  // Unlike a corrupt record, a locked vault is a state the caller must react
  // to (by prompting for the passphrase), so it must not be swallowed.
  await assert.rejects(
    () => Store.get("settings", null),
    (err) => err.code === "LOCKED"
  );
});
