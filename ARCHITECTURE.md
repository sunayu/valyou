# Architecture

The technical reference for valyou: how the pieces fit, what crosses each
boundary, and where to make each kind of change. Read
[README.md](README.md) first for what the product does and
[SECURITY.md](SECURITY.md) for the threat model; this document is the map of
the code.

---

## System overview

```
                           ┌────────────────────────────────────────────┐
  facebook.com / x.com /   │  Content script (isolated world)           │
  instagram.com /          │                                            │
  messenger.com     ─────► │  extractors.js ─► scorer.js ─► apply.js    │
  DOM mutations            │  (find units)    (classify)   (hide/blur)  │
                           │                                            │
                           │  main.js: scan loop, MutationObserver      │
                           └───────────────┬────────────────────────────┘
                                           │ chrome.runtime messages
                                           │ (settings, counters only —
                                           │  never post text)
                           ┌───────────────▼────────────────────────────┐
                           │  Service worker (trusted core)             │
                           │                                            │
                           │  settings.js ── store.js ── crypto.js      │
                           │  (validate)    (persist)    (AES-256-GCM)  │
                           │                                            │
                           │  stats, badge, settings broadcast          │
                           └───────────────┬────────────────────────────┘
                                           │ chrome.runtime messages
                           ┌───────────────▼────────────────────────────┐
                           │  UI pages: popup.html / options.html       │
                           └────────────────────────────────────────────┘
```

Three trust zones, in descending order of privilege:

| Zone | Runs where | May do | May never do |
| --- | --- | --- | --- |
| Service worker | Extension origin | Hold the encryption key handle, read/write encrypted storage, broadcast settings | Make network requests (no host permission exists for any API host) |
| UI pages | Extension origin | Message the worker, render settings/stats | Touch storage directly, hold secrets in DOM longer than needed |
| Content scripts | Page-adjacent isolated world | Read the feed DOM, classify locally, message the worker | Access storage, the crypto key, or any secret |

**There is no network zone.** No module issues a fetch; the manifest grants no
host permission beyond the filtered social sites, and the extension-pages CSP is
`connect-src 'none'`. Keep it that way — any future licensing endpoint gets a
single, explicit CSP exception and must never sit in the scan path.

---

## Module inventory

### `src/lib/` — shared logic (worker + content scripts + tests)

Each file is wrapped in a small UMD shim so the identical bytes load via
`importScripts` (worker), the manifest `js` array (content scripts), and
`require` (Node tests). No bundler, one copy of the logic.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `text.js` | Normalization (NFKC, zero-width strip), de-obfuscation (leetspeak, letter-spacing, homoglyphs) that **preserves word boundaries**, tokenizing, caps/punctuation metrics, base64url, salted SHA-256 fingerprints | — |
| `taxonomy.js` | The category definitions, default settings, action/surface enums, storage record names. **Single source of truth** — scorer, settings validation, and both UIs are generated from it | — |
| `lexicon.js` | Detection patterns: slurs, dogwhistles/coded hate, structural templates ("all *group* are *dehumanizing*"), rage-bait markers, and the mitigating signals that damp quotation/reporting/counter-speech | — |
| `scorer.js` | Combines pattern hits into per-category scores (noisy-OR, never summing), folds in the optional ML assist as one capped signal, applies mitigation, turns scores + settings into a decision | text, lexicon, taxonomy, ml (optional) |
| `ml.js` | The on-device ML assist: hashed n-gram features + int8 logistic-regression inference. Pure JS, no deps. Output capped below every threshold so it can only reinforce patterns. See docs/ML.md | text |
| `crypto.js` | AES-256-GCM envelopes with per-record AAD; device-key mode (non-extractable CryptoKey in IndexedDB) and passphrase mode (PBKDF2 → AES-KW wrap); key lifecycle incl. `destroyDeviceKey` | text |
| `store.js` | Encrypted persistence over `chrome.storage`. `get`/`set`/`update`/`wipe` always encrypt; `getRaw`/`setRaw` exist **only** for the self-protecting wrapped-key blob | crypto |
| `settings.js` | Whitelist sanitization of settings (unknown keys dropped, every value range-checked), generic encrypted secret slot (`getSecret`/`setSecret`, reserved for the license key), install metadata | taxonomy, store, crypto |

### `src/content/` — page side

| Module | Responsibility |
| --- | --- |
| `extractors.js` | Find content units via ARIA- and data-testid-anchored selectors (the layers that survive class-name churn), read visible text while skipping drafts/inputs/our own UI, detect ads, extract author for the allow-list check |
| `apply.js` | Apply a decision to the DOM: collapse-with-bar, blur-with-shield, or badge. Pauses and mutes videos in filtered units (with an autoplay-resume guard). Never removes host nodes (virtual-scroller safety), always idempotent (`data-valyou` marker), reveal is sticky |
| `main.js` | The scan loop: settings fetch, initial scan, debounced MutationObserver rescans, per-unit pipeline, stats reporting, live settings reload |
| `overlay.css` | The injected look of bars/shields/badges. Everything `.valyou-`-scoped and `!important` (host CSS is hostile); honors reduced-motion/transparency |

### `src/background/`, `src/ui/`

| Module | Responsibility |
| --- | --- |
| `service-worker.js` | Boot (key-mode detection → settings restore), message routing, stats/badge, passphrase enable/unlock/wipe flows, settings broadcast to open tabs |
| `ui/popup.*` | At-a-glance control: master toggle, today/all-time counts, per-category on/off, unlock form when the vault is locked |
| `ui/options.*` | Full configuration: per-category action + sensitivity, surfaces, user rules, live "try it" scoring box, security mode, data deletion |
| `ui/ui.css` | The design system: token block (brand gradient, surface ramps, radii, shadows), styled controls, popup and options layouts, dark + light |

### Tooling

| Path | Responsibility |
| --- | --- |
| `scripts/make-icons.js` | Renders the brand mark (SDF rasterizer) and hand-assembles the PNGs in `icons/`. Zero dependencies; PNGs are committed, so this only runs when the mark changes |
| `scripts/fetch-training-data.js` / `train-model.js` | Offline ML pipeline: fetch the (gitignored) hate-speech corpus, train the logistic-regression model, emit the committed `src/model/model-data.js`. Zero dependencies; runs only when retraining. See docs/ML.md |
| `test/helpers/dom.js` | Dependency-free DOM stub (elements, attributes, classList, events, small CSS-selector engine) for extractor/apply tests |
| `test/helpers/env.js` | Per-test isolated environment: in-memory `chrome.storage` areas and CryptoKey store injected through the modules' `configure()` seams. Web Crypto itself is **never** mocked |

---

## The scan pipeline

What happens for every unit, all inside one synchronous frame:

1. **Discover** — `MutationObserver` (debounced 150 ms, self-mutation
   filtered) or initial load triggers `findUnits()` over the changed subtree.
   Units already carrying `data-valyou` are skipped — idempotence is what
   prevents feedback loops with React re-renders.
2. **Extract** — visible text (bounded, drafts and valyou UI excluded) and
   best-effort author.
3. **Score** — `scoreText()`: slurs against the de-obfuscated form,
   templates/dogwhistles/rage-bait against the normalized form, user block
   terms, then mitigators applied multiplicatively (capped at 70% so an
   explicit slur can never be fully excused).
4. **Decide** — per-category thresholds from settings; when several
   categories trip, the strictest action wins; author allow-list bypasses.
5. **Apply** — hide/blur/tag with a labelled explanation and one-click
   reveal. Reveal marks the unit permanently — no later pass may re-hide it.
6. **Count** — a fire-and-forget `stats` message (category + action only).

Performance budget, enforced by tests: a single `scoreText` must stay under
0.25 ms so a 60-unit scan cannot blow a 16 ms frame.

---

## Message protocol

Every message crossing a zone boundary. The worker validates all inputs; the
content script is assumed hostile.

| Type | From | Payload | Reply |
| --- | --- | --- | --- |
| `getSettings` | any | — | `{settings, locked}` |
| `saveSettings` | UI | `{settings}` (sanitized on arrival) | `{settings}` as actually stored |
| `stats` | content | `{event, category?, action?, kind?}` | `{ok}` |
| `getStats` | popup | — | `{stats}` |
| `testText` | options | `{text}` | `{scores, signals, decision}` |
| `settingsChanged` | worker → tabs | `{settings}` | — (broadcast) |
| `security.status` | UI | — | `{status: {mode, unlocked}}` |
| `security.enablePassphrase` | options | `{passphrase}` | `{ok}` / `{ok:false, error}` |
| `security.unlock` | popup | `{passphrase}` | `{ok, settings}` / `{ok:false, error}` |
| `security.lock` | UI | — | `{ok}` |
| `wipe` | options | — | `{ok}` |

---

## Storage records

All in `chrome.storage.local`, all AES-256-GCM envelopes except the one noted.
The record name doubles as the AAD binding, so envelopes cannot be swapped
between slots.

| Record | Contents | Encrypted |
| --- | --- | --- |
| `settings` | The sanitized settings object | ✅ |
| `secrets` | Generic secret map — reserved for the subscription license key | ✅ |
| `stats` | Daily + all-time counters, by category and action | ✅ |
| `install` | Random install id (for future license binding) + salt, creation time | ✅ |
| `wrappedKey` | AES-KW-wrapped data key + PBKDF2 parameters (passphrase mode only) | ➖ self-protecting by construction; stored raw **because** reading it must be possible before any key exists |

Key-mode detection at boot reads only `wrappedKey`'s presence — never a field
inside an encrypted record (that ordering was a real bug once; the
vault-migration tests pin it).

---

## Extension recipes

**Add a detection pattern** — add the regex + weight + `why` string to the
right list in `lexicon.js`; match slur-like single terms against the
de-obfuscated form, phrases against the normalized form. **Always add a
false-positive guard test next to the detection test** — the guards have
caught real bugs ("white power washer", sarcastic triple parentheses, the
Maine Coon).

**Add a category** — one entry in `taxonomy.CATEGORIES` plus a default in
`DEFAULT_SETTINGS.categories`. Scorer, settings validation, popup, and
options all pick it up automatically.

**Fix a broken selector** — everything platform-specific is one table
(`PLATFORM_RULES`) in `extractors.js`. Stay on ARIA roles and semantic tags;
never use generated class names.

**Add a stored secret** (e.g. the license key) — `Settings.setSecret(name,
value)`. Encrypted, migration-safe, and covered by existing tests.

**Rebrand** — tokens at the top of `ui.css` (pages), `:root` block in
`overlay.css` (injected UI), gradient constants in `scripts/make-icons.js`
(then re-run it).

---

## Testing strategy

`npm test` — Node's built-in runner, zero dependencies, ~190 tests.

| Suite | Covers |
| --- | --- |
| `text.test.js` | Normalization, every de-obfuscation evasion, boundary preservation (regression: cross-word slur collision), fingerprint properties |
| `lexicon` via `scorer.test.js` + `dogwhistle.test.js` | Detection per category, obfuscated variants, mitigation, false-positive guards for every risky pattern, threshold/action decisions, perf budget |
| `crypto.test.js` | Round-trips, IV freshness, tamper/AAD/downgrade rejection, non-extractability (asserts `exportKey` fails), passphrase wrap/unlock, lock semantics, perf budget |
| `store.test.js` | Ciphertext-only-on-disk, corrupt-record fail-safe, record-swap rejection, locked-vault error propagation |
| `settings.test.js` | Whitelist sanitization edge cases, legacy-field dropping, secret slot |
| `vault-migration.test.js` | The device→passphrase flow's three historical data-loss bugs, pinned as behaviour tests |
| `extractors.test.js` / `apply.test.js` | DOM discovery, draft/own-UI exclusion, ad detection, idempotence, reveal stickiness — against the stub DOM |
| `icons.test.js` | CRC vector, RGBA output, PNG structure, manifest ↔ disk consistency |

Two conventions worth keeping: **Web Crypto is never mocked** (the tests
exercise the same primitives Chrome ships), and **every lexicon addition
carries a false-positive guard**.
