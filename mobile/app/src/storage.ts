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
 * Native settings & stats storage — the mobile analogue of the extension's
 * encrypted chrome.storage layer.
 *
 * Both platforms give us an OS-backed encrypted keystore, so we do NOT re-run
 * the extension's AES-GCM envelope here — the platform keychain IS the
 * encryption at rest:
 *   - iOS: Keychain Services (Secure Enclave-backed).
 *   - Android: EncryptedSharedPreferences / Keystore.
 * `react-native-keychain` (or expo-secure-store) exposes both. The value below
 * is stored as one keychain entry; swap the two `secureGet`/`secureSet` stubs
 * for the real library call when wiring up the native project.
 *
 * The defaults here MUST match src/lib/taxonomy.js#DEFAULT_SETTINGS, and the
 * validation mirrors src/lib/settings.js#sanitize. Keeping them in sync is a
 * checklist item in mobile/README.md (they are small and change rarely).
 *
 * ----- TYPESCRIPT NOTE (for newcomers) -----
 * This is a .ts file: JavaScript plus type annotations. Types like `: string`
 * or `: Promise<Settings>` are checked by the compiler and then ERASED — none
 * of them exist at runtime, they only catch mistakes while coding. `interface`
 * and `Record<...>` below describe the SHAPE of objects; they produce no code.
 * `async`/`await` is JavaScript for asynchronous work: an `async` function
 * returns a Promise (a future value), and `await` pauses until a Promise
 * resolves — used here because keychain reads/writes are asynchronous.
 */
import * as Keychain from "react-native-keychain";

// An `interface` describes the exact shape of a settings object. It is purely a
// compile-time contract — it lets TypeScript flag typos and wrong types.
// `Record<string, X>` means "an object whose keys are strings and values are X".
export interface Settings {
  enabled: boolean; // master on/off switch for all filtering
  categories: Record<string, { action: string; threshold: number }>; // per-category rules
  surfaces: Record<string, boolean>; // which surfaces (feed/comments/…) are filtered
  ml: { enabled: boolean }; // on-device ML assist on/off
  // `"allow" | "block" | "hide"` is a union type: the value must be exactly one
  // of those three literal strings, nothing else.
  media: { video: "allow" | "block" | "hide"; flaggedVideoBlur: boolean };
  rules: { allowAuthors: string[]; blockTerms: string[]; allowTerms: string[] }; // user lists
}

const KEY = "valyou.settings"; // keychain entry name for the settings blob

/** Defaults — kept in lockstep with taxonomy.js#DEFAULT_SETTINGS. */
export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  categories: {
    hate_racial: { action: "hide", threshold: 0.55 },
    hate_gender: { action: "hide", threshold: 0.55 },
    violence: { action: "hide", threshold: 0.55 },
    harassment: { action: "blur", threshold: 0.6 },
    rage_bait: { action: "blur", threshold: 0.7 },
  },
  surfaces: { feed: true, comments: true, ads: true, messages: true, reels: true },
  ml: { enabled: true },
  media: { video: "hide", flaggedVideoBlur: true },
  rules: { allowAuthors: [], blockTerms: [], allowTerms: [] },
};

/**
 * Write options binding every entry to the OS hardware keystore:
 *   - Secure Enclave / StrongBox where available.
 *   - Decryptable only after first unlock, and never synced off-device or into
 *     a cloud backup (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY). `accessible` is a
 *     write-time property, so it is only meaningful on set.
 */
const SET_OPTS: Keychain.SetOptions = {
  accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Read one entry from the OS keychain, or null if absent. The keychain stores
 * "generic passwords" keyed by a `service` name; we reuse that mechanism to
 * store our own JSON string. `await` waits for the async read to finish.
 */
async function secureGet(key: string): Promise<string | null> {
  const record = await Keychain.getGenericPassword({ service: key });
  // getGenericPassword returns false when nothing is stored, otherwise a record
  // with a `password` field holding our value.
  return record ? record.password : null;
}

/**
 * Write one entry to the OS keychain. The API wants a username + password; we
 * only care about the value, so the username is a fixed sentinel ("valyou").
 * The `...SET_OPTS` spreads the hardware-keystore options defined above into
 * this call's options object.
 */
async function secureSet(key: string, value: string): Promise<void> {
  await Keychain.setGenericPassword("valyou", value, { service: key, ...SET_OPTS });
}

/**
 * Load settings from the keychain. On first run (nothing stored) or ANY read/
 * parse error, fall back to DEFAULT_SETTINGS — fail-safe, so a corrupt or
 * missing store can never leave the user unprotected. Stored JSON is run
 * through sanitize() so old or tampered data is normalised. Returns a Promise
 * because keychain access is asynchronous.
 */
/**
 * Marker for the one-time video-default migration. The default is "hide":
 * blur every video post behind a tap, nothing autoplays. Existing installs
 * get moved to it ONCE; after that the user's own choice in Settings sticks.
 */
const VIDEO_MIG_KEY = "valyou.settings.videoDefaultV3";

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await secureGet(KEY);
    if (!raw) return DEFAULT_SETTINGS; // nothing saved yet → defaults
    const clean = sanitize(JSON.parse(raw)); // stored string → object → validated
    // One-time default migration (see VIDEO_MIG_KEY above).
    if (!(await secureGet(VIDEO_MIG_KEY))) {
      await secureSet(VIDEO_MIG_KEY, "1");
      if (clean.media.video !== "hide") {
        clean.media.video = "hide";
        await secureSet(KEY, JSON.stringify(clean));
      }
    }
    return clean;
  } catch {
    return DEFAULT_SETTINGS; // any failure → safe defaults
  }
}

/**
 * Validate `next`, then persist it as a JSON string in the keychain. Returns
 * the cleaned object that was actually stored (which may differ from the input
 * if sanitize dropped or clamped anything). `Partial<Settings>` means the caller
 * may pass only some fields; sanitize fills the rest from defaults.
 */
export async function saveSettings(next: Partial<Settings>): Promise<Settings> {
  const clean = sanitize(next);
  await secureSet(KEY, JSON.stringify(clean));
  return clean;
}

/**
 * Whitelist sanitizer — a TypeScript port of settings.js#sanitize. It is the
 * single place a Settings object is constructed: it starts from the defaults
 * and copies over ONLY known keys with valid values, so unknown keys are
 * dropped and out-of-range numbers are clamped. `input: unknown` means "we do
 * not trust the shape of this" — every field must be checked before use.
 */
export function sanitize(input: unknown): Settings {
  // If input isn't an object, treat it as empty. `as Record<...>` is a type
  // assertion: it tells the compiler to treat the value as that shape (it does
  // not convert anything at runtime).
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  // Deep-clone the defaults via JSON round-trip, so we mutate a fresh copy and
  // never accidentally alter the shared DEFAULT_SETTINGS object.
  const out: Settings = JSON.parse(JSON.stringify(d));

  // Copy each field only if it is the right type; otherwise keep the default.
  out.enabled = typeof src.enabled === "boolean" ? src.enabled : d.enabled;

  const cats = (src.categories as Record<string, { action?: string; threshold?: unknown }>) || {};
  const ACTIONS = ["hide", "blur", "tag", "off"]; // the only valid actions
  // Iterate the DEFAULT category ids (not the input's), so unknown categories in
  // the input are ignored and every expected category is always present.
  for (const id of Object.keys(d.categories)) {
    const c = cats[id] || {};
    out.categories[id] = {
      action: ACTIONS.includes(c.action as string) ? (c.action as string) : d.categories[id].action,
      threshold: clamp(c.threshold, 0.05, 1, d.categories[id].threshold),
    };
  }

  const surf = (src.surfaces as Record<string, unknown>) || {};
  for (const name of Object.keys(d.surfaces)) {
    out.surfaces[name] = typeof surf[name] === "boolean" ? (surf[name] as boolean) : d.surfaces[name];
  }

  const ml = (src.ml as { enabled?: unknown }) || {};
  out.ml = { enabled: typeof ml.enabled === "boolean" ? ml.enabled : d.ml.enabled };

  const media = (src.media as { video?: unknown; flaggedVideoBlur?: unknown }) || {};
  // Map old setting names to the current ones so upgraded installs keep working.
  const LEGACY: Record<string, string> = { normal: "allow", strict: "block", always: "hide" };
  const MODES = ["allow", "block", "hide"];
  // Translate a legacy value if present, otherwise use the value as-is.
  let video = LEGACY[media.video as string] || (media.video as string);
  out.media = {
    video: (MODES.includes(video) ? video : d.media.video) as Settings["media"]["video"],
    flaggedVideoBlur:
      typeof media.flaggedVideoBlur === "boolean" ? media.flaggedVideoBlur : d.media.flaggedVideoBlur,
  };

  const rules = (src.rules as Record<string, unknown>) || {};
  out.rules = {
    allowAuthors: stringList(rules.allowAuthors),
    blockTerms: stringList(rules.blockTerms),
    allowTerms: stringList(rules.allowTerms),
  };
  return out;
}

/**
 * Coerce `v` to a number and clamp it into [min, max]. Non-numeric or infinite
 * input yields `fallback`. Used for the per-category thresholds so a bad value
 * can never push a threshold out of range.
 */
function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  // Math.max lifts up to `min`, Math.min caps at `max` → final value in range.
  return Math.min(Math.max(n, min), max);
}

/**
 * Normalise an unknown value into a clean list of strings: keep only strings,
 * trim whitespace, drop blanks, de-duplicate case-insensitively, and cap length.
 * Used for the user's allow/block term and author lists. Returns [] for non-arrays.
 */
function stringList(v: unknown, limit = 500): string[] {
  if (!Array.isArray(v)) return [];
  // A Set remembers which lower-cased entries we've already seen, for dedup.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string") continue;
    const t = entry.trim();
    if (!t || seen.has(t.toLowerCase())) continue; // skip blanks and duplicates
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= limit) break; // hard cap on list size
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Stats — counters only, never content (mirrors the extension).       *
 * ------------------------------------------------------------------ */

// The shape of a message coming across the bridge from the engine. `?` marks an
// optional field (may be absent). Note there is NO text/author/url field here —
// by design, the page can only ever send counters.
export interface StatEvent {
  type?: string;
  event: string;
  category?: string | null;
  action?: string;
  kind?: string;
}

// The aggregated counters we persist and show the user.
export interface Stats {
  filtered: number; // total units hidden/blurred/tagged
  revealed: number; // total units the user chose to reveal
  byCategory: Record<string, number>; // filtered count per category id
}

const STATS_KEY = "valyou.stats"; // separate keychain entry for stats
const EMPTY_STATS: Stats = { filtered: 0, revealed: 0, byCategory: {} };

/**
 * Read the running counters from the keychain, returning zeros on first run or
 * any error. Each field is defensively re-normalised in case the stored JSON is
 * partial or malformed. Counters only — never any content.
 */
export async function loadStats(): Promise<Stats> {
  try {
    const raw = await secureGet(STATS_KEY);
    if (!raw) return { ...EMPTY_STATS, byCategory: {} };
    const parsed = JSON.parse(raw) as Partial<Stats>;
    return {
      filtered: Number(parsed.filtered) || 0,
      revealed: Number(parsed.revealed) || 0,
      byCategory: parsed.byCategory && typeof parsed.byCategory === "object" ? parsed.byCategory : {},
    };
  } catch {
    return { ...EMPTY_STATS, byCategory: {} };
  }
}

/**
 * Persist a counter event from the engine bridge. Counters only — the bridge
 * never sends text, author, or URL, so there is nothing sensitive to store.
 * The shape matches service-worker.js#recordStat.
 */
export async function recordStat(e: StatEvent): Promise<void> {
  if (e.type !== "stats") return; // ignore anything that isn't a stats event
  try {
    // Read the current counters, bump the relevant one, and write them back.
    const stats = await loadStats();
    if (e.event === "filtered") {
      stats.filtered += 1;
      // Also increment this category's bucket, starting from 0 if unseen.
      if (e.category) stats.byCategory[e.category] = (stats.byCategory[e.category] || 0) + 1;
    } else if (e.event === "revealed") {
      stats.revealed += 1;
    }
    await secureSet(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* stats are best-effort; never surface a storage error to the user */
  }
}
