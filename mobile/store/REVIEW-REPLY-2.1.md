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

# Reply to Guideline 2.1 — Information Needed (submission 1.0, build 5)

Section A fits the Resolution Center's 4,000-character limit and doubles as
the App Review Information → Notes text. Section B is the screen-recording
shot list (recording already captured).

---

## A. Resolution Center reply — paste this (< 4,000 chars)

Thank you for the review. Responses to each item below; a screen recording captured on a physical iPhone is attached.

1. Screen recording: Attached — captured on a physical iPhone 17 Pro Max (iOS 26.6), beginning at app launch. It shows the typical flow: opening a social site in the built-in browser, hateful/rage-bait posts being hidden or blurred on-device, tapping to reveal, the tap-to-play video gate, and the Settings screen where filter categories and actions are configured. Per your list: the app has NO account system — nothing to register, log into, or delete; the only sign-in shown is the user logging into x.com inside the browser, exactly as in Safari. There is no paid content, purchase, or subscription — the app is completely free. It hosts no user-generated content: it is a web browser, the sites shown provide their own reporting/blocking, and the app's entire purpose is an additional on-device layer that hides objectionable third-party content. It requests no sensitive permissions (no location, contacts, camera, microphone, or photos) and does not use App Tracking Transparency because it does no tracking of any kind.

2. Devices and OS tested: iPhone 17 Pro Max (physical device), iOS 26.6 (build 23G83); iPhone 17 Pro and iPhone SE simulators via Xcode on the same SDK. Minimum deployment target: iOS 15.1.

3. Function, audience, value: valyou is a privacy-first web browser with built-in, on-device content filtering. Social feeds routinely surface racist, sexist, violent, harassing, and rage-baiting posts; valyou analyzes each post on the phone — using a bundled lexicon plus a small bundled machine-learning model — and hides, blurs, or tags posts in the categories the user enables, before the user sees them. It also gates video autoplay behind a tap. The audience is adult social-media users (rated 17+ for the unrestricted browser) who want a calmer feed and strong privacy: no servers, no analytics, no accounts — nothing leaves the device, which is why the App Privacy label is "Data Not Collected."

4. Setup and access: none required — no credentials or sample files. Launch the app, open x.com or facebook.com from the start page, sign in with any personal social-media account (ordinary website login, as in Safari), and scroll the feed. Posts matching enabled categories appear collapsed or blurred with a "hidden by valyou" control; tap to reveal. The gear icon opens Settings to adjust categories (racial/gendered hate, violence, harassment, rage bait), choose hide/blur/tag, toggle the video gate, or turn filtering off entirely.

5. External services: none. No data providers, authentication services, payment processors, analytics SDKs, or cloud AI. The classification lexicon and ML model are bundled in the app and run entirely on-device; the only network traffic is the WKWebView loading websites the user chooses to visit, as in any browser.

6. Regional differences: none — the app functions identically in all regions, with no region-gated features or content. (The filter lexicon and model are tuned for English.)

7. Not applicable: the app does not operate in a regulated industry and contains no protected third-party material. It is a general-purpose browser; site names appear only as nominative references to destinations the user may visit. All code is our own (Sunayu LLC), released under GPL-3.0-or-later.

---

## B. Screen-recording shot list (already captured)

One continuous 60–90s take on Megatron, beginning at launch: Home screen →
launch valyou → open x.com → sign in → scroll until posts are hidden/blurred
(linger so the "hidden by valyou" control is legible) → tap to reveal →
tap-to-play video gate → Settings tour (toggle a category action) → back to
the feed. Attach the .mov in the Resolution Center reply; QuickTime → Export
As → 720p if it's oversized.

## After it's approved

Copy Section A (minus the "Attached" sentence) into App Store Connect →
App Review Information → Notes so every future submission carries it.
