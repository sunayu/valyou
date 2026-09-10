# Security design

## Threat model

**What this defends against.** Anyone who can read the extension's storage files
on disk: another local account, a stolen or lost laptop, a cloud backup, a
forensic image, or malware that can read files but cannot execute code inside the
extension. `chrome.storage.local` is an unencrypted LevelDB on disk by default —
a secret or a browsing-derived record written there in the clear is readable by
anything that can open the file.

**What this cannot defend against.** Code executing inside the extension's own
origin. An attacker who achieves execution in the service worker can simply ask
us to decrypt. Non-extractable keys still limit the damage — the key material
itself cannot be exfiltrated, only used while the attacker has execution — but
that is damage limitation, not prevention.

**Explicitly out of scope.** Chrome itself being compromised; a malicious
extension with `management` or debugger permissions; physical access to an
unlocked, logged-in machine.

---

## Encryption at rest

Every byte valyou persists is sealed before it touches disk. There is no
"write this one in the clear" path — uniform ciphertext means an observer cannot
even tell the settings record from the secrets record by shape.

| Property | Choice | Why |
| --- | --- | --- |
| Cipher | AES-256-GCM | AEAD: authenticates as well as encrypts, so a tampered record fails to decrypt rather than silently yielding attacker-chosen settings. Hardware-accelerated (AES-NI) everywhere Chrome runs. |
| IV | 96-bit, fresh per record | 96 bits is GCM's native size, avoiding the extra GHASH derivation. Never reused — IV reuse under GCM leaks the XOR of plaintexts and can expose the authentication key. |
| Tag | 128-bit | Full-strength authentication tag. |
| AAD | `valyou:v1:<record-id>` | Binds each ciphertext to its slot and format version. An attacker cannot copy the validly-encrypted `settings` blob over `secrets`: decryption supplies different AAD and the tag check fails. |

Measured cost of an encrypt + decrypt round trip on a realistic settings record is
well under a millisecond, which is why the crypto layer never appears in the
interactive path.

## Key management

Two modes, selectable in settings.

### Device key (default)

The AES-256 data key is generated **non-extractable** and stored in IndexedDB via
structured clone. Chrome keeps the key material inside its crypto implementation;
JavaScript — ours or an attacker's — can never read the raw bytes back out, only
pass the handle to `subtle.encrypt` / `subtle.decrypt`. The test suite asserts
this directly: `crypto.subtle.exportKey` on our own key rejects.

No user interaction is required, so background classification works from browser
start.

### Passphrase (opt-in)

The data key is wrapped with AES-KW under a key derived from a user passphrase:

- **PBKDF2-HMAC-SHA-256**, 600,000 iterations, 128-bit random salt. This meets
  OWASP's current guidance for PBKDF2-SHA-256 and costs roughly a quarter second —
  acceptable once per session, prohibitive for offline guessing at scale.
  Argon2id would be preferable but is not exposed by the Web Crypto API.
- The floor is enforced at 210,000 iterations; a stale or hostile settings record
  cannot downgrade key derivation.
- Only the wrapped blob is persisted. Nothing usable exists on disk until unlock.
- On unlock the key is imported **directly into a non-extractable handle** and
  held in memory only. A wrong passphrase fails AES-KW's integrity check, which
  surfaces as a clean `BAD_PASSPHRASE` rather than a cryptic exception.

Strictly stronger at rest, at the cost of one unlock per browser session. The
trade-off is stated in the options UI rather than buried here.

---

## Data minimization

The strongest protection for data is not collecting it.

| Data | Treatment |
| --- | --- |
| Post / comment / message text | **Never persisted, never transmitted.** Scored in memory during the scan and discarded. |
| Author names | Read only to check the allow list. Never persisted, never transmitted. |
| URLs | Never read, stored, or transmitted. |
| Statistics | Counters only — totals per category and action. No content, no timestamps beyond the current day. |
| Secrets (reserved for the subscription license key) | Their own encrypted record, separate from settings, so settings can be exported for support without touching a secret. |

## Data in transit

There is none. valyou makes no network requests: the manifest grants no host
permission beyond the social sites its content scripts run on, and the
extension-pages content security policy sets `connect-src 'none'`, so even a
compromised code path inside the popup, options page, or service worker has no
host it is permitted to contact. This is the strongest available form of the
guarantee — enforced by the browser, not by our code.

Any future subscription/licensing endpoint must be added as an explicit,
narrowly-scoped exception to that CSP and must never sit in the filtering path.

## Privilege separation

Content scripts share an origin with the social sites and are treated as
untrusted callers. They may request settings and report counters. They cannot
reach the encryption key or any stored secret — those live only in the service
worker, and every message crossing that boundary is validated and clamped
before use.

## Failure behaviour

- A record that fails its authentication tag reads as **absent**, and the caller
  falls back to defaults. A tampered record is never partially trusted.
- A locked vault raises a distinct `LOCKED` error rather than being swallowed, so
  the UI can prompt for the passphrase instead of silently doing nothing.
- Every degradation path moves toward **doing less filtering**, never toward
  failing open and showing everything unchecked.

## Dependency advisories

valyou's *shipped* code has no third-party runtime dependencies: the extension
is plain JavaScript, and the app bundle contains only our engine plus React
Native itself. Every advisory GitHub reports against this repository so far has
been in **build-machine tooling**, which never reaches a user's device.

Verified rather than assumed — the shipped iOS JS bundle was searched for each
package and contains none of them:

| Package | Comes from | Reaches a user? |
| --- | --- | --- |
| `image-size` | Metro, the JS bundler | No — runs on the build machine |
| `fast-xml-parser` | React Native CLI (iOS/Android platform tools) | No — build machine |
| `activesupport` | CocoaPods, via `Gemfile` | No — build machine |

The practical impact is limited to a denial of service against a developer who
builds valyou using a maliciously crafted image or XML file — i.e. an attacker
who already controls your source tree. None are directly declared by valyou;
they arrive transitively and are pinned by upstream, so the fix is a React
Native / CocoaPods upgrade rather than a change here.

**When triaging a new advisory, answer these in order:**

1. Is the package in the shipped artifact? Check the built bundle and the
   packaged extension zip, not just `package.json`:

       grep -c "<package>" mobile/app/ios/build-device/**/main.jsbundle
       unzip -l valyou-*.zip

2. If it does ship, treat it as a real vulnerability and fix it before release.
3. If it does not, record it here with its source and move on — silence and a
   dismissed alert look identical six months later.

## Deleting your data

The **Delete everything** control clears both storage areas and then destroys the
encryption key. Clearing first and destroying the key last means any storage
fragments the browser leaves behind on disk are permanently undecryptable.

## Reporting a vulnerability

Open an issue describing the problem and its impact. Please do not include a
working exploit against live user data.
