# Changelog

All notable changes to valyou. Format follows Keep a Changelog; versions
follow the scheme in [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased]

## [1.0.1] — 2026-09-09

### Changed
- On a desktop (Chrome, Brave, Safari on a Mac) filtered posts and gated
  videos now reveal with a plain click on the "Show" button, bar or shield.
  The right swipe is reserved for touch screens — the iOS app and any phone —
  where a tap is too easy to make by accident while scrolling. The engine
  picks the control from the device's input (a fine pointer that can hover
  gets the click); the mobile app pins the swipe explicitly.

### Fixed
- The swipe itself, on touch devices with a fine pointer or a stylus: a drag
  that started on the "Swipe right" button could be dropped a few pixels short
  of the threshold, the swipe/scroll decision now waits for a few pixels of
  real movement instead of the first jittery one, and the bar or shield
  visibly follows the finger (the enter animation had been overriding that
  feedback).

## [1.0.0] — 2026-08-12

First release. valyou filters racist, sexist, violent, harassing and
rage-baiting content out of Facebook, Instagram and X — entirely on the device,
with no servers, no accounts and no telemetry — as a Chrome/Brave extension, a
Safari extension, and an iOS app (a browser that filters as you scroll). An
Android build is ready but not yet published.

Everything below 1.0.0 was pre-release; this entry is what a user actually gets.

### The engine
- Lexicon of slurs, threats, dehumanisation and rage-bait shapes, combined with
  noisy-OR so evidence accumulates without manufacturing false certainty.
- A five-head on-device model (racial hate, gendered hate, violence,
  harassment, rage bait) trained on ~530k labelled rows, held-out AUC
  0.90–0.995, each head with its own measured confidence floor. Its influence
  is capped below every default threshold, so it can strengthen pattern
  evidence but can never filter anything on its own.
- Per-category action (hide / blur / tag) and sensitivity, per-surface toggles,
  author allow-list and custom block/allow terms.

### Reading Facebook, which does not want to be read
- Units are found through ARIA rather than class names, with a last-resort rule
  that matches Facebook's text markup so a caption is caught in any shell —
  feed, theater, reshare, permalink or search result.
- Text is read wherever it lives, including bare text nodes beside emoji spans.
- Covers grow to the whole card so a post's subject line is hidden with its
  body, and stop before ever swallowing a neighbouring post.
- Site chrome — search field, dropdown, navigation — is never filtered, so
  searching for a flagged word does not blur the user's own query.

### Video
- Autoplay is stopped before a frame renders by guarding all four entry points:
  play(), the autoplay property, the autoplay attribute, and parser-inserted
  markup. Closed shadow roots are opened so the player can be seen at all, and
  a detached player — created in JavaScript and never inserted — is refused.
- A deliberate tap still plays, because valyou starts the video itself rather
  than waiting for a page whose own attempt was already blocked.

### Revealing
- Filtered content is revealed with a right swipe, not a tap: a stray thumb
  while scrolling should not undo the protection the user asked for. Keyboard
  and screen-reader users press Enter instead.

### Privacy
- No network permission at all, enforced by the browser rather than by policy.
- Post text is never stored; statistics are counters with nothing attached.
- Settings are encrypted at rest, keyed by hardware, device-only.

### Licensing
- GNU GPL v3.0 or later, with an App Store distribution exception so it can
  ship through Apple's and Google's stores.


## [0.2.0] — 2026-08-08

### Changed
- **Licensing: valyou is now free software under the GNU GPL v3.0 or later**
  (previously Apache-2.0), with an App Store distribution exception under GPLv3
  section 7 so it can ship through Apple's and Google's stores whose DRM,
  signing and installation terms would otherwise conflict. See `LICENSE` and
  `LICENSE-EXCEPTION`. Vendored third-party files keep their upstream terms.
- **The ML assist is now five classifiers, one per harm** (racial hate,
  gendered hate, violence, harassment, rage bait) instead of a single "hate"
  score smeared across three categories. Trained on ~530k labelled rows from
  civil_comments, EDOS/SemEval-2023, HateXplain, Davidson and Stop Clickbait
  (was ~25k), over richer features (character 5-grams as well as 3/4). Every
  head is high precision at its own measured floor (0.90–0.98, versus 0.34 for
  the single v1 head) and each head's evidence now routes to its own category.
  All five heads still score a post in ~0.02 ms, and the assist remains capped
  below every default threshold, so it can never filter anything by itself.
- Manifest description now names X, which the extension has always filtered.

### Fixed
- **Facebook post text was frequently not read at all.** Text was collected only
  at leaf elements, but Facebook renders a caption as a bare text node whose
  siblings are emoji/link spans — so the caption was skipped and posts were
  judged "clean" on their metadata. Text nodes are now read wherever they sit.
- **Hiding covered only the post body**, leaving the card header / subject line
  readable, because Facebook renders it as a sibling of the article. Covers now
  expand to the outermost wrapper exclusive to that post — without ever
  swallowing a neighbouring post, an enclosing post, or site chrome.
- Post expansion was blocked entirely by Facebook's own nested comment-preview
  articles; units nested inside the post itself no longer count against it.
- **Captions in theater / permalink / reshare views were never scored**, because
  they sit outside any `role="article"`. Added a dialog rule and, as a
  structure-independent backstop, a last-resort rule on Facebook's text markup
  so a caption is caught whichever shell holds it.
- Searching for a flagged word blurred the user's own search box, dropdown and
  results heading. Site chrome (search, navigation, menus, toolbars, headers) is
  now never treated as content.


### Fixed
- Facebook videos stopped autoplaying but stayed visible. Stopping autoplay was
  unit-agnostic (it pauses any `<video>`), but *covering* required finding the
  enclosing post — and Facebook plays many videos outside a recognized post
  (theater view, Reels), so `enclosingUnit` returned null and nothing was
  blurred. Covering is now unit-agnostic too: `coverVideoElement` blurs the
  whole post when one is recognized, else the video's own container. A single
  `sweepVideos` pass (run on every scan) covers and pauses every video under
  `hide`, catching lazy players, the boot race, and off-feed surfaces; the play
  guard uses the same covering path. (Replaces the earlier lazy-mount re-gate,
  which only handled videos already inside a cleared post.)

### Added
- **Mobile app (iOS + Android)** in `mobile/`. valyou now ships as a
  content-filtering browser built on React Native + `react-native-webview`: the
  user browses the mobile web versions of the supported networks *through*
  valyou, and the same engine (classifier, lexicon, on-device ML, blur/hide,
  video gating) is injected into each page — no forked copy. Native app filtering
  is impossible on mobile (both OSes sandbox apps; Android's AccessibilityService
  route violates Play policy), so a filtering browser is the only store-approvable
  architecture. Settings live natively, encrypted at rest in the OS keystore
  (Secure Enclave / Android Keystore, device-only, never cloud-synced), are
  pushed read-only into the untrusted page, and only counter events come back —
  the extension's trust model, unchanged. `mobile/scripts/build-bundle.js`
  produces the injectable bundle; `test/mobile.test.js` runs that exact bundle in
  a sandboxed DOM (part of the suite) and confirms it hides a hateful Facebook
  post, gates video behind a tap, injects the overlay CSS, and reports over the
  native bridge. See `mobile/README.md` for the architecture, build steps, and
  the store-submission risks (no third-party branding, embedded-WebView login,
  App Store §4.2 minimum-functionality).
- **Mobile: native projects build on both platforms.** The RN 0.76.5 iOS and
  Android projects are generated under `mobile/app/`. iOS: `pod install` (66
  pods) + a Release `xcodebuild` compile clean, and the app installs, launches,
  and runs on the iPhone 17 simulator (bundle id `com.valyou`). Android:
  `./gradlew :app:assembleDebug` (SDK 35, NDK 26.1) compiles clean and produces
  `app-debug.apk` (`applicationId com.valyou`).
- **Mobile: store-quality app icons** generated from the brand shield for both
  platforms (`mobile/scripts/make-app-icons.js`, `npm run icons`): alpha-free
  iOS icon set incl. the 1024 marketing icon, Android adaptive + legacy mipmaps,
  and a 512 Play hi-res icon — all dependency-free, reusing the extension's icon
  renderer.
- **Mobile: store submission kits + privacy policy.** `mobile/store/APP-STORE.md`
  and `mobile/store/PLAY-STORE.md` (listings, nutrition/Data-Safety answers =
  no data collected, review notes addressing §4.2 and Play's no-AccessibilityService
  positioning) and `mobile/PRIVACY.md`.
- **Mobile: Facebook mobile-web fallback + hardened WebView.** Added a
  provisional `<article>` extractor rule for `m.facebook.com`'s touch DOM (x.com
  and instagram.com already work as responsive single sites); enabled persistent
  login cookies and WebView debugging (for on-device selector verification).
- Facebook coverage: also catch feed stories that never expose an inner
  `role="article"` (suggested posts, some media/reel stories, certain
  sponsored formats) via the `div[role="feed"] div[aria-posinset]` wrapper, with
  a `skipIfContains` guard so stories that do have an article aren't processed
  twice. Extractor rules gained an optional `skipIfContains` field.
- **All videos are blocked by default**, and you must select one to play it.
  The default video mode is now `hide`: every video is covered — nothing plays
  or even shows its still frame — until you click to play, and that one click
  reveals *and* starts the video you chose (approve + `play()` within the user
  gesture). Text posts are untouched. `Don't autoplay` (paused-but-visible) and
  `Allow` remain as options. Default changed from `block` to `hide`.
- Flagged videos blur by default (`media.flaggedVideoBlur`, on). When the
  classifier flags a video post, it is shown as a frosted click-to-reveal blur
  rather than obeying the category's action (which for hate/violence is a
  collapse-to-bar "hide"). Blur is the natural media treatment and still needs
  a click to see; the category reason is preserved. Non-video posts are
  unaffected, and the option can be turned off. Surfaced in Videos settings.
- Video handling (`media.video`: allow / block / hide, **default block**).
  Autoplay control is now its own reliable mechanism rather than a side effect
  of filtering:
  - **block** (default) stops every video from autoplaying — paused and muted
    until a real click plays it. A capturing `play`-event guard catches every
    autoplay attempt, `pauseStrayVideos` sweeps videos already rolling before
    the guard installed (the boot race), and `navigator.userActivation`
    distinguishes a genuine click (allowed) from autoplay (blocked), so
    click-to-play works.
  - **hide** additionally blurs the video post behind a click.
  - **allow** restores autoplay.
  Caption-less videos are surfaced to the pipeline (previously dropped for
  short text) so block/hide can act on them. Legacy mode names
  (normal/strict/always) migrate to allow/block/hide.

### Changed
- New logo: the mark is now a **shield carrying the "v"** instead of a letter
  on a rounded square — it says what the product is (protection / filtering)
  and the v-in-crest reads as a checkmark (vetted/safe). Still fully generated
  and license-free (procedural SDF → hand-written PNG, zero dependencies);
  regenerated at all sizes and propagated to the in-app header marks.
- Replaced the earlier normal/strict/always video modes. "Strict" (silently
  lowered thresholds) was removed — it neither matched its name nor stopped
  autoplay, which caused a real "videos still autoplay" report. Autoplay
  blocking is now explicit, default-on, and does not depend on the filtering
  threshold.
- On-device ML assist (`src/lib/ml.js` + bundled `src/model/model-data.js`):
  a dependency-free logistic-regression model over hashed n-grams that
  generalizes past the pattern rules. Capped below every action threshold so
  it can only reinforce patterns, never filter alone; toggleable in options,
  on by default. Trained offline from an MIT-licensed corpus via
  `scripts/{fetch-training-data,train-model}.js`. Honest performance and bias
  discussion in docs/ML.md.
- X (x.com / twitter.com) support: posts, replies, promoted-tweet detection,
  and direct messages join Facebook, Messenger, and Instagram.
- Media text signals: image `alt` text (including Instagram's auto-generated
  content descriptions) and video `aria-label`/`title` now feed the
  classifier, so a hateful meme under a bland caption is scoreable.
- Full engineering docs continued: docs/ML.md.

### Fixed
- Videos inside hidden or blurred units are now paused and muted, with a
  guard that re-pauses autoplay resumes while the unit stays filtered.
  Previously a "hidden" video could keep playing its audio behind
  `display:none`. Reveal restores the mute state valyou imposed (and only
  that), leaving playback a deliberate user action.
- Full engineering documentation set under `docs/`: classifier internals,
  cryptography specification, module API reference, UI design system,
  testing guide, contribution standards, release process, and the
  subscription/licensing integration plan.

## [0.1.0] — 2026-08-01

Initial version.

### Added
- On-device classifier for five categories — racism/ethnic-religious hate,
  sexism/gender hate, violence & threats, harassment, rage bait — with
  per-category action (hide / blur / label / ignore) and sensitivity.
- Evasion-resistant text pipeline: NFKC, zero-width stripping, leetspeak and
  homoglyph folding, letter-spacing weld, stretch collapse — all
  word-boundary preserving.
- Structural detection templates, slur list, extremist dogwhistle & coded
  hate coverage (numeric codes, meme phrases, conspiracy slogans,
  co-occurrence smears), rage-bait mechanics; mitigating signals protect
  quotation, news reporting, and counter-speech (capped damping).
- Surfaces: feed, comments, ads/sponsored, direct messages, reels — each
  independently toggleable; author allow list; user block/allow terms with
  obfuscation-resistant matching.
- Visible, reversible treatments: labelled collapse bar, frosted blur shield,
  badge; reveals are sticky; explanations name the strongest signal.
- Encryption at rest for everything stored (AES-256-GCM envelopes, per-record
  AAD): settings, counters, secrets. Device-key mode (non-extractable
  CryptoKey) and opt-in passphrase mode (PBKDF2 600k → AES-KW), including
  safe migration and cryptographic-erasure wipe.
- Zero-network architecture: no host permissions beyond the filtered sites,
  `connect-src 'none'`, no dependencies, no build step.
- Popup (master switch, daily/all-time counters, category toggles, vault
  unlock) and options page (full tuning, live "try it" scorer, security
  modes, data deletion) on a tokenized design system, light + dark.
- Brand icon set generated by a dependency-free SDF/PNG renderer
  (`scripts/make-icons.js`).
- ~190-test suite (Node built-in runner, no dependencies): real WebCrypto,
  dependency-free DOM stub, false-positive guards for every risky pattern,
  performance budgets as tests, behaviour tests pinning historical bugs.

### Security
- Threat model and design documented in SECURITY.md; specification-level
  detail in docs/CRYPTO-SPEC.md.
