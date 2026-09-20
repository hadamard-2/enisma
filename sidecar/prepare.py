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
        if not value.isdigit():
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
