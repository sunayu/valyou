# Testing guide

How the suite works, the conventions that keep it honest, and how to add
tests for each kind of change. ~190 tests, zero dependencies, sub-second run.

---

## Running

```sh
npm test              # full suite (node --test "test/*.test.js")
npm run test:watch    # re-run on change
npm run test:coverage # with V8 coverage

node --test test/scorer.test.js            # one file
node --test --test-name-pattern="slur"     # by name
```

Requires Node ≥ 20 (`node:test` runner, WebCrypto, `structuredClone`).

## Architecture of the suite

The production modules were built with **injectable seams** instead of
mocking frameworks:

- `Crypto.configure({keyStore, mode})` — swaps IndexedDB for an in-memory
  CryptoKey store.
- `Store.configure({local, session})` — swaps `chrome.storage` for in-memory
  areas that JSON-round-trip on write (so anything unserializable fails
  loudly, as real `chrome.storage` would).

`test/helpers/env.js#setupEnv()` wires a **fresh, isolated environment per
test** — new storage, new key store — so no test can leak encrypted state or
a key into another. Call it at the top of every test that touches
storage/crypto/settings.

Two deliberate non-mocks:

1. **Web Crypto is never mocked.** Node implements the same spec Chrome
   ships, so the crypto tests exercise real AES-GCM, PBKDF2, and AES-KW. A
   mock here could hide a real vulnerability.
2. **The DOM stub is minimal, not jsdom.** `test/helpers/dom.js` implements
   exactly what `extractors.js`/`apply.js` use (tree, attributes, classList,
   events, and a small selector engine: tag/class/`[attr]`/`[attr="v"]`/
   `[attr*="v"]`, descendant chains, comma groups). Anything missing throws a
   TypeError rather than silently passing — a missing stub method means the
   test wasn't testing anything.

The service worker itself cannot load outside Chrome (`importScripts`,
`chrome.*`). Its critical flows are pinned as **behaviour tests** that
reproduce the logic against the real lib modules — see
`test/vault-migration.test.js`, which encodes the device→passphrase sequence
and its three historical data-loss bugs. If you change the worker's flow,
change the behaviour test to match *first*, then the worker.

## Suite map

| File | Focus |
| --- | --- |
| `text.test.js` | Normalization, each evasion technique, boundary preservation (the cross-word slur regression), base64url edge lengths, fingerprint properties |
| `scorer.test.js` | Benign-content zero-scores, detection per category, obfuscated slurs, mitigation (incl. the cap), user rules, decision logic, noisy-OR properties, perf budget |
| `dogwhistle.test.js` | The coded-hate lexicon: detection + a false-positive guard for every risky pattern |
| `crypto.test.js` | Envelope round-trips, IV freshness/size, AAD/tamper/downgrade rejection, non-extractability, passphrase wrap/unlock/lock, KEK-salt binding, perf budget |
| `store.test.js` | Ciphertext-only-on-disk, corrupt-record fail-safe, record-swap rejection, session/local separation, LOCKED propagation |
| `settings.test.js` | Sanitizer edge cases (clamps, coercions, list hygiene, KDF floor), legacy-field dropping, secret slot |
| `vault-migration.test.js` | The migration sequence, blob-in-the-clear correctness, old-key destruction, boot-time mode detection, wipe-as-cryptographic-erasure |
| `extractors.test.js` | Platform detection (incl. lookalike domains), text reading exclusions, author extraction, ad detection, kind refinement, surface toggles, idempotence |
| `apply.test.js` | Each treatment's DOM effect, no-node-removal invariant, chrome-as-child placement, reveal semantics (sticky, propagation-stopped), state machine |
| `ml.test.js` | Feature determinism (training/serving parity), the signal-weight cap, load schema-version rejection, and — against the shipped model — hate>clean separation, the confidence floor, and the scan-path budget |
| `scorer-ml.test.js` | The assist inside the real scorer: adds a capped signal, **cannot cross a default threshold alone**, only reinforces (never lowers) scores, no false positives on benign posts |
| `icons.test.js` | CRC-32 test vector, RGBA properties, PNG structure, IDAT inflation, manifest↔disk consistency |

## Conventions

**Every risky lexicon addition ships with a false-positive guard beside it.**
Write down the innocent sentence your pattern must not match and assert it
stays clean. The guards have caught real bugs pre-merge ("white power
washer", sarcastic triple parentheses, the Maine Coon).

**Regressions get named tests.** When a bug is fixed, a test pins it with a
comment saying what broke ("an earlier version stripped all whitespace, so
this phrase collapsed to…"). Deleting one of these requires knowing why it
exists.

**Performance budgets are tests, not aspirations.** `scoreText` must stay
under 0.25 ms per realistic post (60-unit scan inside a 16 ms frame);
a crypto round-trip under 5 ms. If a change trips these, the change is wrong,
not the budget.

**Security properties are asserted, not assumed.** Non-extractability is
tested by attempting `exportKey` and expecting rejection; on-disk secrecy by
grepping raw storage for plaintext; record-swap defence by actually swapping
records.

**Tests document intent.** Titles are sentences ("a revealed unit is not
re-processed by a later scan"); comments explain *why* the property matters,
mirroring the production style.

## Adding tests: recipes

**New lexicon pattern** → `dogwhistle.test.js` (or `scorer.test.js` for
templates): one detection assertion through `Scorer.scoreText` with default
settings, one obfuscated variant if slur-like, one false-positive guard.

**New storage record** → `store.test.js`-style round-trip plus a raw-storage
grep proving nothing readable leaks; add the record to the migration list in
the worker **and** to `vault-migration.test.js`'s `RECORDS`.

**New message type** → validate hostile payloads (wrong types, oversized,
missing fields) in a behaviour test; the worker must never trust a content
script.

**New DOM behaviour** → build fixtures with `helpers/dom.js#build()` (tree
literals). If the stub lacks an API the production code needs, extend the
stub with the real DOM's semantics — resist the urge to reach for jsdom.

**UI change** → no automated harness; follow the headless-Chrome screenshot
workflow in [UI-DESIGN.md](UI-DESIGN.md#verifying-changes), both themes.

## CI expectations

Any pipeline needs only:

```sh
npm test
node --check $(git ls-files '*.js')   # parse-check the browser-only files too
```

The parse-check matters because `service-worker.js`, `main.js`, `popup.js`,
and `options.js` never load under the test runner — a syntax error there
would otherwise ship.
