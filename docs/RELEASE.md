# Release process

How a commit becomes a Chrome Web Store release. valyou has no build step, so
"packaging" is a curated zip — the discipline is in the checklist, not the
tooling.

---

## Versioning

Semantic-ish, tracked in **two places that must match**: `manifest.json`
`version` and `package.json` `version`.

| Bump | When |
| --- | --- |
| Patch | Lexicon additions, selector fixes, copy, styling |
| Minor | New user-facing capability (surface, category, setting) |
| Major | Storage/envelope format changes, permission changes, licensing milestones |

Chrome versions are strictly numeric dotted (no `-beta` suffixes). The Web
Store rejects uploads whose version does not increase.

## Pre-release checklist

- [ ] `npm test` — full suite green
- [ ] `node --check` over all JS (browser-only files included)
- [ ] Version bumped in `manifest.json` **and** `package.json`; CHANGELOG.md
      entry written
- [ ] Icons present and matching (covered by `icons.test.js`, but eyeball the
      16 px toolbar render after any mark change)
- [ ] Manual smoke pass on a real account: feed post hidden with visible
      bar, blur + reveal works and sticks, DM surface toggle respected,
      options edits re-apply live to an open tab, badge counts
- [ ] UI screenshots re-taken if anything visual changed (both themes) — see
      [UI-DESIGN.md](UI-DESIGN.md § Verifying changes)
- [ ] Permissions diff vs. the previous release is empty — or the store
      listing text and SECURITY.md were updated to match, and you are
      prepared for Chrome's re-review + the "new permissions" user prompt
- [ ] Selector spot-check: load each supported site, confirm units are being
      found (`document.querySelectorAll('[data-valyou]').length` in the
      content-script console)

## Packaging

Ship only what runs. From the repo root:

```sh
VERSION=$(node -p "require('./manifest.json').version")
zip -r "valyou-$VERSION.zip" manifest.json icons src \
  -x "*.DS_Store"
```

Explicitly **excluded**: `test/`, `scripts/`, `docs/`, `training-data/`,
`*.md`, `package.json`, `.git*`. None are referenced by the manifest; shipping
them only inflates review surface. Note `src/model/model-data.js` (the trained
ML weights) **is** under `src/` and ships; the raw `training-data/` corpus is
gitignored and must never be packaged.

Sanity-check the artifact: unzip to a temp dir and "Load unpacked" — Chrome
validates the manifest and file references on load.

## Publishing from the terminal

`scripts/publish-chrome.js` does the packaging above, then uploads and submits
through the Chrome Web Store API (v2). It refuses to run when the suite is red,
when `manifest.json` and `package.json` disagree, or when the version is
already the published one.

```sh
npm run release:chrome                  # test, package, upload, submit at 100%
npm run release:chrome -- --percent 10  # staged rollout; later: -- --rollout 100
npm run release:chrome -- --upload-only # upload, submit by hand from the dashboard
npm run release:chrome -- --status      # what the store holds right now
npm run release:chrome -- --dry-run     # package and check, touch nothing remote
```

**One-time setup** (credentials land in `.cws.env`, git-ignored, owner-only):

1. Google Cloud console: create or pick a project, enable the
   **Chrome Web Store API**, set up the OAuth consent screen (External; add
   your own Google account as a test user), then Credentials → OAuth client
   ID → application type **Desktop app**. Note the client ID and secret.
2. Chrome Web Store developer dashboard → **Account**: note the Publisher ID.
3. `npm run release:chrome:auth` — asks for those three values, opens the
   consent page, and stores the resulting refresh token. It ends by reading
   the item's status from the store, so a bad credential fails here, not
   mid-release.

The item ID defaults to valyou's (`jileiaojeklemggbieacomlbbnmhpdgd`);
`CWS_ITEM_ID` in `.cws.env` or the environment overrides it, as does every
other `CWS_*` value.

## Store listing notes

- The privacy questionnaire answers follow from the architecture: **no data
  collected, no data transmitted** — content is processed on-device and
  discarded; storage is settings/counters only, encrypted. Keep the listing's
  privacy tab consistent with SECURITY.md, and never weaker.
- Single purpose statement: "filters hateful, violent, and rage-baiting
  content out of the user's own social feeds." Everything in the extension
  serves it; keep it that way — the Web Store rejects scope creep.
- Justify each host permission in the review notes (the filtered social sites =
  the filtering surface; no others).

## Rollout

The Web Store supports staged rollout — use it for anything
touching storage formats or selectors (the two historical bug magnets):
10% → watch reviews/support for a cycle → 100%.

**Storage-format changes get a migration, not a wipe.** Users' tuned
thresholds and block lists are the product's accumulated value; treat
`ENVELOPE_VERSION` bumps per CRYPTO-SPEC (old records read as absent — so
carry data forward *before* flipping formats, in the same release).

## Hotfix path

Selector breakage (a site restructured) is the expected emergency. It is a
patch release: fix `PLATFORM_RULES`, add/adjust the extractor test fixture,
smoke on the live site, ship. The failure mode users see is "stopped
filtering", never "broke the page" — which buys time but doesn't excuse
slowness; filtering silently off is a trust wound for this product.
