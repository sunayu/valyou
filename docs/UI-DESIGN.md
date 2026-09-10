# UI design system

The visual language of valyou across its three surfaces: extension pages
(popup, options), the injected in-feed overlay, and the brand mark. The
implementation is `src/ui/ui.css`, `src/content/overlay.css`, and
`scripts/make-icons.js`.

---

## Principles

1. **Quietly premium, never alarming.** valyou renders inside someone else's
   product, dozens of times a session. A filter that shouts gets switched
   off; the bar should read like a considered part of the page.
2. **Nothing vanishes silently.** Every treatment carries a label saying what
   was caught and why, and a one-click way back. The UI is the trust story.
3. **Tokens first.** Every color, radius, and shadow derives from one token
   block per stylesheet. A rebrand is a token edit plus one icon re-render —
   never a stylesheet rewrite.
4. **Both themes are first-class.** Dark is a tuned ramp, not an inversion.
   Every surface ships light and dark via `prefers-color-scheme`.
5. **Comfort settings are honored.** `prefers-reduced-motion` disables all
   animation; `prefers-reduced-transparency` replaces frosted glass with
   solid fills.

## Brand

| Element | Value |
| --- | --- |
| Gradient | `#2F6FEB` (indigo) → `#7C5CFF` (violet), 135° |
| Mark | A **shield** in the brand gradient carrying a white "v". The shield says the product — protection, filtering, safety — and the "v" (valyou), seated point-down in the crest, reads as a checkmark: vetted, safe. |
| Wordmark | "valyou", lowercase, bold, tight tracking, gradient-clipped text |
| Voice | Plain-language, first-person-neutral, no exclamation marks |

The mark is **generated, not drawn, and entirely license-free** — no external
asset, no font, no clip-art. `scripts/make-icons.js` builds the shield as a
polygon (rounded top → tapered point), measures each pixel's signed distance
to it, fills the brand gradient with a soft top-left highlight, seats the
antialiased "v", and writes the PNGs by hand (Node zlib + hand-rolled PNG
chunks; zero dependencies). Sizes 16/32/48/128 are committed under `icons/`,
verified against the manifest by `test/icons.test.js`, which also pins the
silhouette (centre and point inside, corners outside — the property that makes
it a shield, not a square). The same shield appears as inline SVG in both page
headers (`.brand-mark`), so toolbar, store listing, and pages share one mark.
To change it: edit the geometry constants in the script, re-run it, and
re-check the 16 px render specifically — that's the size that lives in the
toolbar (verified legible on light and dark).

## Tokens (`ui.css`)

| Group | Tokens | Notes |
| --- | --- | --- |
| Brand | `--brand-a`, `--brand-b`, `--brand-gradient` | The only place the gradient is defined for pages |
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--line` | Three-step elevation ramp + hairline |
| Text | `--fg`, `--muted` | |
| Semantic | `--accent`, `--accent-soft`, `--danger`, `--ok` | Accent shifts lighter in dark mode for contrast |
| Geometry | `--radius-s` (8) / `--radius` (12) / `--radius-l` (18) | Inputs / cards / sections |
| Depth | `--shadow-1`, `--shadow-2` | Recalibrated per theme (heavier in dark) |
| Motion | `--ease` = `cubic-bezier(0.2, 0.7, 0.3, 1)` | The one easing curve everywhere |

The overlay stylesheet keeps its own namespaced token block (`--valyou-*`) —
it must be self-sufficient inside hostile host pages, and host CSS variables
must never bleed in.

## Type scale

System font stack throughout (`-apple-system … system-ui`) — an extension
should feel native to the browser, and it avoids shipping font files.

| Role | Size / weight | Used for |
| --- | --- | --- |
| Wordmark | 18 px / 700 | Brand lockups |
| Page title | 19 px / 700 | Options h1 |
| Section heading | 15 px / 650 | Card h2 |
| Eyebrow | 11.5 px / 650, uppercase, +0.07em | Column headers, popup section labels |
| Body | 14 px / 400–450 | Default |
| Meta | 12–12.5 px | Hints, signals, footers |
| Hero number | 26 px / 750, tabular numerals | Popup stat |

## Components

| Component | Class(es) | Behaviour notes |
| --- | --- | --- |
| Brand lockup | `.brand`, `.brand-mark`, `.wordmark` | Header of both pages |
| Toggle switch | `.switch` > `.slider` | Gradient track when on; focus ring on the slider |
| Buttons | `button`, `.primary`, `.link`, `.danger` | Pill-shaped; primary carries the gradient + glow; scale-down on press |
| Range slider | `input[type="range"]` | Gradient track, white thumb with brand ring, grows on hover; paired `<output>` shows the plain-language sensitivity label |
| Stat card | `.stat` | First card is the gradient hero ("filtered today") |
| Category row (popup) | `.category`, `.category-action` | Hover wash; action shown as an accent pill |
| Section card (options) | `section` | Radius-l, hairline, shadow-1 |
| Score bars (try-it) | `.score-list`, `.score-bar` | Animated width, gradient fill at 28% opacity, tabular numbers |
| Mode picker | `.security-modes label` | Selected card highlighted via `:has(input:checked)` |
| Save indicator | `.page-foot [role="status"]` | "Saving… / Saved", announced to AT |

### Injected overlay (`overlay.css`)

| Treatment | Look |
| --- | --- |
| Hidden bar | Surface card, 3.5 px gradient keel on the left edge, muted label, pill "Show" button |
| Blur shield | 16 px blur + desaturation on content; frosted centered panel with a CSS-drawn shield glyph (`clip-path` hexagon in the brand gradient), label, "Show anyway" |
| Badge | Gradient-tinted pill, brand-colored text |
| Entrance | 220 ms fade/rise, disabled under reduced motion |

Two hard rules in this file: every selector is `.valyou-`-prefixed and every
declaration carries `!important` (Facebook's generated CSS wins otherwise);
and `z-index` is pinned at `2147483000` to sit above host overlays.

**The glyph yields, the controls don't.** On short units (one-line DMs) the
shield's stack can exceed the card. The glyph uses `flex: 0 1 34px; min-height: 0`
so it shrinks away first; label and button are `flex: none`. Tight cards drop
the ornament, never the controls. (Found via screenshot testing; keep it.)

## Accessibility

- Every interactive element has a visible `:focus-visible` ring (2 px accent,
  2 px offset).
- The shield is `role="group"` with an `aria-label` naming the reason; the
  master toggle carries an explicit `aria-label`; save state uses
  `role="status"`.
- Reveal buttons are real `<button>`s — keyboard operable, and their click
  handlers stop propagation so activating them never triggers the host post
  underneath.
- Color is never the only signal: actions are labelled in text, signals in
  the try-it box carry ▲/▼ markers, sensitivity sliders have text readouts.
- Contrast: body text meets WCAG AA on its surface in both themes; the muted
  tone is reserved for secondary text at 12 px+.

## Verifying changes

There is no UI test harness; the check is visual. The workflow used to build
this (worth repeating for any change): copy `src/` to a scratch dir, inject a
`chrome.*` stub with representative data before the page scripts, and
screenshot with headless Chrome:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --screenshot=out.png --window-size=340,560 \
  "file://…/preview/src/ui/popup.html"
```

Screenshot the popup, the options page, and a mock feed with all three
overlay treatments, in both themes. This caught a real bug (glyph clipping on
short cards) that code review missed.
