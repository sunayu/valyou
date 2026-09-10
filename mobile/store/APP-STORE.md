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

# App Store submission kit (iOS)

Everything needed to file valyou with App Store Connect. Fill the _(placeholder)_
fields, attach the assets, and paste the review notes.

## App identity

| Field | Value |
|---|---|
| App name | valyousecure _("valyou" was taken on the App Store; the on-device name stays **valyou** via CFBundleDisplayName)_ |
| Subtitle (30 char max) | Filter the feed. Browse calmer. |
| Bundle ID | `cx.valyou` |
| Primary category | Utilities |
| Secondary category | Social Networking |
| Age rating | 17+ (unrestricted web access — the in-app browser can reach any site the user navigates to) |
| Price | Free |
| Privacy Policy URL | https://bjames301.github.io/valyou/privacy.html _(live; swap to valyou.app when the domain is bought)_ |

## Description

> **Take the hate out of your feed.**
>
> valyou is a browser that filters social media *for you*. Open Facebook,
> Instagram, or X inside valyou and hateful, violent, and rage-baiting posts are
> hidden or blurred before you ever see them — automatically, and entirely on
> your device.
>
> **Private by design.** valyou has no servers and collects nothing. Every post
> is analyzed on your phone, in the moment, and never uploaded. What you browse
> stays yours.
>
> **You're in control.** Choose what to filter — racial and gendered hate,
> violence and threats, harassment, rage bait — and how: hide it, blur it, or
> just tag it. Block autoplay, or hide every video behind a tap so nothing plays
> until you choose.
>
> **Works with the sites you already use.** Sign in and browse Facebook,
> Instagram, and X normally. valyou just makes the feed calmer.
>
> No tracking. No ads. No account. Just a quieter internet.

## Keywords (100 char max, comma-separated)

`content filter,hate speech,block,mute,social media,wellbeing,calm,feed,parental,moderation,privacy`

## Pricing

v1 ships completely FREE — no in-app purchases and no subscription. StoreKit is
not wired yet, and listing a subscription without a functional purchase +
restore flow is an instant rejection. The filtering engine, model, and
encryption are fully on-device with no paid backend, so a free v1 costs nothing
to run. Introduce "valyou Premium" (auto-renewable) in a later release once
StoreKit and restore-purchases are implemented.

## App Privacy answers ("nutrition label")

Answer **"Data Not Collected"** for every category. This is accurate: the app
has no servers and transmits nothing. Specifically:

- Data used to track you: **None**.
- Data linked to you: **None**.
- Data not linked to you: **None**.

The bundled `PrivacyInfo.xcprivacy` already declares `NSPrivacyTracking = false`,
an empty `NSPrivacyCollectedDataTypes`, and the standard React Native
Required-Reason API declarations (file timestamp, user defaults, system boot
time). Confirm it is a member of the `valyou` target.

## Review notes (paste into "Notes for Review")

> valyou is a content-filtering web browser. It loads user-chosen social
> websites in a WKWebView and hides or blurs hateful / violent / rage-bait
> content using an on-device classifier and machine-learning model — nothing is
> sent off the device, and the app has no backend.
>
> Why this is not a thin web wrapper (Guideline 4.2): the app's value is native
> and substantial — an offline text/ML content classifier, per-category
> hide/blur/tag controls, a tap-to-play video gate, encrypted on-device
> settings, and local-only statistics. The WebView is the delivery surface, not
> the product.
>
> To test filtering, sign in to any supported site and scroll the feed; hateful
> or violent posts are collapsed or blurred with a "hidden by valyou" control
> that reveals on tap. Filtering is fully user-configurable in Settings (gear
> icon) and can be turned off.
>
> No third-party trademarks are used as app branding; site names are nominative
> references to destinations the user chooses to visit, as in any browser.

## Assets checklist

- [x] App icon 1024×1024, no alpha — `ios/valyou/Images.xcassets/AppIcon.appiconset/Icon-1024@1x.png`
- [ ] iPhone 6.7" screenshots (min 3) — capture on-device with a logged-in feed showing before/after filtering
- [ ] iPhone 6.5"/5.5" screenshots if supporting older devices
- [ ] Support URL, marketing URL, privacy policy URL
- [ ] Export-compliance answer: uses only standard OS/HTTPS encryption → usually exempt; confirm ITSAppUsesNonExemptEncryption=false in Info.plist before upload

## Known review risks (see mobile/README.md → Risks)

1. Embedded-WebView login on some networks (bot heuristics / "unsupported
   browser"). Test real logins; cookie persistence is enabled.
2. Content-moderation scrutiny — the review notes above address it head-on.
