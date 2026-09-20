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
# What the MMS character frontends actually contain, plus the sentence period
# that segments utterances.
_UNSPEAKABLE = re.compile(r"[^A-Za-z'\s.]+")
_WHITESPACE = re.compile(r"\s+")

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
    romanized = romanize(expanded, LCODE[language])
    # uroman has already turned ። into '.', so keeping '.' preserves the Ge'ez
    # sentence boundaries that sherpa-onnx segments on.
    stripped = _UNSPEAKABLE.sub(" ", romanized)
    return _WHITESPACE.sub(" ", stripped).strip()


# Kokoro's context is 512, and its style vector has exactly 510 rows indexed by
# token count (each voices/*.bin is 510 x 1 x 256 float32). 510 is the usable
# ceiling, and a page phonemizes to roughly 1586 tokens, so chunking is not
# optional for English.
KOKORO_TOKEN_LIMIT = 510

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def tokenize(phonemes: str, vocab: dict[str, int]) -> list[int]:
    """Map phoneme characters to Kokoro's ids, dropping anything unmapped."""
    return [vocab[ch] for ch in phonemes if ch in vocab]


def chunk_english(
    text: str,
    vocab: dict[str, int],
    phonemize: Callable[[str], str],
) -> list[list[int]]:
    """Split a page into sentence-aligned chunks that fit the context.

    espeak-ng expands numbers itself during phonemization, so there is no
    number-to-words step on this path.
    """
    if not text.strip():
        return []

    chunks: list[list[int]] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(text.strip()):
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip()
        if len(tokenize(phonemize(candidate), vocab)) > KOKORO_TOKEN_LIMIT and current:
            chunks.append(tokenize(phonemize(current), vocab))
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(tokenize(phonemize(current), vocab))

    # A single sentence can still exceed the limit on its own; the style vector
    # simply has no row beyond 510, so it is truncated rather than rejected.
    return [c[:KOKORO_TOKEN_LIMIT] for c in chunks if c]
