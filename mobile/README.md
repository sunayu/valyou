<!--
valyou — on-device social media content filtering.
Copyright (C) 2026 Sunayu LLC

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Additional permission under GNU GPL version 3 section 7: this
Program may be distributed through the Apple App Store, Google Play,
or comparable platforms whose terms would otherwise be incompatible
with the GPL. See LICENSE-EXCEPTION.
-->

# valyou — mobile (iOS + Android)

The same content filter as the browser extension, delivered as a real App Store
and Play Store product. This directory contains the shared engine bundle, its
builder, the integration test, and the React Native app that ships it.

---

## Why a filtering browser (and not a native filter)

Mobile operating systems sandbox apps: **one app cannot read or modify the UI of
another.** The Facebook, Instagram, and X native apps are closed boxes — nothing
we ship can reach inside them to hide a post.

Three architectures were considered, and only one is store-approvable:

| Approach | iOS | Android | Verdict |
|---|---|---|---|
| Modify the social-media native apps | Impossible (sandbox) | Impossible (sandbox) | ✗ |
| System accessibility service reading the screen | No such API | Possible, but Play policy forbids using AccessibilityService for content filtering; near-automatic rejection + privacy review | ✗ |
| **A browser that loads the mobile web sites and filters them** | Allowed (WKWebView) | Allowed (android.webkit.WebView) | ✓ |

So valyou mobile is a **content-filtering browser**. It loads
`m.facebook.com`, `instagram.com`, and `x.com` in a `WebView` and injects the
exact same engine the extension uses. The user browses those networks *through*
valyou, and everything hateful/violent/rage-bait is hidden or blurred before it
renders — videos included (hidden until tapped, by default).

This is the identical model Safari/Chrome content-blocker apps and every "focus
browser" on the stores already use, so it is well-trodden review territory —
subject to the risks in the last section.

---

## Architecture

```
┌─────────────────────────── React Native app (trusted core) ───────────────────────────┐
│                                                                                          │
│   App.tsx ── loads encrypted Settings (react-native-keychain) ── SettingsScreen.tsx      │
│      │                                                                                    │
│      │  injectedJavaScriptBeforeContentLoaded = settings preamble + engine bundle         │
│      ▼                                                                                     │
│   ┌──────────────── WebView (untrusted page) ────────────────┐                            │
│   │  m.facebook.com / instagram.com / x.com                   │                            │
│   │  window.__VALYOU__.settings  ← injected, read-only here    │                            │
│   │  valyou-inject.bundle.js: Extractors→Scorer→Apply→ML       │                            │
│   │        │  hides/blurs/gates content in the DOM             │                            │
│   │        └── postMessage({type:"stats", …}) ────────────────┼──► onMessage → recordStat   │
│   └───────────────────────────────────────────────────────────┘     (counters only)        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Trust model (same as the extension).** The WebView page is untrusted. Settings
live natively and are encrypted at rest in the OS keystore (Secure Enclave /
Android Keystore, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, never cloud-synced).
They are pushed *into* the page as a plain object; the page can only send back
**counter events** — never content, author, or URL. Nothing the site or the
injected script does can read the stored settings or the user's data.

**One engine, two shells.** The classifier, lexicon, on-device ML model, blur/
hide logic, and video gating are the extension's files verbatim. The only
mobile-specific pieces are:

| File | Role |
|---|---|
| `inject/mobile-main.js` | Entry point — replaces `content/main.js`. Same scan loop; chrome.* calls swapped for the native bridge (`window.ReactNativeWebView.postMessage`). |
| `scripts/build-bundle.js` | Concatenates the engine files + overlay CSS + `mobile-main.js` into one injectable string. Dependency-free. |
| `dist/valyou-inject.js` | The generated bundle (what `test/mobile.test.js` runs). |
| `dist/valyou-inject.bundle.js` | The same bytes wrapped as `module.exports = "<bundle>"`, which the app `require`s. |
| `app/` | The React Native project (WebView shell, encrypted storage, settings UI). |

---

## Build & run

Prerequisites: Node ≥ 18, and a React Native toolchain
([reactnative.dev/docs/environment-setup](https://reactnative.dev/docs/environment-setup)) —
Xcode 15+ for iOS, Android Studio + JDK 17 for Android.

> **Status: both platforms build.**
> - **iOS** — a Release build (`xcodebuild … -sdk iphonesimulator`, Hermes + 66
>   pods + app) compiles clean, installs on the iPhone 17 simulator, launches,
>   renders the valyou shell, and loads the live networks in the WebView with the
>   engine injected. Bundle id `com.valyou`; store-quality app icon generated.
> - **Android** — `./gradlew :app:assembleDebug` (SDK 35, NDK 26.1.10909125)
>   compiles clean and produces `app-debug.apk`. `applicationId com.valyou`;
>   adaptive + legacy launcher icons generated. Not yet run on an emulator (none
>   installed here).

```bash
# 1. From the repo root, (re)build the engine bundle. Re-run whenever any
#    engine file or the overlay CSS changes.
node mobile/scripts/build-bundle.js

# 2. Verify the bundle in Node (fast, no device needed). Part of `node --test`.
node --test test/mobile.test.js

# 3. Install the app's JS deps (also rebuilds the bundle via postinstall).
cd mobile/app
npm install

# 4. iOS
npm run pod-install
npm run ios

# 4. Android
npm run android
```

The app has no backend. There is no network call anywhere in valyou except the
WebView loading the social sites the user chose to browse — the CSP-equivalent
posture of the extension carries over.

---

## What is done vs. what needs a device

**Done and verified here:**

- The shared engine ported to a chrome-free bundle (`mobile-main.js` + builder).
- `test/mobile.test.js` runs the real generated bundle in a sandboxed DOM and
  confirms it registers, hides a hateful Facebook post, leaves a clean post
  visible, gates video behind a tap in hide mode, injects the overlay CSS, and
  reports counters over the native bridge. Part of the 265-test suite.
- The React Native app: WebView shell, encrypted keystore storage, live-updating
  settings screen, native stats bridge.
- **Native iOS project generated, built, and run.** `npm install` +
  `pod install` (66 pods, both native modules autolinked) succeed; Metro bundles
  the JS (the cross-folder `require` of the engine resolves and the classifier is
  embedded); a Release build compiles clean and runs on the iPhone 17 simulator,
  rendering the shell and loading the live networks in the WebView.
- **Native Android project generated and built.** `./gradlew :app:assembleDebug`
  compiles clean (SDK 35, NDK 26.1) and produces `app-debug.apk`.
- **App icons** for both platforms generated from the brand shield
  (`npm run icons` → `mobile/scripts/make-app-icons.js`): iOS alpha-free icon set
  incl. the 1024 marketing icon, Android adaptive + legacy mipmaps, and the
  512 Play hi-res icon in `store/assets/`.
- **Store submission kits** written: `store/APP-STORE.md`, `store/PLAY-STORE.md`,
  and the privacy policy `PRIVACY.md`. The iOS privacy manifest already declares
  no-tracking / no-collection.
- **WebView hardened for real use:** persistent login cookies
  (`sharedCookiesEnabled` / `thirdPartyCookiesEnabled`) and
  `webviewDebuggingEnabled` so the mobile DOM can be inspected for selector work.

**Remaining work (needs a logged-in account / signing / store accounts):**

1. **Mobile-web selector verification — the top task.** `extractors.js` is
   anchored on ARIA/roles, which makes x.com and instagram.com (both responsive
   single sites) work on mobile as-is. `m.facebook.com` is a genuinely different
   touch DOM; a provisional `<article>` fallback rule has been added, but the
   `PLATFORM_RULES` for Facebook must be confirmed/extended against the live
   *logged-in* mobile DOM. With `webviewDebuggingEnabled` you can now attach
   Safari Web Inspector to the simulator's WebView and read the real markup.
2. **Login-in-WebView behavior.** Confirmed on the simulator: Facebook renders
   its normal mobile login screen inside the WebView, so a session is required
   before there is any feed to filter. Cookie persistence is enabled; the auth
   hand-off in Risk #2 still needs real-account testing.
3. **Run on an Android emulator/device** (none installed here) and produce a
   signed release AAB (`bundleRelease` + upload keystore).
4. **Store listings**: screenshots of a logged-in filtered feed, feature
   graphic, subscription (StoreKit / Play Billing) wiring, and submission using
   the kits in `store/`.

---

## Store submission risks (read before you file)

These are review/policy risks, not engineering blockers. Plan for them.

1. **No third-party branding or trademarks.** The app must not use the
   Facebook / Instagram / X names as its own branding, their logos, or icons, or
   imply endorsement. The tab labels are nominative references to sites the user
   navigates to (like any browser's bookmarks) — keep it that way. App name,
   icon, and store listing use only valyou's own shield mark.

2. **Login inside an embedded WebView.** Some networks discourage or intermittently
   block sign-in from embedded WebViews (bot/security heuristics), and may show
   an "unsupported browser" interstitial. Mitigations to test on-device:
   persist cookies (`sharedCookiesEnabled` on iOS, `thirdPartyCookiesEnabled` on
   Android), a realistic user-agent per site, and — if a site hard-blocks
   embedded login — an `ASWebAuthenticationSession` / Custom Tab hand-off for the
   auth leg only. Verify the real behavior before committing to a flow.

3. **Apple App Store Review Guideline 4.2 / "minimum functionality."** A thin
   web-wrapper gets rejected; a browser that provides substantial, original
   on-device value does not. valyou's value is the filtering engine, the video
   gating, the encrypted local settings, and the fully offline classifier —
   lead the review notes and the listing with that. Google Play's equivalent is
   the WebView/"webview app" and Families policies; the same substance argument
   applies, and because we do **not** use an AccessibilityService, the most
   common filtering-app rejection reason does not apply to us.

4. **Content-moderation posture.** Both stores look closely at apps that decide
   what content a user sees. Be explicit in the review notes: filtering is
   user-configurable, runs entirely on-device, collects nothing, and only ever
   *hides* content the user asked to avoid — it never alters, reposts, or
   exfiltrates anything.

---

## Keeping the two shells in sync

The mobile `Settings` defaults (`app/src/storage.ts`) and validator mirror the
extension's `src/lib/taxonomy.js` and `src/lib/settings.js`. When you change a
category, threshold, or default there, update `storage.ts` to match. The engine
itself never forks — it is pulled straight from `src/` by the bundler — so only
these small native mirrors need attention.
