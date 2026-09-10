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

# Google Play submission kit (Android)

Everything needed to file valyou in the Play Console. Fill the _(placeholder)_
fields, attach the assets, and complete the Data Safety form as below.

## App identity

| Field | Value |
|---|---|
| App name | valyou |
| Package name (applicationId) | `cx.valyou` |
| Category | Tools |
| Content rating | Complete the IARC questionnaire; expect Mature (unrestricted in-app web access) |
| Price | Free |
| Privacy Policy URL | https://bjames301.github.io/valyou/privacy.html _(live; swap to valyou.app when the domain is bought)_ |

## Short description (80 char max)

> Filter hate, violence, and rage bait out of your social feed — privately.

## Full description

> **Take the hate out of your feed.**
>
> valyou is a browser that filters social media for you. Open Facebook,
> Instagram, or X inside valyou and hateful, violent, and rage-baiting posts are
> hidden or blurred before you see them — automatically, and entirely on your
> device.
>
> **Private by design.** valyou has no servers and collects nothing. Every post
> is analyzed on your phone and never uploaded.
>
> **You're in control.** Choose what to filter — racial and gendered hate,
> violence and threats, harassment, rage bait — and how: hide, blur, or tag.
> Block video autoplay, or hide every video behind a tap.
>
> **Works with the sites you already use.** Sign in and browse normally. valyou
> just makes the feed calmer.
>
> No tracking. No ads. No account.

## Data safety form

Declare **no data collected and no data shared**:

- Does your app collect or share any of the required user data types? **No.**
- Is all of the user data encrypted in transit? **N/A — the app transmits no
  user data of its own.** (The WebView's traffic to the sites the user browses
  uses HTTPS, exactly as a normal browser.)
- Do you provide a way for users to request that their data be deleted? **N/A —
  no data is collected; on-device settings are removed when the app is
  uninstalled.**

## Policy positioning (important)

valyou is a **WebView-based browser**, not an accessibility tool. It does **not**
use `AccessibilityService`, `SYSTEM_ALERT_WINDOW` overlays, or VPN/proxy APIs to
filter other apps — the single most common rejection reason for "content
filter" apps on Play. It filters only the pages the user loads inside its own
in-app browser. State this in the app's Permissions Declaration if prompted.

Requested permissions: `INTERNET` only (for the in-app browser). No sensitive or
special-access permissions.

## Review notes

> valyou is a content-filtering web browser. It loads user-chosen social sites in
> an android.webkit.WebView and hides/blurs hateful, violent, and rage-bait
> content with an on-device classifier + ML model. No backend, no data
> collection, no AccessibilityService, no overlays. Filtering is user
> configurable and can be disabled. Site names are nominative references to
> destinations the user chooses to visit.

## Build & signing

- Debug build verified: `./gradlew :app:assembleDebug` → `app-debug.apk`.
- For release: create an upload keystore, set it in `~/.gradle/gradle.properties`
  (or `android/gradle.properties`, kept out of VCS), then
  `./gradlew :app:bundleRelease` to produce the AAB for Play.
- Enable Play App Signing.

## Assets checklist

- [x] Adaptive launcher icon (foreground + background) and legacy mipmaps — generated
- [ ] 512×512 hi-res icon (export from `Icon-1024@1x.png` downscaled, or render at 512)
- [ ] Feature graphic 1024×500
- [ ] Phone screenshots (min 2) — logged-in feed showing before/after filtering
- [ ] Signed release AAB
