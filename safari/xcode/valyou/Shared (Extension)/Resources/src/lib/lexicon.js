/*
 * valyou — on-device social media content filtering.
 * Copyright (C) 2026 Sunayu LLC
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional permission under GNU GPL version 3 section 7: this
 * Program may be distributed through the Apple App Store, Google Play,
 * or comparable platforms whose terms would otherwise be incompatible
 * with the GPL. See LICENSE-EXCEPTION.
 */

/**
 * Signal definitions for the on-device classifier.
 *
 * DESIGN NOTE — why this is mostly structural, not a word list.
 *
 * A long list of banned words is the obvious way to build a filter and the
 * worst-performing one: it misses everything phrased politely, and it fires
 * on quotation, news reporting, counter-speech, and reclaimed usage. valyou
 * therefore leans on *constructions* — "all <group> are <dehumanizing
 * predicate>", "<violence verb> the <group>" — which capture the thing that
 * actually makes a post hateful, and are far harder to paraphrase around.
 *
 * A slur and dogwhistle list still exists, because those terms carry no
 * non-attacking reading in feed context and catching them instantly is worth
 * it. Users extend coverage further through their own block terms in
 * settings.
 *
 * Every pattern carries a weight in 0..1 representing how much evidence a
 * single hit provides. The scorer combines hits probabilistically rather than
 * by summing, so several weak signals never silently add up to a certainty.
 *
 * BEGINNER ORIENTATION — what lives in this file.
 * This module exports nothing but *data*: lists of regular-expression patterns
 * grouped by what they detect (slurs, dogwhistles, hateful sentence templates,
 * rage-bait, and "mitigators" that argue the text is innocent). The companion
 * file scorer.js does the actual matching and math; this file is the dictionary
 * it reads from. Splitting data from logic keeps the patterns easy to audit and
 * lets the same rules be reused by a worker thread, a content script, or a test.
 *
 * HOW TO READ A PATTERN. Each entry is a plain object such as
 *   { re: /.../, categories: [...], weight: 0.9, why: "..." }
 * where `re` is the regex to test, `categories` names which harm buckets a hit
 * counts toward, `weight` is the 0..1 evidence strength, and `why` is the
 * human-readable reason shown in the UI. Regexes here are deliberately terse; the
 * inline comments break each one into its pieces so you can follow it token by
 * token.
 */

// -----------------------------------------------------------------------------
// UMD (Universal Module Definition) wrapper.
// This is an IIFE — an "Immediately Invoked Function Expression": a function that
// is defined and called in one go, `(function(...) {...})(...)`. Its whole job is
// to publish this module in whatever environment happens to load the file, WITHOUT
// leaking any local variable into the global namespace.
//   * `root`    — the global object, passed in below as `self` (browser/worker) or
//                 `globalThis` (Node, and modern everything).
//   * `factory` — the second function argument; it builds and returns the module.
// The body runs the factory once, then attaches the result two ways so every
// consumer can find it: as `root.VALYOU.Lexicon` for browser/worker script tags,
// and as `module.exports` for Node's `require()` (guarded by a typeof check so it
// is skipped in the browser where `module` does not exist).
(function (root, factory) {
  const mod = factory();
  // `root.VALYOU = root.VALYOU || {}` — reuse the shared namespace if another
  // valyou module already created it, otherwise start a fresh object.
  root.VALYOU = root.VALYOU || {};
  root.VALYOU.Lexicon = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  // Pick the correct global to hand in as `root`: `self` exists in browsers and
  // web/service workers; `globalThis` is the portable fallback (e.g. Node).
})(typeof self !== "undefined" ? self : globalThis, function () {
  // "use strict" opts this file into JavaScript's stricter parsing rules
  // (e.g. assigning to an undeclared variable throws instead of silently
  // creating a global). Standard hygiene at the top of a module body.
  "use strict";

  /**
   * Neutral nouns naming protected groups. On their own these are completely
   * benign — the point is the *company they keep*, which the templates below
   * test for. Kept as an alternation fragment so it can be spliced into
   * larger regexes.
   *
   * BEGINNER NOTES on the regex fragments in this list:
   *   - `(?:...)` is a NON-capturing group: it groups alternatives together
   *     without allocating a numbered capture, which is slightly faster and
   *     keeps later back-references from shifting.
   *   - `|` inside a group means "or" — e.g. `(?:s| people| folks)?` matches
   *     "s", or " people", or " folks".
   *   - the trailing `?` makes the preceding group OPTIONAL, so a bare word
   *     ("black") and its variants ("blacks", "black people") all match.
   *   - `[ae]` is a CHARACTER CLASS matching exactly one of the listed letters,
   *     so `wom[ae]n` catches both "woman" and "women" (and `m[ae]n` both
   *     "man"/"men") in a single pattern.
   * `.join("|")` at the end stitches every array item into one big
   * "this|that|other" alternation string that can be dropped into a larger
   * regex built with `new RegExp(...)` further down.
   */
  const GROUP = [
    "black(?:s| people| folks)?", "white(?:s| people)?", "asian(?:s)?",
    "arab(?:s)?", "jew(?:s|ish)?", "muslim(?:s)?", "christian(?:s)?",
    "hindu(?:s)?", "sikh(?:s)?", "latino(?:s)?", "latina(?:s)?",
    "hispanic(?:s)?", "mexican(?:s)?", "african(?:s)?", "indian(?:s)?",
    "chinese", "japanese", "korean(?:s)?", "immigrant(?:s)?",
    "migrant(?:s)?", "refugee(?:s)?", "foreigner(?:s)?",
    "wom[ae]n", "girl(?:s)?", "m[ae]n", "gay(?:s)?", "lesbian(?:s)?",
    "trans(?:gender)?(?: people)?", "queer(?:s)?", "disabled(?: people)?",
  ].join("|");

  /**
   * Predicates that turn a statement about a group into dehumanization:
   * vermin/disease framing, sub-human comparison, or blanket criminality.
   *
   * Same fragment conventions as GROUP above. Note `s?` on many entries makes
   * the plural "s" optional ("rat"/"rats"); `sub-?human` uses `-?` to allow an
   * optional hyphen so both "subhuman" and "sub-human" match; and
   * `not (?:real )?(?:humans?|people)` matches "not human", "not real humans",
   * "not people", etc. — the `(?:real )?` middle word being optional.
   */
  const DEHUMANIZING = [
    "animals?", "apes?", "vermin", "rats?", "roaches?", "cockroaches?",
    "parasites?", "cancer", "disease", "plague", "infestation", "filth",
    "subhuman", "sub-?human", "savages?", "scum", "trash", "garbage",
    "invaders?", "not (?:real )?(?:humans?|people)", "less than human",
    "inferior", "criminals?", "rapists?", "terrorists?", "thugs?", "leeches?",
  ].join("|");

  /**
   * Verbs of physical harm, used for both threat and incitement detection.
   * Spliced into templates below to catch "<violence verb> ... <group>"
   * constructions. Multi-word entries ("wipe out", "curb stomp") are kept as
   * literal phrases; `beat(?: up)?` makes the " up" optional so "beat" and
   * "beat up" both match.
   */
  const VIOLENCE_VERB = [
    "kill", "murder", "shoot", "stab", "behead", "hang", "lynch", "gas",
    "exterminate", "eradicate", "wipe out", "get rid of", "round up",
    "deport by force", "beat(?: up)?", "bash", "curb stomp", "burn",
    "bomb", "rape", "torture", "execute", "put down", "eliminate",
  ].join("|");

  /**
   * Slur patterns, matched against the DEOBFUSCATED text (see lib/text.js),
   * which has leetspeak folded and letter-spacing welded back together but
   * still has its word boundaries. That combination is what lets these be
   * \b-anchored: evasion is defeated, and a slur can never be found spanning
   * two innocent words.
   *
   * Where a benign word shares a prefix, the pattern says so explicitly
   * rather than relying on the anchor alone.
   *
   * BEGINNER NOTES on the regex machinery used throughout this list:
   *   - `\b` is a WORD BOUNDARY: a zero-width position between a word character
   *     (letter/digit/underscore) and a non-word character (space, punctuation,
   *     start/end of string). Wrapping a term in `\b...\b` means it must appear
   *     as a standalone token, so the slur is never found buried inside an
   *     innocent longer word.
   *   - `(?!...)` is a NEGATIVE LOOKAHEAD: "match only if what follows is NOT
   *     this". It consumes nothing; it just vetoes a match. `(?<!...)` is the
   *     mirror image, a NEGATIVE LOOKBEHIND ("...only if what PRECEDES is not").
   *   - `[i1]` (character class) lets a letter or its leetspeak digit match, a
   *     cheap defense against "n1gg..." style evasion on top of the heavier
   *     deobfuscation done in text.js before these ever run.
   * Each object's `weight` is tuned to how unambiguous the term is: unambiguous
   * slurs sit high (0.8-0.92) and words with a real innocent reading sit low,
   * on purpose, so they cannot trip the filter alone (see the 0.55 threshold
   * discussion in scorer.js).
   */
  const SLUR_PATTERNS = [
    // `n[i1]gg(?:er|a|ah)s?` — the leet-tolerant stem, then one of the endings
    // "er"/"a"/"ah", then an optional plural "s"; `\b` on both ends keeps it a
    // whole word. High weight: no benign reading in feed context.
    { re: /\bn[i1]gg(?:er|a|ah)s?\b/, categories: ["hate_racial", "harassment"], weight: 0.92 },
    { re: /\bkikes?\b/, categories: ["hate_racial"], weight: 0.85 },
    { re: /\bchinks?\b/, categories: ["hate_racial"], weight: 0.8 },
    { re: /\bgooks?\b/, categories: ["hate_racial"], weight: 0.85 },
    // \b alone would still allow "spice"/"spick"; the negative lookahead is
    // what keeps cooking posts out of the hate bucket.
    { re: /\bspics?\b(?!e|y|k)/, categories: ["hate_racial"], weight: 0.7 },
    { re: /\bwetbacks?\b/, categories: ["hate_racial"], weight: 0.85 },
    { re: /\bbeaners?\b/, categories: ["hate_racial"], weight: 0.75 },
    { re: /\btow?elheads?\b|\bragheads?\b|\bsandn[i1]gg/, categories: ["hate_racial"], weight: 0.9 },
    // The lookbehind spares the cat breed ("maine coon").
    { re: /(?<!maine )\bcoons?\b/, categories: ["hate_racial"], weight: 0.65 },
    { re: /\bporch monke?ys?\b|\bjungle bunn(?:y|ies)\b/, categories: ["hate_racial"], weight: 0.9 },
    // \b keeps "pakistan"/"pakistani" safe: no boundary after "paki" there.
    { re: /\bpakis?\b/, categories: ["hate_racial"], weight: 0.8 },
    { re: /\binjuns?\b|\bsquaws?\b|\bredskins?\b(?! game| fans?)/, categories: ["hate_racial"], weight: 0.7 },
    // Below the default 0.55 threshold on purpose: "negro" is the ordinary
    // Spanish/Portuguese word for the colour black, so a single occurrence
    // must never act alone — it only contributes alongside other signals.
    { re: /\bnegro(?:es|s)?\b|\bnegress\b/, categories: ["hate_racial"], weight: 0.45 },
    { re: /\bfagg?ots?\b|\bfags\b/, categories: ["hate_gender", "harassment"], weight: 0.9 },
    { re: /\btrann(?:y|ie|ies|ys)\b/, categories: ["hate_gender", "harassment"], weight: 0.85 },
    { re: /\bshemales?\b/, categories: ["hate_gender"], weight: 0.75 },
    // Also a surname (van dyke) and a UK spelling of "dike", so it stays
    // below the acting threshold on its own.
    { re: /\bdykes?\b/, categories: ["hate_gender", "harassment"], weight: 0.5 },
    { re: /\bcunts?\b/, categories: ["hate_gender", "harassment"], weight: 0.75 },
    // Incel-community coinages for women. Unlike "dyke" these have no benign
    // homograph, so they can carry full weight.
    { re: /\bfem[o0]ids?\b|\bfoids?\b|\broast(?:ie|ies)\b/, categories: ["hate_gender"], weight: 0.8 },
    { re: /\bretard(?:ed|s)?\b/, categories: ["harassment"], weight: 0.55 },
  ];

  /**
   * Coded hate and extremist dogwhistles.
   *
   * This is the vocabulary built specifically to slip past word filters —
   * numbers standing in for slogans, meme-phrases standing in for ideology.
   * It rotates slower than people assume: most of these have been stable for
   * five to fifteen years, which is what makes a static list worthwhile.
   * Weights are high because, unlike an ambiguous insult, these phrases have
   * essentially no innocent usage in feed context; the mitigators still damp
   * them in reporting/educational framing.
   *
   * BEGINNER NOTE: every regex here ends with the `i` flag (e.g. `/.../i`),
   * meaning CASE-INSENSITIVE — "SIEG HEIL" and "sieg heil" match the same. Each
   * entry also carries an `id` (stable key used in tests and telemetry) and a
   * `why` string surfaced to the user, in addition to the `re`/`categories`/
   * `weight` seen above.
   */
  const DOGWHISTLE_PATTERNS = [
    {
      id: "replacement_conspiracy",
      // `\b(?: A | B | C )\b/i` — a whole-word match of any one listed slogan.
      // `race traitors?` allows the optional plural "s"; the rest are literals.
      re: /\b(?:great replacement|white genocide|race traitors?|blood and soil|day of the rope)\b/i,
      categories: ["hate_racial"],
      weight: 0.85,
      why: "White-nationalist slogan or conspiracy phrase",
    },
    {
      id: "nazi_numerics",
      // Four alternatives joined by top-level `|`. `\b1488\b` matches the
      // numeric code as a standalone token (so it won't fire inside "214880");
      // the rest are literal phrases.
      re: /\b1488\b|\b14 words\b|\bsieg heil\b|\bheil hitler\b/i,
      categories: ["hate_racial"],
      weight: 0.9,
      why: "Neo-Nazi slogan or numeric code",
    },
    {
      id: "holocaust_celebration",
      re: /\b(?:6|six) ?million (?:wasn'?t|was not) enough\b/i,
      categories: ["hate_racial", "violence"],
      weight: 0.95,
      why: "Celebrates the Holocaust",
    },
    {
      id: "antisemitic_code",
      // The echo wraps a NAME — one to three plain words, no punctuation.
      // "(((whole sarcastic sentences)))" are ordinary typography and must
      // not match, so the inner pattern forbids commas and caps the word
      // count rather than just the length.
      re: /\(\(\(\s*\w[\w'-]*(?:\s+\w[\w'-]*){0,2}\s*\)\)\)|\bzog\b|\bgoyim know\b|\bjewish question\b/i,
      categories: ["hate_racial"],
      weight: 0.8,
      why: "Antisemitic code or meme",
    },
    {
      id: "racist_memes",
      re: /\bdindu(?:s| nuffin)\b|\bwe ?wuz ?(?:kangz?|kingz)\b|\b13\/50\b/i,
      categories: ["hate_racial"],
      weight: 0.85,
      why: "Racist meme phrase",
    },
    {
      id: "nativist_expulsion",
      // `to` is optional: "go back where you came from" is every bit as common
      // as "go back TO where you came from", and requiring the preposition let
      // the shorter phrasing through untouched.
      re: /\bgo back (?:to )?(?:your (?:own )?country|africa|mexico|china|india|where you came from)\b|\bspeak english or (?:leave|get out)\b/i,
      categories: ["hate_racial"],
      weight: 0.8,
      why: "Tells people to leave the country based on origin",
    },
    {
      id: "religion_as_disease",
      re: /\b(?:islam|judaism|christianity|hinduism)\s+is\s+(?:a\s+)?(?:cancer|disease|plague|virus|mental illness)\b/i,
      categories: ["hate_racial"],
      weight: 0.8,
      why: "Frames an entire religion as a disease",
    },
    {
      id: "lgbt_groomer_smear",
      // Co-occurrence, not the bare word: "groomer" is an ordinary word (dogs,
      // horses, weddings), so it only counts aimed at an LGBT referent.
      // `[^.!?]{0,50}` is a BOUNDED GAP: "up to 50 characters that are none of
      // . ! or ?" — i.e. the two terms must appear near each other but WITHIN
      // the same sentence (a sentence-ending punctuation mark breaks the span).
      // The pattern is written twice, `A gap B | B gap A`, so the two words
      // count in either order. `lgbtq?\+?` allows "lgbt"/"lgbtq"/"lgbtq+" (the
      // `?` makes the "q" optional, `\+?` an optional literal "+").
      re: /\b(?:trans(?:gender)?|lgbtq?\+?|gays?|drag queens?|queers?)\b[^.!?]{0,50}\bgroomers?\b|\bgroomers?\b[^.!?]{0,50}\b(?:trans(?:gender)?|lgbtq?\+?|drag queens?)\b/i,
      categories: ["hate_gender"],
      weight: 0.75,
      why: "'Groomer' smear aimed at LGBT people",
    },
    {
      id: "white_power",
      // The lookahead spares "white power washer/washing" — pressure-washing
      // equipment, a genuine false positive found by the test guards.
      re: /\bwhite power\b(?! wash)|\bwhite pride world ?wide\b/i,
      categories: ["hate_racial"],
      weight: 0.75,
      why: "White-supremacist slogan",
    },
  ];

  /**
   * Template patterns run against the CONSERVATIVELY normalized text, where
   * word boundaries still exist. Each has an explanatory `why` string which
   * surfaces in the UI so a user can always see why something was filtered.
   *
   * These are the heart of the "structural, not a word list" design from the
   * top of this file: they detect the SHAPE of a hateful sentence — a subject,
   * a linking verb, and a dehumanizing/violent predicate — rather than any one
   * banned word.
   *
   * BEGINNER NOTE on `new RegExp(...)` vs a `/.../ ` literal. Several patterns
   * are built from strings so they can splice in the shared `${GROUP}` /
   * `${DEHUMANIZING}` / `${VIOLENCE_VERB}` alternations via template literals.
   * The catch: in a STRING, a backslash must itself be escaped, so a regex
   * `\b` (word boundary) is written `\\b` and `\s` (whitespace) as `\\s`. Read
   * every `\\` here as the single `\` it will become once the string is
   * compiled into a RegExp. The second argument `"i"` is the case-insensitive
   * flag, same as a trailing `/i` on a literal.
   */
  const TEMPLATE_PATTERNS = [
    {
      id: "group_dehumanized",
      // Shape: (quantifier) (group) (be-verb) (optional intensifier) (predicate)
      //   `(?:all|every|these|those|the)`  a leading quantifier/determiner
      //   `\\s+`                            one or more spaces between words
      //   `(?:${GROUP})`                    any protected-group noun
      //   `(?:are|is|r)`                    a linking verb ("r" = texting "are")
      //   `(?:just |nothing but |literally )?`  optional intensifier
      //   `(?:${DEHUMANIZING})`             the dehumanizing predicate
      // e.g. matches "all <group> are just vermin".
      re: new RegExp(
        `\\b(?:all|every|these|those|the)\\s+(?:${GROUP})\\s+(?:are|is|r)\\s+(?:just\\s+|nothing but\\s+|literally\\s+)?(?:${DEHUMANIZING})`,
        "i"
      ),
      categories: ["hate_racial", "hate_gender"],
      weight: 0.88,
      why: "Describes an entire group as sub-human or inherently criminal",
    },
    {
      id: "group_inferior",
      re: new RegExp(
        `\\b(?:${GROUP})\\s+(?:are|is)\\s+(?:genetically\\s+|naturally\\s+|inherently\\s+)?(?:inferior|stupid|dumb|worthless|useless|lesser)`,
        "i"
      ),
      categories: ["hate_racial", "hate_gender"],
      weight: 0.82,
      why: "Asserts a group is inherently inferior",
    },
    {
      id: "group_should_not_exist",
      re: new RegExp(
        `\\b(?:${GROUP})\\s+(?:should(?:n't| not)?|shouldnt|don't|dont|do not)\\s+(?:exist|be allowed|have rights|be here|breed|reproduce)`,
        "i"
      ),
      categories: ["hate_racial", "hate_gender"],
      weight: 0.86,
      why: "Denies a group's right to exist or hold rights",
    },
    {
      id: "violence_against_group",
      // "<violence verb> ...within one sentence... <group>". The `[^.!?]{0,24}`
      // bounded gap (see the groomer note above) keeps the verb and the group
      // close and in the same sentence, so "kill the <group>" fires but
      // "I had to kill time. The <group> event was nice." does not.
      re: new RegExp(`\\b(?:${VIOLENCE_VERB})\\b[^.!?]{0,24}\\b(?:${GROUP})\\b`, "i"),
      categories: ["violence", "hate_racial"],
      weight: 0.9,
      why: "Calls for or celebrates violence against a group",
    },
    {
      id: "mass_violence_imperative",
      // A call to kill a whole group, stated as a bare order — the shape
      // `direct_threat` misses because it requires an "I am going to…" preamble.
      //
      // The FIRST version of this pattern matched a violence verb plus a bare
      // pronoun, and it was a disaster on a real feed: "shoot them a quick
      // email", "burn it down and rebuild the roster", "wipe them out in the
      // tournament tonight", "kill it with fire lol" were all hidden. Eight of
      // ten ordinary sentences tripped it. English recycles violent verbs for
      // enthusiasm constantly, so the verb and the pronoun together carry
      // almost no signal.
      //
      // A real call for mass violence names WHO. So the sentence must also
      // contain a protected group or a dehumanizing noun, on either side of
      // the verb, within the same sentence.
      re: new RegExp(
        `\\b(?:kill|gas|exterminate|eradicate|slaughter)\\s+(?:them|em|these|those)\\s*(?:all)?\\b[^.!?]{0,40}\\b(?:${GROUP}|${DEHUMANIZING})\\b` +
          `|\\b(?:${GROUP}|${DEHUMANIZING})\\b[^.!?]{0,40}\\b(?:kill|gas|exterminate|eradicate|slaughter)\\s+(?:them|em|these|those)\\s*(?:all)?\\b`,
        "i"
      ),
      categories: ["violence"],
      weight: 0.9,
      why: "Calls for killing an entire group",
    },
    {
      id: "deserves_death",
      // "they/those animals deserve to die", "every one of them should die".
      // Distinct from wish_harm, which needs "hope/wish" and a single person.
      // Also needs a target: "he deserves to die" is said about fictional
      // villains and losing teams every day. Requiring a group or dehumanizing
      // noun in the same sentence keeps the phrase meaningful.
      re: new RegExp(
        `\\b(?:${GROUP}|${DEHUMANIZING})\\b[^.!?]{0,40}\\b(?:deserves?|deserved)\\s+to\\s+(?:die|be\\s+(?:killed|shot|hanged|gassed))\\b` +
          `|\\b(?:deserves?|deserved)\\s+to\\s+(?:die|be\\s+(?:killed|shot|hanged|gassed))\\b[^.!?]{0,40}\\b(?:${GROUP}|${DEHUMANIZING})\\b`,
        "i"
      ),
      categories: ["violence"],
      weight: 0.85,
      why: "Says people deserve to die",
    },
    {
      id: "direct_threat",
      // Shape: "I ('m/am/will) (gonna/going to/will) <harm verb> (you/him/...)".
      // The subject+intent preamble `i ... gonna/going to/will` is required, so
      // this fires on a stated INTENT to harm a person, not on the verb alone.
      // `\\s+` (here `\s+`) is one-or-more spaces; `u` covers texting "you".
      re: /\b(?:i(?:'m| am| will| ll)?\s+(?:gonna|going to|will)\s+)(?:kill|shoot|stab|beat|hurt|find|end)\s+(?:you|him|her|them|u)\b/i,
      categories: ["violence", "harassment"],
      weight: 0.93,
      why: "Direct threat of violence against a person",
    },
    {
      id: "wish_harm",
      re: /\b(?:hope|wish)\s+(?:you|he|she|they|it)\s+(?:die|dies|gets? (?:shot|raped|killed|hit)|burns?)\b/i,
      categories: ["violence", "harassment"],
      weight: 0.85,
      why: "Wishes death or serious harm on a person",
    },
    {
      id: "kill_yourself",
      re: /\b(?:kill\s*your\s*self|kys|neck\s*yourself|go\s+die)\b/i,
      categories: ["harassment", "violence"],
      weight: 0.9,
      why: "Tells someone to kill themselves",
    },
    {
      id: "sexist_place",
      re: /\b(?:wom[ae]n|girls|females)\s+(?:belong|should stay|should get back)\s+(?:in|to)\s+(?:the\s+)?(?:kitchen|home|bedroom)\b/i,
      categories: ["hate_gender"],
      weight: 0.85,
      why: "Classic misogynistic 'a woman's place' construction",
    },
    {
      id: "sexist_place_pronoun",
      // The same "a woman's place" trope, but stated across a clause:
      // "women are too emotional … THEY belong in the kitchen". `sexist_place`
      // needs the gendered noun adjacent to the verb, so this shape escaped it.
      // The gendered noun is still REQUIRED earlier in the same sentence, so a
      // bare "they belong in the kitchen" (about knives, or chefs) is untouched.
      re: /\b(?:wom[ae]n|girls|females)\b[^.!?]{0,90}\b(?:they|she)\s+belongs?\s+(?:in|to)\s+(?:the\s+)?(?:kitchen|home|bedroom)\b/i,
      categories: ["hate_gender"],
      weight: 0.85,
      why: "Classic misogynistic 'a woman's place' construction",
    },
    {
      id: "sexist_incapable",
      re: /\b(?:wom[ae]n|females|girls)\s+(?:can'?t|cannot|shouldn'?t|are too \w+(?: and \w+)? to)\s+(?:drive|lead|code|think|do math|be trusted|handle|be in charge|be leaders?|run anything|vote)\b/i,
      categories: ["hate_gender"],
      weight: 0.78,
      why: "Asserts women are inherently incapable",
    },
    {
      id: "objectifying_reduction",
      re: /\b(?:females?|women)\s+(?:are|is)\s+(?:just\s+)?(?:objects?|property|holes?|meat|for\s+(?:breeding|cooking|sex))\b/i,
      categories: ["hate_gender", "harassment"],
      weight: 0.88,
      why: "Reduces women to objects or possessions",
    },
    {
      id: "she_deserved_it",
      re: /\b(?:she|he|they)\s+(?:deserved|was asking for)\s+(?:it|to be (?:raped|hit|beaten))\b/i,
      categories: ["violence", "hate_gender"],
      weight: 0.82,
      why: "Justifies violence against a victim",
    },
    {
      id: "personal_degradation",
      re: /\byou(?:'re| are|r)\s+(?:a\s+)?(?:worthless|pathetic|disgusting|repulsive|subhuman|waste of (?:space|oxygen|air))\b/i,
      categories: ["harassment"],
      weight: 0.72,
      why: "Direct degrading attack on a person",
    },
    {
      id: "mass_violence_place",
      re: /\b(?:shoot|blow) up (?:a |the |that |your )?(?:school|church|mosque|synagogue|temple|mall|office|place)\b/i,
      categories: ["violence"],
      weight: 0.92,
      why: "References attacking a public place",
    },
    {
      id: "intimidation",
      re: /\bi know where you live\b|\bsleep with one eye open\b|\byou better watch (?:your back|yourself|out)\b/i,
      categories: ["violence", "harassment"],
      weight: 0.8,
      why: "Intimidation implying physical harm",
    },
    {
      id: "execution_fantasy",
      // "hang them up" is what you do with pictures, coats and jerseys, so the
      // bare phrase cannot stand alone; "string them up" has no such innocent
      // reading and stays. Found by testing against ordinary sentences.
      re: /\bstring them (?:all )?up\b|\bhang them (?:all )?up\s+(?:by|from)\s+(?:the\s+)?(?:neck|noose|tree|lamp\s?post)\b|\bput them (?:all )?against the wall\b|\bdeserves? a bullet\b|\brope for (?:all of )?them\b/i,
      categories: ["violence"],
      weight: 0.88,
      why: "Fantasizes about executing people",
    },
    {
      id: "worthless_existence",
      re: /\bnobody would (?:even )?miss you\b|\bdo the world a favou?r and (?:leave|disappear|end it)\b/i,
      categories: ["harassment"],
      weight: 0.85,
      why: "Tells someone the world is better off without them",
    },
  ];

  /**
   * Rage-bait signals. Individually weak — a share prompt is not by itself a
   * problem — so weights are low and the scorer requires several to combine
   * before it will act. This is the category most prone to false positives,
   * which is why its default action is `blur` and its threshold is the
   * highest in DEFAULT_SETTINGS.
   *
   * BEGINNER NOTE: unlike the slur/template lists, these entries carry NO
   * `categories` field — every hit feeds the single "rage_bait" category (the
   * scorer wires that up), so only `id`/`re`/`weight`/`why` appear here. Weights
   * sit in the 0.35-0.5 band precisely because each marker is individually weak.
   */
  const RAGE_BAIT_PATTERNS = [
    {
      id: "share_demand",
      re: /\b(?:share|repost|retweet)\s+(?:this\s+)?if\s+you\b|\b1\s*(?:like|share)\s*=\s*\d/i,
      weight: 0.35,
      why: "Engagement-bait share demand",
    },
    {
      id: "suppressed_truth",
      re: /\b(?:they|the media|big pharma|the government)\s+(?:don'?t|do not|doesn'?t)\s+want you to (?:know|see|hear)\b/i,
      weight: 0.45,
      why: "Manufactured 'suppressed truth' framing",
    },
    {
      id: "wake_up",
      re: /\bwake up,?\s*(?:people|sheeple|america|everyone)\b|\bsheeple\b/i,
      weight: 0.4,
      why: "Tribal 'wake up' provocation",
    },
    {
      id: "outrage_verbs",
      re: /\b(?:destroys?|obliterates?|owns?|slams?|eviscerates?|humiliates?)\s+(?:\w+\s+){0,3}(?:liberal|conservative|leftist|rightwing|right-wing|democrat|republican|woke|maga)/i,
      weight: 0.42,
      why: "Conflict-framing headline aimed at an out-group",
    },
    {
      id: "political_slur",
      re: /\b(?:libtard|repuglican|demonrat|magat|snowflake(?:s)?|cuck(?:s)?|nazi scum)\b/i,
      weight: 0.5,
      why: "Derogatory label for a political out-group",
    },
    {
      id: "enemy_framing",
      re: /\b(?:these people|the left|the right|they)\s+(?:are|want to)\s+(?:destroying|destroy|ruining|ruin|invading|erasing)\s+(?:our|this)\s+(?:country|culture|children|values|way of life)\b/i,
      weight: 0.5,
      why: "Frames an out-group as an existential threat",
    },
    {
      id: "you_wont_believe",
      re: /\byou\s+won'?t\s+believe\b|\bwhat happened next\b|\bthis will make you (?:sick|furious|angry)\b/i,
      weight: 0.35,
      why: "Clickbait outrage hook",
    },
    {
      id: "censorship_urgency",
      re: /\b(?:share|repost|save|screenshot) (?:this )?before (?:they|it(?:'s| is| gets)?) (?:delete|remove|take|taken|censor|ban)/i,
      weight: 0.45,
      why: "Manufactured 'about to be censored' urgency",
    },
    {
      id: "coming_for_you",
      re: /\bthey(?:'re| are)? coming for your (?:kids|children|guns|jobs|country|way of life)\b/i,
      weight: 0.5,
      why: "Fear-mongering 'they are coming for you' framing",
    },
  ];

  /**
   * Mitigating signals. These reduce confidence because they mark the text as
   * *reporting on* or *objecting to* hateful content rather than producing it.
   * Without this, valyou would filter the very people pushing back — a
   * failure mode that makes a moderation tool actively harmful.
   *
   * IMPORTANT: these weights work in the OPPOSITE direction from every list
   * above. The scorer treats a mitigator hit as a reason to DAMP the score
   * (multiply it down), not raise it — so here a higher weight means "trust
   * this innocent framing more". See the multiplicative-damping section of
   * scorer.js#scoreText for exactly how these are applied and capped.
   */
  const MITIGATOR_PATTERNS = [
    {
      id: "counter_speech",
      re: /\b(?:this is (?:disgusting|vile|awful|unacceptable|racist|sexist)|report(?:ed|ing) (?:this|him|her|them)|do better|not ok(?:ay)?|call(?:ing)? (?:this|it) out|please stop)\b/i,
      weight: 0.45,
      why: "Reads as objection to, not endorsement of, the content",
    },
    {
      id: "quotation",
      // Two ways to look quoted. First alt: a run of 20+ characters wrapped in
      // quotes — `(?:^|\s)` requires the opening quote to start a token, the
      // class `["“]` accepts a straight OR a curly opening quote, `[^"”]{20,}`
      // is "at least 20 non-quote characters" (long enough to be a real
      // quotation, not scare-quotes on one word), then a closing quote. Second
      // alt: an attribution phrase like "she said" / "the article wrote".
      re: /(?:^|\s)["“][^"”]{20,}["”]|\b(?:he|she|they|the article|the post) (?:said|wrote|claimed|posted)\b/i,
      weight: 0.3,
      why: "Content appears to be quoted or attributed to someone else",
    },
    // Attribution and legal-proceedings language are kept as SEPARATE signals
    // rather than one combined pattern, because a news report about violence
    // typically contains both ("according to police… charged with…") and the
    // two must compound. As a single pattern they fired once and left a crime
    // report scoring 0.63 — above the default hide threshold for violence.
    {
      id: "news_attribution",
      re: /\b(?:according to|reports? that|reported that|sources? say|study finds?|research shows?|investigators?)\b/i,
      weight: 0.35,
      why: "Attributed to a source rather than stated first-hand",
    },
    {
      id: "legal_proceedings",
      re: /\b(?:charged with|sentenced to|convicted of|pleaded (?:guilty|not guilty)|arrested (?:for|on)|court (?:heard|documents)|indicted|on trial|police (?:say|said|reports?))\b/i,
      weight: 0.4,
      why: "Describes a criminal case rather than endorsing the act",
    },
    {
      id: "educational",
      re: /\b(?:history of|the term|is a slur|why (?:this|it) is (?:harmful|offensive)|content warning|CW:|TW:)\b/i,
      weight: 0.35,
      why: "Reads as educational or explicitly content-warned",
    },
  ];

  // The factory's return value IS the module (`mod` in the wrapper up top).
  // Everything listed here becomes a property of `VALYOU.Lexicon`; anything not
  // listed stays private to this file. This is the module's public surface —
  // the raw fragments (GROUP/DEHUMANIZING/VIOLENCE_VERB) are exported too so
  // tests and any future patterns can reuse the same building blocks.
  return {
    GROUP,
    DEHUMANIZING,
    VIOLENCE_VERB,
    SLUR_PATTERNS,
    DOGWHISTLE_PATTERNS,
    TEMPLATE_PATTERNS,
    RAGE_BAIT_PATTERNS,
    MITIGATOR_PATTERNS,
  };
});
