# Subscription & licensing integration plan

The design contract for adding the commercial layer. This is a **plan**, not
shipped behaviour — nothing in v0.1.x checks a license. It exists so that
when licensing is built, it lands on the prepared seams instead of being
bolted through the product's guarantees.

---

## The prime directive

**Filtering never requires the network, and never will.** The subscription
gates *entitlement*, not *operation*: license validation happens out of band,
its result is cached locally, and the scan path remains synchronous,
on-device, and offline-capable. A user on a plane keeps their filter.

Corollaries:

- License checks may never sit in `main.js`, `scorer.js`, or any per-unit
  code path.
- Network failure degrades toward "keep current entitlement", with a
  generous offline grace window — never toward "stop filtering", and never
  toward "fail open" silently either.
- The one licensing endpoint is added as an explicit, single-host exception
  to the extension-pages CSP (`connect-src 'none'` today) and documented in
  SECURITY.md the same day. Content scripts still get no network, ever.

## What is already built for this

| Seam | Where | Status |
| --- | --- | --- |
| Encrypted secret slot for the license key | `Settings.getSecret/setSecret("licenseKey", …)` | Shipped, tested, migration-safe |
| Stable per-install identity for activation binding | `Settings.getInstall().installId` | Shipped |
| Sanitized settings pipeline to carry entitlement state | `Settings.sanitize` | Extend with a whitelisted `license` block when real |
| Trusted-core message routing for UI ↔ worker | service worker | Add `license.activate` / `license.status` messages |
| Uniform encrypted storage for any cached entitlement | `Store` | Use a new record id (own AAD), per CRYPTO-SPEC rules |

## Recommended shape (when built)

1. **Activation**: user pastes a license key in options → worker calls the
   licensing endpoint once (`license.activate`), sending key + `installId`
   and nothing else — no browsing data exists to send, keep it that way.
   Response: signed entitlement (plan, expiry, seat info).
2. **Storage**: key in the secrets record; the signed entitlement in its own
   encrypted record. Verify the server's signature locally (public key
   shipped in the extension) so a tampered cache is just an invalid one.
3. **Refresh**: background re-validation on a long cadence (days, not
   minutes) with jitter, only from the worker. Offline grace: entitlement
   remains honored for N days past last successful validation (pick N ≥ 14;
   travelers exist).
4. **Enforcement**: at the *feature* layer — e.g. free tier keeps core
   categories, subscription unlocks custom rules/surfaces/updates — decided
   once at settings-load time, not per post.
5. **Lexicon updates as the subscription deliverable**: signed lexicon
   bundles fetched by the worker on the same cadence, verified, stored
   encrypted, merged at load. This monetizes exactly the thing that needs
   ongoing curation (see CLASSIFIER.md § Known limits) while the engine
   stays local.

## What not to build

- **No accounts inside the extension** beyond the license key. Identity
  lives with the payment provider/store; the extension holds a capability,
  not a profile.
- **No telemetry as a licensing side channel.** Validation requests carry
  key + install id, full stop. The "no data collected" store-listing answer
  must stay true after licensing ships.
- **No remote kill switches** for filtering. Expired subscription downgrades
  features; it never turns a safety tool off wholesale without the user
  being told exactly what changed and keeping the free tier.
- **No DRM theater.** The code is readable by anyone who unzips it; the
  licensing design must be honest about that. Signed entitlements + server
  -side seat accounting is the right effort level; obfuscation is not.

## Definition of done for the licensing PR

- CSP exception scoped to exactly one host; SECURITY.md "Data in transit"
  rewritten the same day; store privacy answers re-reviewed.
- Behaviour tests for: activate happy path, tampered entitlement rejected,
  offline grace honored, expiry downgrade messaging, wipe removes key +
  entitlement.
- README's self-contained section updated to state precisely what the one
  network call is, when it happens, and what it carries.
