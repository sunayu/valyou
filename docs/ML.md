# The ML assist

valyou ships a small machine-learning model that generalizes past the pattern
lexicon. This document is the honest account of what it is, how it was
trained, exactly how well it works, and — most importantly — its biases and
why the architecture bounds them.

Implementation: `src/lib/ml.js` (inference), `scripts/train-model.js`
(training), `scripts/fetch-training-data.js` (corpus), `src/model/model-data.js`
(the shipped weights — v2: five heads, ~430 KB int8-quantized).

---

## What it is

A **logistic-regression classifier over hashed n-gram features** — the
fastText / Vowpal-Wabbit family. Not a neural network, not a transformer, by
deliberate choice: this is the only model class that satisfies every product
constraint simultaneously.

| Constraint | How this model meets it |
| --- | --- |
| Zero dependencies | Pure-JS inference: one hash + one sparse dot product. No WASM, no ONNX, no runtime |
| Zero network | The whole model is a 86 KB weight file bundled with the extension |
| Sub-millisecond scan path | ~0.02 ms per post — comfortably inside the 0.25 ms budget (tested) |
| Explainable | Every prediction decomposes into per-feature contributions; the assist surfaces its confidence in the "Try it" breakdown |
| Offline | Nothing to download, ever |

**Features** (defined once in `ml.js#features`, imported by the trainer so
training and serving cannot drift):

- word unigrams and bigrams over normalized text — topical and phrasing signal
- character 3- and 4-grams over *de-obfuscated* text — morphology signal,
  robust to the same misspelling/leetspeak evasions the lexicon defeats

Hashed into 2^16 buckets, binary presence, L2-normalized. Weights are
quantized to int8 (a single global scale) to keep the file small.

## What it adds over the lexicon

Generalization. The pattern rules match constructions someone anticipated;
the model responds to the *statistics* of hostile language, so it catches
phrasings with no matching pattern and misspellings no regex covers. It is
strictly **additive**: with the model off, valyou is exactly the pattern
classifier it was before.

## How it is trained (v2 — multi-head)

v2 replaced the single binary "hate" head with **five independent logistic
heads — one per product category — sharing one feature extraction** (word
uni/bi-grams + character 3-5-grams, hashed into 65,536 buckets). Each head
routes its evidence to its own category in the scorer, so "racist language"
strengthens `hate_racial`, not a blur across three categories.

- **Corpora** (~530k labeled rows, ≈20× v1; all public, permissive licenses;
  `training-data/` is gitignored — regenerate, never commit):
  - **civil_comments** (Jigsaw/Google, CC0, ~2M comments): `identity_attack`
    → hate_racial, `threat` → violence, `insult`/`toxicity` → harassment,
    low-toxicity comments → the shared clean-negative pool.
  - **EDOS** (SemEval-2023 Task 10, Kirk et al.): 20k Gab/Reddit posts
    labeled for sexism → hate_gender; its "threats" subclass → violence.
  - **HateXplain** (Mathew et al., AAAI 2021): 20k posts with TARGET-GROUP
    labels — racial/ethnic/religious targets → hate_racial, women/LGBTQ
    targets → hate_gender.
  - **Davidson 2017** (ICWSM): hate → hate_racial, offensive → harassment.
  - **Stop Clickbait** (Chakraborty et al. 2016): 32k headlines → rage_bait.
- **Method**: per-head L2-regularized logistic regression by SGD, 8 epochs
  with learning-rate decay, inverse-frequency class weighting (capped 8×),
  fixed seed → bit-reproducible. Each head's **operating floor (`minProb`)
  is measured, not guessed**: the 99.5th percentile of held-out NEGATIVE
  scores, so "clean text almost never moves the needle" is a property the
  trainer enforces per head.
- **Reproduce**: build the corpus per the recipe above (fetch scripts +
  `prep_corpus.py` documented in the trainer header), then
  `node scripts/train-model.js`.

## Measured performance (held-out 10%, v2)

| Head | AUC | Floor | Precision @ floor | Recall @ floor |
| --- | --- | --- | --- | --- |
| hate_racial | 0.967 | 0.90 | 0.90 | 0.63 |
| hate_gender | 0.897 | 0.90 | 0.90 | 0.34 |
| violence | 0.970 | 0.90 | 0.97 | 0.53 |
| harassment | 0.981 | 0.90 | 0.98 | 0.72 |
| rage_bait | 0.995 | 0.88 | 0.98 | 0.85 |

Night-and-day versus v1 (precision 0.34 at its floor): every v2 head is
**high-precision at its floor** — when a head speaks, it is right 9 times in
10 or better — with recall left conservative on purpose. The assist still
never decides alone (below), so missed recall costs little: the pattern
lexicon still catches overt slurs, and the model catches the phrasing the
lexicon cannot. Inference is ~0.02 ms for ALL five heads together (the
feature pass dominates; the dot products share it).

## The safety bound — why weak precision is acceptable

The model's output maps to a scorer signal weight capped at
`ML.MAX_WEIGHT = 0.5`, which sits **below every default action threshold**
(0.55 / 0.60 / 0.70). Consequences, all enforced by tests:

- On default settings, the model **cannot filter anything by itself**. Where
  patterns find nothing, a model-only signal of ≤ 0.5 crosses no threshold.
  (`test/scorer-ml.test.js`: "the model alone cannot cross a default
  threshold".)
- It can only **reinforce** existing pattern evidence, tipping a genuine
  borderline case over the line — or surface in the "Try it" breakdown so the
  user sees why.
- A user who lowers a threshold below 0.5 is explicitly opting to let the
  model act more freely; that is their informed choice.

So the model's false positives are bounded to "occasionally nudged a score
that was already climbing", never "hid a clean post". That is the whole
design: **a biased judge would be dangerous; a bounded, biased hint is not.**

## Known biases — stated plainly

Every hate-speech model inherits its corpus's biases, and this one is small,
so they show clearly:

- **Slur/threat-heavy.** The Davidson positives are dominated by explicit
  slurs and overt abuse. Polished, "respectable" hate — *"women belong in the
  kitchen"*, formal genocidal phrasing — scores weakly. The lexicon's
  structural templates are what actually catch those; the model is not a
  substitute for them.
- **Dialect confounding.** The corpus is documented (by its own authors and
  subsequent research, e.g. Sap et al. 2019) to conflate African-American
  English with "offensive", because annotators did. Training the positive
  class as *hate only* (not offensive) reduces but does not eliminate this
  exposure. The `MAX_WEIGHT` cap is the backstop: a dialect-driven false
  positive can never filter a post on its own.
- **English, informal, short-text.** Trained on tweets; weaker on long-form
  and non-English, like the rest of the classifier.
- **Static.** It reflects 2017-era language; novel coded terms need lexicon
  updates, which is the natural subscription deliverable (see LICENSING.md).

We ship this model *because* it is bounded, explainable, and honest about its
limits — not because it is strong. If a future version wants a stronger model,
the bar it must clear is not "higher F1" but "does it stay this auditable and
this safe when wrong".

## Regenerating / replacing the model

1. `node scripts/fetch-training-data.js` — pulls the corpus into
   `training-data/` (gitignored).
2. `node scripts/train-model.js` — writes `src/model/model-data.js` and prints
   held-out metrics.
3. `npm test` — the ML and scorer-ML suites verify feature-schema match, the
   safety cap, the operating point, and no-clean-false-positive behavior.
4. If `ML.FEATURE_VERSION` changed, old model files are rejected at load by
   design — bump it whenever `features()` changes so a stale model fails loud.

To use a different corpus, replace `fetch-training-data.js` and the `parse()`
step in the trainer; keep the label discipline (hate-only positive) and the
feature function (imported, never re-implemented).
