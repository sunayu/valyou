# Cryptography specification

The precise, implementation-level companion to [SECURITY.md](../SECURITY.md)
(which covers the threat model and rationale). This document specifies the
formats and state machines exactly, so the implementation in
`src/lib/crypto.js` and `src/lib/store.js` can be audited against it — and
reimplemented from it if ever needed.

---

## Record envelope (version 1)

Every value persisted through `Store.set()` is sealed into:

```json
{
  "v": 1,
  "alg": "A256GCM",
  "iv": "<base64url, 12 bytes>",
  "ct": "<base64url, ciphertext ‖ 16-byte GCM tag>"
}
```

| Field | Spec |
| --- | --- |
| `v` | Envelope format version. Decrypt rejects anything ≠ `ENVELOPE_VERSION` (currently 1) **before** touching the key — format downgrade is not negotiable |
| `alg` | Fixed `"A256GCM"`. Rejected otherwise |
| `iv` | 96-bit value from `crypto.getRandomValues`, fresh per encryption, never reused. 96 bits is GCM's native size (avoids the GHASH-derived-IV path) |
| `ct` | WebCrypto AES-GCM output: ciphertext with the 128-bit authentication tag appended |

**Plaintext** is `UTF-8(JSON.stringify(value))`.

**AAD** is `UTF-8("valyou:v" + version + ":" + recordId)` — e.g.
`valyou:v1:secrets`. Binding the record id means a validly-encrypted envelope
copied into a different slot fails its tag check (record-swap defence);
binding the version makes the version field tamper-evident, not just checked.

**base64url** is RFC 4648 §5, padding stripped (`Text.toBase64Url`).

Decryption failures of any kind — bad tag, wrong slot, wrong version, missing
fields — surface as a single `DECRYPT_FAILED` error, and `Store.get()` maps
that to "record absent, use fallback". The one exception is `LOCKED`, which
propagates, because the caller must react (prompt for the passphrase) rather
than silently run on defaults.

## Key hierarchy

```
                       device mode                    passphrase mode
                       ───────────                    ───────────────
 user secret                —                         passphrase
                                                          │ PBKDF2-HMAC-SHA-256
                                                          │ 600,000 iter, 16-byte salt
                                                          ▼
 key-encryption key         —                         AES-KW-256 (wrap/unwrap only)
                                                          │
                                                          ▼ AES-KW
 data key            AES-256-GCM CryptoKey  ◄────  same key, wrapped blob on disk
                     non-extractable,
                     stored in IndexedDB
                     (structured clone)
                            │
                            ▼
 records             AES-256-GCM envelopes (above)
```

- The data key is always **non-extractable** when long-lived. In passphrase
  setup it exists extractable only inside `createWrappedKey()` long enough to
  be wrapped, then is re-imported non-extractable. `unlock()` unwraps
  **directly into** a non-extractable handle.
- IndexedDB storage of a CryptoKey goes through structured clone — the
  material never transits JavaScript. `test/crypto.test.js` asserts
  `exportKey` on our own key rejects.

## Wrapped-key blob (passphrase mode)

Stored **unencrypted** under the `wrappedKey` record — necessarily, since
reading it must be possible before any key exists. It is self-protecting:

```json
{
  "v": 1,
  "kdf": "PBKDF2-SHA256",
  "iterations": 600000,
  "salt": "<base64url, 16 bytes>",
  "wrapped": "<base64url, 40 bytes = AES-KW(256-bit key)>"
}
```

- Iterations: default 600,000 (OWASP 2023 guidance for PBKDF2-SHA-256);
  `Settings.sanitize` enforces a hard floor of 210,000 — a stale or hostile
  settings record cannot weaken the KDF. Argon2id would be preferred but is
  not in the WebCrypto standard set.
- A wrong passphrase produces a KEK that fails AES-KW's integrity check;
  `unlock()` maps that to `BAD_PASSPHRASE`.
- Only `Store.getRaw`/`setRaw` may touch this record. They exist for it alone.

## Key-mode state machine

```
                 ┌─────────────┐  enablePassphrase   ┌──────────────────┐
   first run ──► │   device    │ ──────────────────► │ passphrase:locked │ ◄─┐
                 │ (unlocked)  │                     └────────┬─────────┘   │
                 └─────────────┘                        unlock│      lock / │
                        ▲                                     ▼   worker    │
                        │  wipe                     ┌──────────────────┐    │
                        └────────────────────────── │passphrase:unlocked├───┘
                                                    └──────────────────┘
```

**Boot-time mode detection reads only the presence of the `wrappedKey` blob**
— never a field inside an encrypted record. (Reading the mode from encrypted
settings was a real bootstrap deadlock once; `test/vault-migration.test.js`
pins the corrected rule.)

## Migration: device → passphrase

Order is load-bearing; a crash at any step must leave data recoverable.

1. Read every record out **under the old key** (`settings`, `secrets`,
   `stats`, `install`).
2. Mint the new data key; write the wrapped blob via `setRaw`.
3. Re-encrypt and write every carried record under the new key.
4. `destroyDeviceKey()` — remove the old key from IndexedDB, **last**.

A crash before step 4 leaves the old key intact and every record readable
(the blob is overwritten on retry). Step 4 is also the security payoff: after
it, disk fragments encrypted under the old key are permanently unreadable.

Historical note: this flow shipped with three data-destroying bugs on the
first attempt (no re-encryption; blob written through the encrypting path;
mode read from encrypted settings). All three are pinned as behaviour tests.

## Wipe

`Store.wipe()` (clear both storage areas) → `destroyDeviceKey()` → reset mode
to `device`. Key destruction comes **after** the clear so that anything the
browser's LevelDB leaves physically on disk is ciphertext without a key —
cryptographic erasure rather than trusting the filesystem to actually delete.

## Primitive inventory

| Purpose | Primitive | Parameters |
| --- | --- | --- |
| Record encryption | AES-256-GCM (WebCrypto) | 96-bit random IV, 128-bit tag, AAD as above |
| Key wrap | AES-KW, 256-bit (RFC 3394) | via WebCrypto `wrapKey`/`unwrapKey` |
| KDF | PBKDF2-HMAC-SHA-256 | 600k iterations (≥210k), 128-bit salt |
| Hashing | SHA-256 | salted content fingerprints (`Text.fingerprint`) |
| Randomness | `crypto.getRandomValues` | IVs, salts, install id |

No primitive is hand-rolled; everything is the platform's WebCrypto. The
tests run against Node's implementation of the same specification —
deliberately unmocked, so a broken assumption fails loudly.

## Rules for future changes

- **Never reuse an IV.** If envelope format ever changes to deterministic or
  convergent encryption for dedup, stop and reread the GCM literature first.
- **Bump `ENVELOPE_VERSION`** for any format change; old records then read as
  absent by design. Provide migration only if the data matters.
- **New records get their own id** (= their own AAD) in `taxonomy.RECORDS`.
- **No new plaintext records.** `getRaw`/`setRaw` are for the wrapped-key
  blob; a second use case needs a design review, not a call site.
- Secrets in memory: JS strings cannot be zeroized; keep passphrases in
  single-field boxes, `Crypto.scrub()` them promptly, and never put secrets
  in the DOM longer than the interaction needs.
