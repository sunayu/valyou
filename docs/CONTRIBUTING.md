# Contributing / engineering standards

The working agreements for changing valyou. Short version: no dependencies,
no network, every risky change carries a test, and comments explain *why*.

---

## Setup

```sh
git clone <repo> && cd valyou
npm test        # that's the whole setup — no install step exists
```

Load the extension via `chrome://extensions` → Developer mode → Load
unpacked → repo root. After editing, press the reload icon on the extension
card; content scripts re-inject on the next page load.

Requirements: Node ≥ 20, Chrome ≥ 116.

## Non-negotiables

These are product guarantees, not preferences. PRs that break them don't
merge, whatever else they deliver:

1. **Zero dependencies.** No npm packages — runtime, build, or test. The
   supply-chain attack surface of this product is the point; keep it empty.
2. **Zero network.** No fetch, no host permission beyond the filtered sites,
   `connect-src 'none'` stays. valyou must never depend on any external
   service (see the subscription plan in [LICENSING.md](LICENSING.md) for
   the one carefully-scoped future exception).
3. **No plaintext at rest.** Everything persisted goes through
   `Store.set()`. The single `setRaw` exception is specified in
   [CRYPTO-SPEC.md](CRYPTO-SPEC.md); a second one needs a design review.
4. **Content scripts stay untrusted.** No secrets, no storage access, no new
   capabilities on the page side without validating every input in the
   worker.
5. **Nothing vanishes silently.** Any new treatment must label itself and
   offer reveal; reveals stay sticky.
6. **The scan path stays synchronous and budgeted.** `scoreText` < 0.25 ms —
   it's a test, and it fails honest work that gets too clever.

## Code style

- Vanilla JS, classic scripts, the UMD shim for anything in `src/lib/` (the
  same bytes must load via `importScripts`, manifest injection, and
  `require`).
- JSDoc on every exported function: parameters, return, thrown error codes.
- Comments explain **why** — constraints, trade-offs, defeated attacks —
  never narrate what the next line does. The codebase's comment density is
  the standard; match it.
- Errors that callers branch on carry a `code` (`LOCKED`, `BAD_PASSPHRASE`,
  `DECRYPT_FAILED`) — never make callers parse message strings.
- Naming: modules are nouns (`scorer`), functions verbs (`decide`),
  booleans readable as predicates (`needsWork`).

## Change recipes

The step-by-step for each common change lives with its subject:

| Change | Guide |
| --- | --- |
| Detection pattern / category | [CLASSIFIER.md](CLASSIFIER.md) § Tuning + [TESTING.md](TESTING.md) § Recipes |
| Broken/new site selector | `PLATFORM_RULES` in `extractors.js`; ARIA roles and `data-testid` only, never generated class names |
| Storage record | [CRYPTO-SPEC.md](CRYPTO-SPEC.md) § Rules — own record id, migration list, tests |
| UI | [UI-DESIGN.md](UI-DESIGN.md) — tokens first, screenshot both themes |
| Message type | Validate hostile payloads worker-side; document in ARCHITECTURE § protocol |

## PR checklist

- [ ] `npm test` green; new behaviour has tests; risky patterns have
      false-positive guards
- [ ] `node --check` passes on every touched JS file (the browser-only files
      never load under the test runner)
- [ ] No new permissions, hosts, or CSP loosening — or the PR explains why in
      the description *and* updates SECURITY.md
- [ ] Docs updated when behaviour moved: API.md for signatures,
      ARCHITECTURE.md for flows/records/messages, CHANGELOG.md always
- [ ] UI changes: screenshots attached, light + dark
- [ ] License header on any new source file (GPL-3.0-or-later, Sunayu LLC)

## Commit conventions

Imperative subject lines, scoped where useful ("lexicon: add nativist
expulsion patterns"). A fix that closes a bug names the failure in the body.
No attribution trailers or generator markers of any kind.
