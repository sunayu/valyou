# valyou

A Chrome extension that filters racist, hateful, sexist, violent, and rage-baiting
content out of your **Facebook, Instagram, and X (Twitter)** feeds — including
comments, sponsored posts and promoted tweets, and direct messages.

It is your feed. This decides what gets into it.

## Documentation

| Document | What it covers |
| --- | --- |
| README (this file) | What the product does, install, settings, limitations |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Trust zones, module map, scan pipeline, message protocol, storage records |
| [SECURITY.md](SECURITY.md) | Threat model, encryption design, key management, data minimization |
| [docs/CLASSIFIER.md](docs/CLASSIFIER.md) | The detection engine: pipeline, scoring math, mitigation, tuning guide |
| [docs/ML.md](docs/ML.md) | The on-device ML assist: model, training, measured performance, biases, the safety cap |
| [docs/CRYPTO-SPEC.md](docs/CRYPTO-SPEC.md) | Byte-level envelope/key formats, state machines, migration, change rules |
| [docs/API.md](docs/API.md) | Every exported symbol, module by module |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | Design tokens, components, brand, accessibility, screenshot workflow |
| [docs/TESTING.md](docs/TESTING.md) | Suite architecture, conventions, recipes for adding tests |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Engineering standards, non-negotiables, PR checklist |
| [docs/architecture/](docs/architecture/) | **How valyou works** — the whole system explained end to end, plain-language and illustrated ([PDF](docs/architecture/how-valyou-works.pdf)) |
| [docs/RELEASE.md](docs/RELEASE.md) | Versioning, packaging, Web Store checklist, rollout |
| [docs/LICENSING.md](docs/LICENSING.md) | The subscription integration plan and its constraints |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| Inline JSDoc | Every module and function documents its *why*, not just its what |

---

## Self-contained by design

valyou runs **entirely on your device**. There is no API, no account, no cloud
service, and no third-party dependency of any kind — the manifest grants no
network access beyond the social sites it filters, and the extension pages'
security policy pins outbound connections to `'none'`. This is a hard product
guarantee: valyou's operation can never depend on, or be priced by, anyone
else's service.

That architecture is also the privacy story: nothing you read can be sent
anywhere, because there is nowhere for it to go.

## How it works

Every post, comment, ad, and message is scored by an on-device classifier that
runs synchronously in the content script and reaches a verdict in well under a
millisecond — anything that trips a signal is hidden in the same frame it
appears, with no flicker and no network round trip.

The classifier covers:

- **Slurs**, robust against leetspeak, letter-spacing, homoglyph, and
  character-stretching evasion ("f4gg0t", "k i k e", Cyrillic lookalikes)
- **Dehumanizing and threatening constructions** — "all *group* are vermin",
  direct threats, incitement, execution fantasies, "kys"
- **Extremist dogwhistles and coded hate** — numeric codes (1488), meme
  phrases, replacement-conspiracy slogans, the triple-parentheses echo,
  nativist expulsion demands
- **Misogynist and anti-LGBT vocabulary**, including incel coinages and the
  "groomer" smear (matched only when aimed at LGBT referents)
- **Rage-bait mechanics** — engagement-bait demands, manufactured censorship
  urgency, out-group fear framing, sustained shouting
- **A bundled on-device ML model** that generalizes past the pattern rules to
  catch hateful phrasing no regex anticipated — capped so it can only
  *reinforce* the rules, never filter anything on its own (see
  [docs/ML.md](docs/ML.md) for its honest performance and biases)

### What it detects

| Category | What it covers |
| --- | --- |
| Racism & ethnic/religious hate | Attacks and dehumanization based on race, ethnicity, origin, immigration status, or religion |
| Sexism & gender-based hate | Attacks based on sex, gender, gender identity, or orientation |
| Violence & threats | Threats, calls for violence, and glorification of it |
| Harassment & targeted abuse | Sustained degradation aimed at a specific person |
| Rage bait & outrage farming | Content engineered to provoke anger rather than inform |

Each category has its own action (**hide**, **blur**, **label**, or **ignore**)
and its own sensitivity.

### What it deliberately does *not* filter

A moderation tool that catches counter-speech is worse than no tool at all, so
the classifier carries explicit mitigating signals that damp these:

- Someone quoting or condemning hateful content
- News reporting and legal proceedings about violent crimes
- People describing their own experience of racism, sexism, or abuse
- Reclaimed in-group language
- Strong political opinion that argues a position rather than attacking a group

Nothing ever disappears silently. Every filtered item leaves a labelled bar or
shield saying what was caught and why, with one click to show it anyway. Once you
reveal something, valyou never re-hides it.

---

## Install

**From the Chrome Web Store:** https://chromewebstore.google.com/detail/valyou/jileiaojeklemggbieacomlbbnmhpdgd

Works in any Chromium browser — Chrome, Brave, Edge, Opera — and requires
Chrome 116 or later.

**From source** (for development; no build step):

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this directory

---

## Privacy

- **No network access.** The extension cannot transmit anything, enforced at the
  manifest level rather than by policy.
- **Post text is never stored.** Verdicts are computed and discarded.
- **Statistics are counters, not history.** "41 filtered today" — nothing about what.
- **Everything valyou stores is encrypted** (settings and counters, AES-256-GCM).
  See [SECURITY.md](SECURITY.md).

---

## Settings

**Sensitivity** per category. Lower thresholds catch more and produce more false
positives. Defaults err toward leaving things visible.

**Surfaces** — filter the feed, comments, ads, messages, and reels independently.
Many people want aggressive filtering on the public feed and a lighter touch on
messages from people they chose to talk to.

**Your rules** — never filter specific people; always or never filter text
containing specific terms. Block terms survive obfuscation ("c r y p t o" matches
"crypto").

**Try it** — paste any text into the settings page to see exactly how it scores,
which signals fired, and what would happen to it.

---

## Subscription readiness

The commercial layer is deliberately not built yet, but the substrate is:

- `Settings.getSecret` / `setSecret` provide an encrypted, tested storage slot
  for a license key, kept in a separate record from settings.
- `getInstall()` provides a stable random installation id an activation can be
  bound to.
- Nothing in the filtering path knows or cares about licensing, so gating can be
  added at the UI/service-worker boundary without touching the classifier.

Whatever license validation is added later, keep the core rule intact: the
*filtering* must never require a network call — validate entitlements out of
band, never in the scan path.

---

## Development

```sh
npm test              # run the full suite (no dependencies)
npm run test:watch    # re-run on change
npm run test:coverage # with coverage
```

There are no runtime or build dependencies. Tests run on Node's built-in runner
and use real Web Crypto rather than a mock, so the encryption tests exercise the
same AES-GCM, PBKDF2, and AES-KW implementations Chrome ships.

Every risky detection pattern ships with a false-positive guard test beside it
(the Maine Coon cat breed, Pakistan, "white power washer", dog groomers, sports
teams, Spanish "negro", surnames). Those guards have caught real bugs; keep the
habit when extending the lexicon.

### Layout

Brand icons live in `icons/` and are committed; regenerate them with
`node scripts/make-icons.js` only when the mark changes (the generator is a
dependency-free SDF rasterizer + hand-rolled PNG encoder, itself unit-tested).

```
src/lib/          shared by the service worker, content scripts, and tests
  text.js         normalization, de-obfuscation, hashing utilities
  taxonomy.js     categories, defaults, storage record names
  lexicon.js      detection patterns, dogwhistles, and mitigating signals
  scorer.js       the classifier and decision rules
  crypto.js       AES-256-GCM envelope encryption, key management
  store.js        encrypted persistence over chrome.storage
  settings.js     validation, defaults, secret storage
src/background/   service worker — encrypted state, stats, settings broker
src/content/      extraction, decision application, scan loop
src/ui/           popup and options page
test/             unit tests + a dependency-free DOM stub
```

Shared modules use a small UMD wrapper so the identical file loads in the service
worker (`importScripts`), in content scripts (manifest `js` array), and in Node's
test runner (`require`) — no bundler, one copy of the logic.

### Why selectors survive

Facebook and Instagram ship obfuscated class names that rotate constantly, so any
selector built on them breaks within weeks. valyou anchors entirely on ARIA roles
and semantic tags, which both sites are obliged to keep stable for assistive
technology. When a selector does eventually need updating, it is one table in
`src/content/extractors.js`.

---

## Limitations

- Text-signal only for video *content*, but autoplay is controlled directly.
  Video frames and audio tracks aren't analyzed, so a hateful video under a
  clean caption is invisible to text filtering. valyou reads every text signal
  attached to media (captions, titles, hashtags, video accessibility labels,
  and platform-generated image alt text like Instagram's "May be an image
  of…"). For the content the text can't reach, the **Videos** setting decides
  what video is allowed to *do*: **Block all videos** (default — every video is
  covered and nothing plays or even shows until you click to play it; one click
  reveals and starts the video you chose), **Don't autoplay** (the video stays
  visible but paused until you click it), or **Allow** (autoplay on). All modes
  except Allow stop autoplay reliably: a document-level play guard pauses every
  autoplay attempt — including late-loading players and videos already rolling
  before the guard installed — while letting a genuine user click through via
  the browser's user-activation signal. And when the classifier *flags* a video
  (detects hate/violence in its text), it is **blurred** behind a click rather
  than collapsed to a bar — the natural media treatment — while flagged
  non-video posts still collapse.
- English-tuned. The pattern lexicon is English; non-English hate is caught only
  where it uses borrowed vocabulary.
- A static pattern list cannot read novel implication or sarcasm invented last
  week; the lexicon needs periodic curation, which is a natural fit for
  subscription updates.
- Rage bait is subjective and the hardest category to get right. It defaults to
  *blur* rather than *hide* and to the highest threshold for that reason.
- Selectors will eventually break when Facebook restructures. The failure mode is
  "stops filtering", never "breaks the page".

## License

GNU General Public License v3.0 or later (GPL-3.0-or-later). See `LICENSE`
for the full text and the header on each source file.

**App Store distribution exception.** `LICENSE-EXCEPTION` grants an additional
permission under GPLv3 section 7 allowing valyou to be distributed through the
Apple App Store, Google Play, and comparable platforms whose terms (DRM, code
signing, installation and usage rules) would otherwise conflict with the GPL.
It adds a permission and removes none: the complete corresponding source stays
available under the GPL, and redistribution outside those platforms is governed
by the GPL in full.

The Gradle wrapper (`mobile/app/android/gradlew*`) and the Android/React
Native boilerplate drawable remain under their upstream Apache-2.0 terms.
