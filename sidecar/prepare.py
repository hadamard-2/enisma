"""Turning stored page text into something each engine can actually speak.

Order is load-bearing throughout and is not interchangeable.
"""

from __future__ import annotations

import re
from typing import Callable

from num2words2 import num2words

from guards import assert_no_digits

# uroman's language codes, which are not the project's two-letter codes.
LCODE = {"am": "amh", "ti": "tir", "om": "orm"}

# Ethiopic numerals: ፩-፼.
_GEEZ_NUMERALS = re.compile(r"[፩-፼]+")
_ARABIC_DIGITS = re.compile(r"\d+")
# What the MMS character frontends actually contain, plus the three sentence
# marks that segment utterances. sherpa-onnx splits on '.', '!', '?' and ':'
# before it tokenizes, and drops the mark itself; every other punctuation
# character is skipped outright, producing a token sequence byte-identical to
# the one with no punctuation at all. So keeping a comma would buy nothing,
# while keeping these buys a real utterance boundary.
#
# ':' is deliberately NOT kept even though it segments: uroman folds ፥ and ፦
# onto it, but it is also the separator in times and ratios, where splitting
# the sentence at it would be wrong.
_UNSPEAKABLE = re.compile(r"[^A-Za-z'\s.!?]+")
_WHITESPACE = re.compile(r"\s+")

# None of the three tokens.txt files contains 'v' -- their alphabets are the 25
# letters a-z minus v, plus a space. uroman happily emits it for the ቨ-series
# (ቪዲዮ -> "vidiyo"), and because 'v' is a letter it survives _UNSPEAKABLE, so
# without this fold it reaches the frontend and is skipped mid-word: "vidiyo"
# is voiced as "idiyo". 'b' is the substitution Ethiopian speakers make for the
# same sound, so folding is closer than deleting.
_V_FOLD = str.maketrans({"v": "b", "V": "B"})

Romanize = Callable[[str, str], str]


def expand_numbers(text: str, language: str, romanize: Romanize) -> str:
    """Replace every numeral with words in the project's own language.

    Runs BEFORE romanization, so the words it emits are in Ge'ez script and get
    romanized by the same pass as the surrounding text. Emitting them in Latin
    instead is what made Tigrigna unintelligible: the model is trained on
    uroman's conventions, and a second transliteration scheme in the same
    sentence is out-of-distribution spelling.
    """
    lcode = LCODE[language]

    def from_geez(match: re.Match[str]) -> str:
        # uroman is the numeral parser: it maps ፫ -> 3 and ፻ -> 100 correctly,
        # which is exactly where abugida 0.3.4 fails. Applied to the numeral
        # run alone, before the whole-text pass.
        value = romanize(match.group(), lcode).strip()
        # int() consumes category Nd only, while str.isdigit() is also true for
        # ፩-፱ themselves -- so an unchanged numeral run would pass a bare
        # isdigit() check and crash in int(). Requiring ASCII narrows the test
        # to exactly what int() can parse, and leaves the declined run intact
        # for assert_no_digits to report.
        if not value.isascii() or not value.isdigit():
            return match.group()
        return f" {num2words(int(value), lang=language)} "

    text = _GEEZ_NUMERALS.sub(from_geez, text)
    text = _ARABIC_DIGITS.sub(
        lambda m: f" {num2words(int(m.group()), lang=language)} ", text
    )
    text = _WHITESPACE.sub(" ", text).strip()
    assert_no_digits(text, language)
    return text


def prepare_geez(text: str, language: str, romanize: Romanize) -> str:
    """Full pipeline for the three MMS languages."""
    expanded = expand_numbers(text, language, romanize)
    # uroman has already folded the Ge'ez marks onto ASCII -- ። to '.', ፧ to
    # '?' -- so keeping those preserves the sentence boundaries sherpa-onnx
    # segments on. ፣ and ፤ become ',' and ';', which segment nothing and are
    # stripped below.
    romanized = romanize(expanded, LCODE[language]).translate(_V_FOLD)
    stripped = _UNSPEAKABLE.sub(" ", romanized)
    return _WHITESPACE.sub(" ", stripped).strip()


# Kokoro's context is 512, and its style vector has exactly 510 ROWS, indexed by
# the chunk's token count (each voices/*.bin is 510 x 1 x 256 float32). 510 is a
# row COUNT, not a valid index: the rows are 0..509. The engine looks up
# styles[len(tokens)], so a 510-token chunk would ask for row 510, which does
# not exist. The largest token count that has a real style row is therefore 509,
# and that -- not 510 -- is the chunk ceiling. Do not "restore" it to 510.
# A page phonemizes to roughly 1586 tokens, so chunking is not optional here.
KOKORO_STYLE_ROWS = 510
KOKORO_TOKEN_LIMIT = KOKORO_STYLE_ROWS - 1

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_COMMA_SPLIT = re.compile(r"(?<=[,;:])\s*")
_SPACE_SPLIT = re.compile(r"\s+")


def tokenize(phonemes: str, vocab: dict[str, int]) -> list[int]:
    """Map phoneme characters to Kokoro's ids, dropping anything unmapped."""
    return [vocab[ch] for ch in phonemes if ch in vocab]


def _by_tokens(
    piece: str, vocab: dict[str, int], phonemize: Callable[[str], str]
) -> list[list[int]]:
    """Last resort: cut the token stream itself at the ceiling.

    Only reached by a single unbroken run with no sentence, clause, or space
    boundary inside it. The seam will sound bad; losing the text would be
    worse, and the ceiling is a measured property of the style vector, so it is
    the one thing that cannot bend.
    """
    tokens = tokenize(phonemize(piece), vocab)
    return [
        tokens[i : i + KOKORO_TOKEN_LIMIT]
        for i in range(0, len(tokens), KOKORO_TOKEN_LIMIT)
    ]


def _pack(
    pieces: list[str],
    vocab: dict[str, int],
    phonemize: Callable[[str], str],
    split_further: Callable[[str], list[list[int]]],
) -> list[list[int]]:
    """Greedily fill chunks with pieces, delegating any oversized piece.

    A piece that does not fit even alone is handed to `split_further` rather
    than truncated: no path here may drop text.
    """
    chunks: list[list[int]] = []
    current = ""
    for piece in pieces:
        if not piece.strip():
            continue
        candidate = f"{current} {piece}".strip() if current else piece.strip()
        if len(tokenize(phonemize(candidate), vocab)) > KOKORO_TOKEN_LIMIT:
            if current:
                chunks.append(tokenize(phonemize(current), vocab))
                current = ""
            if len(tokenize(phonemize(piece), vocab)) > KOKORO_TOKEN_LIMIT:
                chunks.extend(split_further(piece))
                continue
            current = piece.strip()
        else:
            current = candidate
    if current:
        chunks.append(tokenize(phonemize(current), vocab))
    return [c for c in chunks if c]


def chunk_english(
    text: str,
    vocab: dict[str, int],
    phonemize: Callable[[str], str],
) -> list[list[int]]:
    """Split a page into sentence-aligned chunks that fit the context.

    espeak-ng expands numbers itself during phonemization, so there is no
    number-to-words step on this path.

    Boundaries get finer only as far as they have to: sentences, then clauses
    (comma/semicolon/colon), then whitespace, then the raw token stream. Text
    is never truncated -- the concatenation of the chunks carries every token
    the input produced.
    """
    if not text.strip():
        return []

    def by_space(piece: str) -> list[list[int]]:
        return _pack(
            _SPACE_SPLIT.split(piece),
            vocab,
            phonemize,
            lambda p: _by_tokens(p, vocab, phonemize),
        )

    def by_clause(piece: str) -> list[list[int]]:
        return _pack(_COMMA_SPLIT.split(piece), vocab, phonemize, by_space)

    return _pack(_SENTENCE_SPLIT.split(text.strip()), vocab, phonemize, by_clause)
