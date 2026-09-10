# The classifier

How valyou decides what to filter: the text pipeline, the scoring
mathematics, mitigation, and how to tune or extend detection. The
implementation lives in `src/lib/text.js`, `src/lib/lexicon.js`, and
`src/lib/scorer.js`.

---

## Design position

valyou's classifier is **structural, not lexical**. A long list of banned
words is the obvious design and the worst one: it misses everything phrased
politely and fires on quotation, reporting, and counter-speech. The engine
therefore leans on *constructions* — "all *(group)* are *(dehumanizing
predicate)*", "*(violence verb)* the *(group)*" — which capture what actually
makes a post hateful and are far harder to paraphrase around.

Word lists still exist in three places where they earn their keep:

1. **Slurs** — terms with essentially no non-attacking reading in feed context.
2. **Dogwhistles and coded hate** — vocabulary invented specifically to slip
   past filters (numeric codes, meme phrases, conspiracy slogans). This
   rotates slower than people assume; most entries have been stable for five
   to fifteen years.
3. **User block terms** — whatever the user personally never wants to see.

A small **ML model** rides alongside these lists (see [ML.md](ML.md)) to
generalize past what any pattern anticipates — but it is capped so it can only
reinforce pattern evidence, never filter on its own.

Everything is computed on-device, synchronously, in well under a millisecond
per unit. There is no network and no state carried between units — every score
is a pure function of (text, rules, loaded model).

---

## Stage 1 — text normalization (`text.js`)

Two normal forms are produced, because two different jobs need them:

### `normalize()` — conservative

Used for phrase and template matching, where word boundaries carry meaning.

| Step | Defeats |
| --- | --- |
| Unicode NFKC | Fullwidth/compatibility forms: `ＫＩＬＬ` → `kill` |
| Strip invisibles (ZWSP, ZWNJ, ZWJ, WJ, BOM, soft hyphen) | Zero-width characters spliced inside words |
| Lowercase, collapse whitespace | Case and spacing noise |

### `deobfuscate()` — aggressive, boundary-preserving

Used for slur and dogwhistle matching. Builds on `normalize()`, then:

| Step | Defeats | Example |
| --- | --- | --- |
| Fold leetspeak digits/symbols and Cyrillic/Greek homoglyphs | Character substitution | `f4gg0t` → `faggot`, `неllо` → `hello` |
| Remove punctuation **between two alphanumerics** (lookarounds) | Intra-word separators | `f.u.c.k` → `fuck` |
| Weld letter-spaced runs of 3+ single characters | Letter spacing | `k i l l` → `kill` |
| Collapse runs of 3+ repeated characters to one | Stretching | `faaaggooot` → `faggot` |

**The load-bearing property: word boundaries survive.** An early version
stripped all whitespace, and "work i kept" collapsed to `workikept` — which
contains "kike" as a substring. Boundary preservation is what lets every slur
pattern be `\b`-anchored, making cross-word false positives structurally
impossible. `test/text.test.js` pins this with the exact phrase.

Digits fold to letters in this form (`1` → `i`, `4` → `a`), which would
destroy numeric codes like `1488` — which is why the scorer checks
dogwhistles against **both** forms.

---

## Stage 2 — signals (`lexicon.js`)

Every pattern carries a weight in (0, 1] — how much evidence one hit
provides — and a `why` string that surfaces verbatim in the UI, so the user
can always see the reason something was filtered.

| List | Matched against | Weight range | Notes |
| --- | --- | --- | --- |
| `SLUR_PATTERNS` | de-obfuscated | 0.45–0.92 | `\b`-anchored. Homograph-risk terms ("dyke" the surname/embankment, Spanish "negro") are deliberately weighted **below** the default threshold so a single occurrence never acts alone |
| `DOGWHISTLE_PATTERNS` | both forms | 0.75–0.95 | Numeric codes, slogans, meme phrases, co-occurrence smears (bare "groomer" is innocent; "groomer" within 50 chars of an LGBT referent is not) |
| `TEMPLATE_PATTERNS` | normalized | 0.72–0.93 | The structural core: dehumanization, inherent-inferiority, existence-denial, threats, incitement, harassment constructions |
| `RAGE_BAIT_PATTERNS` | normalized | 0.35–0.5 | Individually weak by design — a share-prompt alone is not a problem; several must combine. Typographic signals (sustained caps on 60+ chars, stacked `!!!`) add small weights |
| `MITIGATOR_PATTERNS` | normalized | 0.3–0.45 (negative) | Quotation, attribution, legal-proceedings language, counter-speech, educational framing |

The alternation fragments `GROUP`, `DEHUMANIZING`, and `VIOLENCE_VERB` are
shared building blocks spliced into the templates — extend those to widen
every template at once.

---

## Stage 3 — scoring (`scorer.js`)

### Combination: noisy-OR, never a sum

For each category, hits combine as:

```
score = 1 − Π (1 − wᵢ)
```

Summing lets three weak 0.4 signals manufacture false certainty
(1.2 → clamped 1.0). Noisy-OR yields 0.78 — "quite likely, not certain" —
and keeps one strong signal dominant over a pile of weak ones. This single
choice is most of why rage-bait detection can use several 0.35–0.5 markers
without ordinary posts tripping it.

### Mitigation: multiplicative, capped

Mitigator hits combine (noisy-OR again) into a damping factor applied to
**every** category at once:

```
final = score × (1 − min(mitigation, 0.7))
```

The 70% cap means a well-intentioned frame around an explicit slur still
leaves enough score for a blur — quoting hate to condemn it is protected;
laundering hate through fake attribution is not.

A calibration note from real tuning: attribution ("according to police") and
legal-proceedings language ("charged with") are **separate** mitigators
because a crime report contains both and they must compound. As one combined
pattern, a news report about a killing scored 0.63 — above the hide
threshold. The scorer test suite pins the corrected behaviour.

### The ML assist as a signal

When a model is loaded, its probability becomes one more noisy-OR signal
(`ml_assist`) contributing to the hate/harassment categories, with a weight
capped below every default action threshold. It therefore behaves exactly
like a mid-strength pattern hit that cannot, alone, reach a decision. Full
treatment — training, measured precision/recall, biases, and why the cap
makes weak precision safe — is in [ML.md](ML.md). Turning the assist off in
settings prevents the model from loading, so the scorer is pattern-only with
no code-path change.

### Decision (`decide()`)

1. Author on the user's allow list → `off`, always.
2. For each category with a configured action ≠ `off` whose score ≥ its
   threshold: candidate.
3. Among candidates, the **strictest action wins** (`hide` > `blur` > `tag`),
   ties broken by score. The reported category is the winner's, so the
   explanation matches the treatment.
4. The reason string leads with the strongest positive signal's `why`.

### Defaults and their rationale

| Category | Action | Threshold | Why |
| --- | --- | --- | --- |
| hate_racial / hate_gender / violence | hide | 0.55 | High-confidence constructions; hiding is the point |
| harassment | blur | 0.60 | More context-dependent (banter vs. abuse) — recoverable treatment |
| rage_bait | blur | 0.70 | The most subjective category gets the most conservative default |

Thresholds are user-tunable 0.05–1.0; the options UI presents them inverted
as "sensitivity" with plain-language labels.

---

## Tuning guide

**A benign post is being filtered.** Reproduce it in the options "Try it"
box — it shows every signal that fired with its weight. Then either the
pattern is too broad (fix the regex, add a lookahead like `white power(?! wash)`),
a mitigator is missing (news/quotation frames belong in `MITIGATOR_PATTERNS`),
or the weight is too high for a term with benign homographs (drop it below
0.55 so it can only act in combination).

**Hate is getting through.** Check the normalized and de-obfuscated forms
first (`Text.normalize` / `Text.deobfuscate` in a Node REPL) — if the evasion
survives normalization, fix `text.js`; otherwise add a pattern. Prefer
extending `GROUP`/`DEHUMANIZING`/`VIOLENCE_VERB` over new one-off templates.

**The iron rule: every risky addition ships with a false-positive guard test
beside it.** The guards have caught real bugs — "white power washer",
sarcastic `(((triple parentheses)))`, the Maine Coon cat breed. If you cannot
write down the innocent sentence your pattern must not match, you have not
thought about the pattern enough.

## Known limits

- **Text-signal only for video content; autoplay controlled directly.** Video
  frames, audio tracks, and text baked into image pixels are invisible to
  scoring. Every *textual* signal attached to media is read — captions, video
  `aria-label`/`title`, image `alt` text incl. Instagram's generated
  descriptions. Because the text can't reach the video itself, the
  `media.video` setting governs what video may do: `hide` (default — every
  video is covered behind a click-to-play via `decide()`, nothing plays or
  shows until the user selects it, and revealing plays it in one gesture),
  `block` (video visible but paused; nothing autoplays), and `allow` (autoplay).
  Under `hide`/`block` the content-script play guard pauses and mutes every
  autoplay attempt, and `Scorer.blocksAutoplay` lets a real user click through
  via `navigator.userActivation`. The play guard is the reliable part: it hooks
  the `play` event in the capture phase and sweeps already-playing videos on
  every scan, so autoplay is stopped even for late-hydrating players and the
  boot-time race. A hateful video with a spotless caption still isn't
  *identified* — but under `hide`/`block` it can't
  autoplay at you, which is the part the user actually controls.
- **English-tuned.** Templates and lexicon are English; other languages are
  caught only where they borrow vocabulary.
- **Novel implication.** A static engine cannot read sarcasm or a code word
  invented last week. Lexicon curation is the ongoing work — and the natural
  subscription deliverable (see `docs/LICENSING.md`).
- **Rage bait is inherently subjective.** Hence its conservative defaults; be
  wary of lowering its threshold by default for all users.
