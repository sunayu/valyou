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

test("sanitize returns full defaults for empty input", () => {
  const { Settings, Taxonomy } = setupEnv();
  for (const input of [null, undefined, {}, "nonsense", 42, []]) {
    const result = Settings.sanitize(input);
    assert.deepEqual(result, Taxonomy.DEFAULT_SETTINGS, `input: ${JSON.stringify(input)}`);
  }
});

test("sanitize drops unknown top-level keys", () => {
  const { Settings } = setupEnv();
  const result = Settings.sanitize({ enabled: true, evilPayload: "<script>", __proto__: {} });
  assert.equal(result.evilPayload, undefined);
});

test("sanitize preserves valid user choices", () => {
  const { Settings } = setupEnv();
  const result = Settings.sanitize({
    enabled: false,
    categories: { violence: { action: "tag", threshold: 0.4 } },
    surfaces: { ads: false },
  });

  assert.equal(result.enabled, false);
  assert.equal(result.categories.violence.action, "tag");
  assert.equal(result.categories.violence.threshold, 0.4);
  assert.equal(result.surfaces.ads, false);
});

test("sanitize rejects an unknown action and falls back to the default", () => {
  const { Settings, Taxonomy } = setupEnv();
  const result = Settings.sanitize({
    categories: { violence: { action: "delete_everything", threshold: 0.5 } },
  });
  assert.equal(result.categories.violence.action, Taxonomy.DEFAULT_SETTINGS.categories.violence.action);
});

test("sanitize clamps thresholds into a usable range", () => {
  const { Settings } = setupEnv();
  // A zero threshold would filter literally every post; a negative or huge one
  // is nonsense. Both must be brought back in range rather than rejected.
  const low = Settings.sanitize({ categories: { violence: { threshold: -5 } } });
  const high = Settings.sanitize({ categories: { violence: { threshold: 99 } } });

  assert.equal(low.categories.violence.threshold, 0.05);
  assert.equal(high.categories.violence.threshold, 1);
});

test("sanitize coerces numeric strings from form inputs", () => {
  const { Settings } = setupEnv();
  // Range inputs hand back strings; the engine needs numbers.
  const result = Settings.sanitize({ categories: { violence: { threshold: "0.45" } } });
  assert.equal(result.categories.violence.threshold, 0.45);
  assert.equal(typeof result.categories.violence.threshold, "number");
});

test("sanitize keeps the ml assist enabled by default and coerces the flag", () => {
  const { Settings } = setupEnv();
  assert.equal(Settings.sanitize(null).ml.enabled, true);
  assert.equal(Settings.sanitize({ ml: { enabled: false } }).ml.enabled, false);
  // A non-boolean falls back to the default rather than becoming truthy junk.
  assert.equal(Settings.sanitize({ ml: { enabled: "yes" } }).ml.enabled, true);
  assert.equal(Settings.sanitize({ ml: "nonsense" }).ml.enabled, true);
});

test("sanitize defaults video handling to hide and accepts the three modes", () => {
  const { Settings } = setupEnv();
  // Default: every video post is blurred until the user selects it to play.
  assert.equal(Settings.sanitize(null).media.video, "hide");
  for (const mode of ["allow", "block", "hide"]) {
    assert.equal(Settings.sanitize({ media: { video: mode } }).media.video, mode);
  }
  assert.equal(Settings.sanitize({ media: { video: "nuke" } }).media.video, "hide");
  assert.equal(Settings.sanitize({ media: "nonsense" }).media.video, "hide");
});

test("sanitize migrates the legacy video mode names", () => {
  const { Settings } = setupEnv();
  // Pre-0.1 installs used normal/strict/always.
  assert.equal(Settings.sanitize({ media: { video: "normal" } }).media.video, "allow");
  assert.equal(Settings.sanitize({ media: { video: "strict" } }).media.video, "block");
  assert.equal(Settings.sanitize({ media: { video: "always" } }).media.video, "hide");
});

test("sanitize defaults flaggedVideoBlur on and coerces the flag", () => {
  const { Settings } = setupEnv();
  assert.equal(Settings.sanitize(null).media.flaggedVideoBlur, true);
  assert.equal(Settings.sanitize({ media: { flaggedVideoBlur: false } }).media.flaggedVideoBlur, false);
  assert.equal(Settings.sanitize({ media: { flaggedVideoBlur: "yes" } }).media.flaggedVideoBlur, true);
});

test("sanitize drops legacy ai settings from older installs", () => {
  // Records written by pre-subscription builds carried an `ai` block. It has
  // no meaning any more and must not survive into the sanitized object.
  const { Settings } = setupEnv();
  const result = Settings.sanitize({ enabled: true, ai: { enabled: true, model: "claude-opus-5" } });
  assert.equal(result.ai, undefined);
});

test("sanitize cleans user rule lists", () => {
  const { Settings } = setupEnv();
  const result = Settings.sanitize({
    rules: {
      blockTerms: ["  spam  ", "spam", "SPAM", "", "   ", 42, null, "other"],
    },
  });

  // Trimmed, de-duplicated case-insensitively, non-strings and empties dropped.
  assert.deepEqual(result.rules.blockTerms, ["spam", "other"]);
});

test("sanitize caps rule lists so a paste accident cannot bloat storage", () => {
  const { Settings } = setupEnv();
  const huge = Array.from({ length: 5000 }, (_, i) => `term${i}`);
  assert.equal(Settings.sanitize({ rules: { blockTerms: huge } }).rules.blockTerms.length, 500);
});

test("sanitize handles a non-array rule list", () => {
  const { Settings } = setupEnv();
  const result = Settings.sanitize({ rules: { blockTerms: "not an array" } });
  assert.deepEqual(result.rules.blockTerms, []);
});

test("sanitize refuses to weaken the KDF below the OWASP floor", () => {
  const { Settings } = setupEnv();
  // A stale or hostile record must not be able to downgrade key derivation.
  assert.equal(Settings.sanitize({ security: { kdfIterations: 1 } }).security.kdfIterations, 210000);
  assert.equal(
    Settings.sanitize({ security: { kdfIterations: 900000 } }).security.kdfIterations,
    900000
  );
});

test("sanitize only accepts the two known key modes", () => {
  const { Settings } = setupEnv();
  assert.equal(Settings.sanitize({ security: { keyMode: "passphrase" } }).security.keyMode, "passphrase");
  assert.equal(Settings.sanitize({ security: { keyMode: "none" } }).security.keyMode, "device");
});

test("load returns defaults when nothing has been stored", async () => {
  const { Settings, Taxonomy } = setupEnv();
  assert.deepEqual(await Settings.load(), Taxonomy.DEFAULT_SETTINGS);
});

test("save sanitizes before writing and load reads it back", async () => {
  const { Settings } = setupEnv();
  const saved = await Settings.save({
    enabled: false,
    categories: { violence: { action: "bogus", threshold: 5 } },
  });

  assert.equal(saved.enabled, false);
  assert.equal(saved.categories.violence.action, "hide"); // fell back
  assert.equal(saved.categories.violence.threshold, 1); // clamped
  assert.deepEqual(await Settings.load(), saved);
});

test("secrets are stored separately from settings", async () => {
  const { Settings, local } = setupEnv();
  await Settings.save({ enabled: true });
  await Settings.setSecret("licenseKey", "VAL-1234-5678-ABCD");

  // Two distinct encrypted records: settings can be exported for support
  // without ever touching a secret.
  assert.ok(local._data.has("settings"));
  assert.ok(local._data.has("secrets"));
});

test("a stored secret round-trips and never appears on disk in the clear", async () => {
  const { Settings, local } = setupEnv();
  await Settings.setSecret("licenseKey", "VAL-1234-5678-ABCD");

  assert.equal(await Settings.getSecret("licenseKey"), "VAL-1234-5678-ABCD");
  const raw = JSON.stringify(Object.fromEntries(local._data));
  assert.ok(!raw.includes("VAL-1234"), "secret leaked to raw storage");
});

test("clearing a secret removes it, and an empty record is deleted outright", async () => {
  const { Settings, local } = setupEnv();
  await Settings.setSecret("licenseKey", "VAL-1234-5678-ABCD");
  await Settings.setSecret("licenseKey", null);

  assert.equal(await Settings.getSecret("licenseKey"), null);
  assert.ok(!local._data.has("secrets"), "empty secrets record should not linger");
});

test("secrets are independent of one another", async () => {
  const { Settings } = setupEnv();
  await Settings.setSecret("licenseKey", "VAL-1");
  await Settings.setSecret("other", "xyz");
  await Settings.setSecret("other", null);

  assert.equal(await Settings.getSecret("licenseKey"), "VAL-1");
  assert.equal(await Settings.getSecret("other"), null);
});

test("getSecret returns null when nothing is stored", async () => {
  const { Settings } = setupEnv();
  assert.equal(await Settings.getSecret("licenseKey"), null);
});

test("getInstall creates a random salt once and reuses it", async () => {
  const { Settings } = setupEnv();
  const first = await Settings.getInstall();
  const second = await Settings.getInstall();

  assert.equal(first.hashSalt.length, 64, "32 random bytes as hex");
  // Reuse matters: a changing salt would invalidate the whole verdict cache
  // on every service-worker restart.
  assert.equal(second.hashSalt, first.hashSalt);
  assert.equal(second.installId, first.installId);
});

test("separate installations get different salts", async () => {
  const a = await setupEnv().Settings.getInstall();
  const b = await setupEnv().Settings.getInstall();
  assert.notEqual(a.hashSalt, b.hashSalt);
});
