<!--
valyou — on-device social media content filtering.
Copyright (C) 2026 Sunayu LLC
Licensed under the GNU GPL v3.0 or later. See LICENSE and LICENSE-EXCEPTION.
-->

# Architecture documentation

**[How valyou Works](how-valyou-works.html)** — the whole system explained end to
end, assuming no prior engineering knowledge and detailed enough to onboard
an engineer. [PDF version](how-valyou-works.pdf) (19 pages).

Covers: finding posts on a hostile page, reading text a human would see, the
rulebook + five-judge model, applying hide/blur/tag, stopping video autoplay
before a frame renders, reading words out of memes, why nothing leaks, the one
engine behind four shells, and how every claim is tested — including the bugs
that taught us each lesson.

The other docs in `docs/` are the reference material this narrative summarises:
[ML.md](../ML.md) (model + corpora), [CLASSIFIER.md](../CLASSIFIER.md),
[CRYPTO-SPEC.md](../CRYPTO-SPEC.md), [API.md](../API.md),
[TESTING.md](../TESTING.md), [RELEASE.md](../RELEASE.md).

## Rebuilding the PDF

Rendered from the HTML with headless Chrome (light theme forced, backgrounds on):

    node scripts/build-arch-pdf.js
