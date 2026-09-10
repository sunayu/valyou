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

# valyou — promo film

A 36-second animated promo, rendered to an upload-ready 1080p MP4.

## Deliverables (on disk; git-ignored so the licensed track isn't committed)

| File | What |
|---|---|
| `valyou-promo-1080p.mp4` | **YouTube master** — 1920×1080, 30 fps, H.264 high + AAC 48 kHz stereo, `+faststart` |
| `valyou-promo-720p.mp4` | 1280×720 companion (smaller upload / previews) |
| `valyou-promo-vertical-1080x1920.mp4` | **Phone / vertical master** — 1080×1920 (9:16) for iPhone + Android: Stories, Reels, Shorts, TikTok. Same file plays on both. |
| `poster.png` / `poster-vertical.png` | Thumbnail / social cards (logo end-card, landscape + portrait) |
| `valyou-promo.html` / `valyou-promo-portrait.html` | Self-contained in-browser players (landscape + phone), published as Artifacts |

### Orientations

The film exists in two hand-tuned layouts driven by the same timeline and music:
- **Landscape** (`film.js`, 1920×1080) — YouTube, web embeds.
- **Portrait** (`film-portrait.js`, 1080×1920) — phones. Headlines wrap, the feed
  and the Chrome/iOS/Android tiles stack vertically, no letterbox.

Rebuild the phone version:

    node capture.js film-portrait.html frames-portrait 1080 1920   # -> frames-portrait/
    ffmpeg -y -framerate 30 -i frames-portrait/frame-%05d.png -i promo-audio.m4a \
      -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 19 -preset slow \
      -c:a aac -b:a 256k -ar 48000 -shortest -movflags +faststart \
      valyou-promo-vertical-1080x1920.mp4
    node build-artifact-portrait.js    # -> valyou-promo-portrait.html (in-browser player)

## Music

The soundtrack is the user-supplied, user-owned licensed track
*“Product Of My Environment 83.0”* — the first 36 seconds, with a 1.5 s
fade-out (`promo-audio.m4a`). Because the track is owned/licensed by the
publisher, it is safe for a commercial upload. The original and the trimmed
excerpts are git-ignored.

`audio.js` also contains a from-scratch **original synthesized score** (writes
`soundtrack.wav`) as a license-free fallback if a Content-ID-clear bed is ever
needed; the shipped film uses the licensed track.

## How it's made (all local, no paid services)

The film is a **deterministic Canvas animation** — every visual is a pure
function of time `t` (`film.js`), so a given frame is identical whether played
live or captured for encoding. Pipeline:

```
film.js            the animation (scenes as functions of t)
  │  node capture.js        headless Chrome renders 1080 PNG frames (30fps × 36s)
  ▼
frames/*.png
  │  ./encode.sh            ffmpeg: frames + promo-audio.m4a → H.264/AAC MP4 (1080p + 720p)
  ▼
valyou-promo-1080p.mp4
```

Rebuild from scratch:

```bash
cd web/promo
npm install                 # puppeteer-core (drives the installed Chrome; no Chromium download)
node capture.js             # -> frames/ (≈2 min)
./encode.sh                 # -> the MP4s + poster
node build-artifact.js      # -> valyou-promo.html (in-browser player)
```

Requirements: Google Chrome, ffmpeg, Node ≥ 18 — all already present on the
build machine.

## Storyboard

| Time | Beat |
|---|---|
| 0–7 s | Cold open — a drifting cloud of hostile words; *“The feed was never built for you. It was built to keep you angry.”* |
| 7–11 s | A scan-line sweeps, the shield forms, the noise dissolves, the **valyou** wordmark resolves |
| 11–18 s | The feed filters itself — posts scan → blur → collapse to *Hidden by valyou*; *“Filter the feed. Automatically.”* |
| 18–24 s | The five categories stamp in with Hidden / Blurred tags; *“Hide, blur, or tag — your call.”* |
| 24–29 s | Privacy peak — *“Nothing you browse ever leaves your device.”* · On-device · AES-256 · Zero network |
| 29–33 s | Platforms — Chrome · iOS · Android; *“One filter. Every screen.”* |
| 33–36 s | Logo sting — **valyou**, *“Calm your social feed.”* |

## Editing

- **Visuals**: edit the scene functions in `film.js`, re-run `capture.js` +
  `encode.sh`. Test single stills fast with `film.html?t=<seconds>`.
- **Length / music window**: change `DUR` in `film.js`/`capture.js` and the
  `-t 36` / fade in the `promo-audio.m4a` step (see git history of `encode`).
- **A different music section**: re-trim from the source with a different `-ss`
  start offset.
