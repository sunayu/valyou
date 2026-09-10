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

# valyou on Safari (macOS + iOS)

The same extension, running in Safari. Safari uses the identical WebExtension
code as Chrome — the only difference is that Apple requires it wrapped in a
native app built with Xcode. Apple's official converter does that wrapping, and
the result is checked in under `safari/xcode/`.

**Status: builds on both platforms.** `xcodebuild` produces `valyou.app`
(macOS, with the `valyou Extension.appex` plug-in) and the iOS app, both from the
unmodified extension source. No code changes were needed — Safari supports the
`chrome.*` namespace and every API valyou uses (`storage`, `runtime`, `tabs`,
`action` messaging).

## Layout

```
safari/
  payload/            # a clean copy of the extension the converter ingested
  xcode/valyou/       # the generated Xcode project (macOS + iOS app + extension)
    Shared (Extension)/Resources/   # ← the extension files the app ships (a COPY)
  sync.sh             # refresh that copy from the real src/ after edits
```

The extension files under `Shared (Extension)/Resources/` are a **copy** of the
repo's `manifest.json`, `icons/`, and `src/`. When you change the real
extension, run `./safari/sync.sh` to update the copy, then rebuild. (The engine,
classifier, ML model, and crypto are byte-for-byte the same files as the Chrome
extension — one codebase, three browsers.)

## Build

Prereqs: Xcode (already present on this machine).

```bash
cd safari/xcode/valyou

# macOS app + Safari extension
xcodebuild -scheme "valyou (macOS)" -configuration Release build

# iOS app + Safari extension (simulator)
xcodebuild -scheme "valyou (iOS)" -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build
```

Or just open `valyou.xcodeproj` in Xcode and press Run.

## Run it in Safari (macOS)

The project is signed with the Apple Development team **D8UUS2D2WC** (set on all
targets), and a signed `valyou.app` has already been built at
`safari/xcode/valyou/build/Build/Products/Release/valyou.app` and registered with
the system. Because it carries a real Development signature (not ad-hoc), you do
**not** need the "Allow Unsigned Extensions" workaround.

1. Open the built **valyou.app** (double-click it, or rebuild + Run in Xcode).
   The branded container window appears.
2. Safari → Settings → **Extensions** → enable **valyou**.
3. Click the valyou toolbar button and, for each supported site, choose
   **Always Allow on This Website** (Safari grants host access per-site).

Then browse Facebook / Instagram / X in Safari — filtering runs exactly as in
Chrome. (If Safari doesn't list it yet, launch the app once more so Safari
re-scans, or toggle Safari → Settings → Extensions.)

## Run it in Safari (iOS)

Build/run the `valyou (iOS)` scheme to a device or simulator, then:
Settings → Apps → Safari → **Extensions** → enable valyou and allow the sites.

## Notes on Safari specifics

- **Namespace:** valyou calls `chrome.*`; Safari 15.4+ exposes both `chrome.*`
  and `browser.*`, so no shim is required. If you ever target older Safari, add
  `const chrome = self.browser || self.chrome;` at the top of each script.
- **Background:** the MV3 `background.service_worker` is supported by Safari
  16.4+; the converter left the manifest unchanged.
- **Privacy posture is identical:** still zero network (`connect-src 'none'`),
  still on-device. Nothing about the Safari wrapper adds data collection.

## Distribution (App Store)

Safari extensions ship **inside** their container app on the Mac App Store and
iOS App Store:

1. Bundle IDs (`com.valyou.safari` / `.Extension`), the signing Team
   (`D8UUS2D2WC`), and the app icons are already set. The icons are generated
   from the brand shield by `safari/make-safari-icons.js` (re-run it if the mark
   changes); the container app UI is branded in
   `Shared (App)/Resources/{Base.lproj/Main.html,Style.css}`. Set a version and
   confirm the marketing icon before submitting.
2. Archive each scheme (Product → Archive) and upload via the Organizer.
3. The listing is a normal app listing; note in review that the app's purpose is
   to provide the Safari content-filter extension. The same no-data-collected
   privacy answers as the other stores apply.
