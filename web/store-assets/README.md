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

# valyou — Chrome Web Store listing kit

**Live listing:** https://chromewebstore.google.com/detail/valyou/jileiaojeklemggbieacomlbbnmhpdgd
(Item id `jileiaojeklemggbieacomlbbnmhpdgd` — new packages upload to this item;
never create a second one, or existing users stop receiving updates.)

Everything for the extension's Chrome Web Store listing: the copy (title,
summary, description) and every promotional image, sized to spec and rendered
from the same palette and shield mark as the landing page.

## Listing copy

**Title** — clear, descriptive, not keyword-stuffed:

> valyou — Block hate, violence & rage bait

**Summary** (plain text, ≤ 132 chars — this one is 108):

> Hides hateful, violent, and rage-baiting posts on Facebook, Instagram, and X — entirely on your device.

**Description** — overview paragraph, then the features people install for:

> valyou is a content filter for the social web. It reads each post as it loads
> and quietly hides, blurs, or tags anything hateful, violent, harassing, or
> engineered to make you angry — so your feed stays yours. Everything runs on
> your device: no servers, no accounts, and nothing you browse is ever uploaded.
>
> Features
> - Filters Facebook, Instagram, and X — feed, comments, ads, and messages
> - Catches racial and gendered hate, violence and threats, harassment, and rage bait
> - Hide, blur, or tag — you choose the action for each category
> - Blocks autoplay and hides every video until you tap to play
> - On-device machine-learning model — five classifiers, one per harm, that
>   catch hostile phrasing no word list anticipates. No external AI service.
> - Encrypted settings, zero network access, and no tracking of any kind
> - Free software (GPLv3) — the way it decides is open to read

**Store icon** — the shield mark. Use `../../icons/icon128.png` (128×128) for the
listing; it is the same mark used across every asset here. Simple, recognizable,
no UI or screenshots inside it — per the icon best-practice guidance.

**Additional fields** — Website and support: https://bjames301.github.io/valyou/
Privacy policy: https://bjames301.github.io/valyou/privacy.html (both live).
Category: Social & Communication. Language: English (US).

**Single purpose** (required field, and the answer Chrome re-reads every
review): *filters hateful, violent, and rage-baiting content out of the user's
own social feeds.* Everything in the extension serves it.

**Permission justifications** (paste verbatim into the dashboard):

| Permission | Justification |
|---|---|
| `storage` | Stores the user's own filter settings and local counters on their device. Nothing is transmitted; the values are encrypted at rest. |
| `host_permissions` for facebook.com, messenger.com, instagram.com, x.com, twitter.com | These are the sites whose feeds the extension filters. The content script must read post text in the page to classify it locally. No other origins are requested, and no page data ever leaves the browser. |
| Remote code | None. All code, including the machine-learning weights, ships inside the package; the extension makes no network requests of any kind. |

## Image assets (in `out/`)

| File | Size | Where it appears |
|---|---|---|
| `promo-tile-440x280.png` | 440×280 | Small promo tile — homepage, category pages, search results |
| `marquee-1400x560.png` | 1400×560 | Marquee (featured carousel) |
| `screenshot-1-feed-1280x800.png` | 1280×800 | The feed, filtered — hidden hateful/rage-bait posts |
| `screenshot-2-categories-1280x800.png` | 1280×800 | Per-category hide / blur / tag controls |
| `screenshot-3-video-1280x800.png` | 1280×800 | Tap-to-play video gating |
| `screenshot-4-privacy-1280x800.png` | 1280×800 | On-device, nothing uploaded |

All are full-bleed, square-cornered, saturated, and share the icon/marquee
branding so the listing reads as one identity. Text is kept light per the
guidance. Upload up to five screenshots; a fifth "platforms" shot can be added
from the landing page's platform section if desired.

## Regenerating

Sources are HTML in `src/` (styled by `src/kit.css`), rendered by headless
Chrome at 2× and downsampled with `sips` for crisp anti-aliasing:

    ./web/store-assets/render.sh

Edit the HTML or `kit.css` and re-run to update every asset. Requires Google
Chrome and macOS `sips`.

## Note on the mobile stores

These dimensions are Chrome Web Store's. The App Store and Google Play use
portrait, device-framed screenshots and different icon rules — see
`mobile/store/APP-STORE.md` and `mobile/store/PLAY-STORE.md`. The Play hi-res
512 icon lives at `mobile/store/assets/play-icon-512.png`.
