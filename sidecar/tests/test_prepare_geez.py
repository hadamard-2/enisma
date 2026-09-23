import re

import pytest

from prepare import (
    MMS_UTTERANCE_LIMIT,
    cap_utterances,
    expand_numbers,
    prepare_geez,
)

# Stand-in for uroman: enough to exercise the numeral path without its tables.
GEEZ_DIGITS = {"፩": "1", "፫": "3", "፵": "40", "፯": "7", "፲": "10", "፻": "100"}


def fake_romanize(text: str, lcode: str) -> str:
    if all(ch in GEEZ_DIGITS for ch in text):
        # uroman turns a Ge'ez numeral run into its Arabic value.
        if text == "፵፯":
            return "47"
        if text == "፲፱፻፹፭":
            return "1985"
        return "".join(GEEZ_DIGITS[ch] for ch in text)
    # The Ge'ez-to-ASCII folds real uroman performs, measured against it:
    # ። -> '.', ፧ -> '?', ፥ and ፦ -> ':', ፣ -> ',', ፤ -> ';'.
    for geez, ascii_ in (("።", "."), ("፧", "?"), ("፥", ":"), ("፦", ":"),
                         ("፣", ","), ("፤", ";")):
        text = text.replace(geez, ascii_)
    return text


def test_arabic_digits_become_words():
    out = expand_numbers("ምዕራፍ 3", "am", fake_romanize)
    assert "3" not in out
    assert "ሦስት" in out


def test_geez_numerals_become_the_same_words_as_arabic_digits():
    geez = expand_numbers("ምዕራፍ ፫", "am", fake_romanize)
    arabic = expand_numbers("ምዕራፍ 3", "am", fake_romanize)
    assert geez == arabic


def test_a_prefix_bound_to_a_number_survives_as_a_separate_word():
    # ብ1985 writes the preposition onto the numeral. Spaced substitution was
    # confirmed acceptable by a native speaker.
    out = expand_numbers("ብ1985 ዓመተ ምሕረት", "ti", fake_romanize)
    assert "ብ" in out
    assert "1985" not in out


def test_tigrigna_numbers_come_back_in_geez_script_not_latin():
    out = expand_numbers("ገጽ 47", "ti", fake_romanize)
    assert "arba" not in out.lower()
    assert any("ሀ" <= ch <= "፿" for ch in out)


def test_a_number_the_converter_declines_is_reported_not_swallowed():
    # num2words2 has no branch above 10**9 for ti/om and returns raw digits.
    with pytest.raises(RuntimeError):
        expand_numbers("ብ1000000000 ዓመተ ምሕረት", "ti", fake_romanize)


def test_prepare_keeps_the_sentence_period():
    # The period is what segments utterances in sherpa-onnx. Losing it collapses
    # a whole page into one atomic call with no progress and no cancellation.
    out = prepare_geez("ሓደ ነገር። ካልእ ነገር።", "ti", fake_romanize)
    assert out.count(".") == 2


def test_prepare_strips_what_the_symbol_table_cannot_speak():
    out = prepare_geez("ሓደ (ነገር) 50% ነው።", "ti", fake_romanize)
    assert "(" not in out and ")" not in out and "%" not in out


def test_prepare_collapses_the_gaps_left_by_stripping():
    out = prepare_geez("ሓደ  ((  ነገር።", "ti", fake_romanize)
    assert "  " not in out


def declining_romanize(text: str, lcode: str) -> str:
    """uroman leaving a numeral run untouched, whatever its magnitude."""
    return text


def test_a_declined_single_digit_numeral_is_reported_not_crashed():
    # ፩-፱ are str.isdigit() == True but not category Nd, so a bail-out testing
    # isdigit() alone would fall into int() and raise ValueError instead.
    with pytest.raises(RuntimeError):
        expand_numbers("ምዕራፍ ፫፭", "am", declining_romanize)


def test_a_declined_large_numeral_is_reported_not_crashed():
    with pytest.raises(RuntimeError):
        expand_numbers("ምዕራፍ ፼", "am", declining_romanize)


def test_a_parsed_numeral_still_expands_when_romanize_returns_digits():
    out = expand_numbers("ምዕራፍ ፫", "am", fake_romanize)
    assert "፫" not in out
    assert "ሦስት" in out


def test_prepare_keeps_the_marks_that_segment_utterances():
    # '.', '!' and '?' are the marks sherpa-onnx splits on that we can keep
    # unambiguously. Without them a page is one atomic call: no progress, no
    # cancellation, and the synthesis cost stops being linear in page length.
    out = prepare_geez("ሓደ ነገር። ካልእ ነገር፧ ሳልሳይ ነገር!", "ti", fake_romanize)
    assert out.count(".") == 1
    assert out.count("?") == 1
    assert out.count("!") == 1


def test_prepare_drops_the_colon_even_though_it_would_segment():
    # uroman folds ፥ and ፦ onto ':', which sherpa-onnx does segment on -- but
    # ':' also separates times and ratios, where a split would be wrong.
    out = prepare_geez("ሰዓት 3፥ ነገር", "am", fake_romanize)
    assert ":" not in out


def test_prepare_still_drops_punctuation_that_segments_nothing():
    # A comma is not merely unspoken: it yields a token sequence identical to
    # the one with no comma, so keeping it would buy nothing at all.
    out = prepare_geez("ሓደ ነገር፣ ካልእ ነገር፤ ሳልሳይ", "ti", fake_romanize)
    assert "," not in out and ";" not in out


def test_prepare_folds_v_onto_b_because_no_model_has_a_v():
    # 'v' is absent from all three tokens.txt files but is a letter, so it
    # survives the symbol strip and is then skipped mid-word by the frontend:
    # "vidiyo" would be voiced as "idiyo".
    out = prepare_geez("vidiyo Video", "am", fake_romanize)
    assert "v" not in out and "V" not in out
    assert "bidiyo" in out and "Bideo" in out


def test_prepare_turns_line_breaks_into_utterance_boundaries():
    # A newline is only whitespace to sherpa-onnx, so a heading ran into the
    # text below it — and one unbroken run is also where synthesis cost stops
    # being linear. Each line becomes its own utterance.
    out = prepare_geez("ሓደ ነገር\nካልእ ነገር\n\nሳልሳይ ነገር።", "ti", fake_romanize)
    assert out.count(".") == 3


def _runs(text: str) -> list[str]:
    return [r.strip() for r in re.split(r"[.!?]", text) if r.strip()]


def _words(text: str) -> list[str]:
    return re.sub(r"[.!?]", " ", text).split()


def test_an_unmarked_run_is_capped_into_balanced_pieces_at_word_boundaries():
    # A page whose ። marks were lost is one unbroken utterance: one progress
    # callback, cancellation only at the end, and past ~2,000 romanized
    # characters a cost that stops being linear. The cap bounds every utterance
    # whether or not the page has its punctuation.
    run = " ".join(["salaame"] * 150)  # 1,199 characters, no sentence mark
    out = cap_utterances(run)
    pieces = _runs(out)
    assert len(pieces) == 3
    assert all(len(p) <= MMS_UTTERANCE_LIMIT for p in pieces)
    # Balanced, not greedy: no short tail stranded after two full pieces.
    assert min(len(p) for p in pieces) > MMS_UTTERANCE_LIMIT // 2
    assert _words(out) == _words(run)


def test_runs_within_the_cap_come_through_untouched():
    text = "hade neger. " * 40 + ("kalie " * 83).strip() + "? salaame!"
    assert len(("kalie " * 83).strip()) <= MMS_UTTERANCE_LIMIT
    assert cap_utterances(text) == text


def test_a_run_exactly_at_the_cap_is_not_split():
    run = "a" * (MMS_UTTERANCE_LIMIT - 2) + " b"
    assert cap_utterances(run) == run


def test_only_the_overlong_run_is_split_and_its_neighbours_are_kept():
    long_run = " ".join(["katamaayetu"] * 80)
    text = f"hade neger. {long_run}? kalie neger!"
    out = cap_utterances(text)
    assert out.startswith("hade neger. ")
    assert out.endswith("? kalie neger!")
    assert all(len(p) <= MMS_UTTERANCE_LIMIT for p in _runs(out))
    assert _words(out) == _words(text)


def test_a_run_with_no_spaces_is_hard_cut_rather_than_left_unbounded():
    # OCR junk can produce a run with nowhere to break. A bad seam is better
    # than unbounded work, and no letter may be lost.
    run = "a" * (MMS_UTTERANCE_LIMIT * 2 + 7)
    pieces = _runs(cap_utterances(run))
    assert all(len(p) <= MMS_UTTERANCE_LIMIT for p in pieces)
    assert "".join(pieces) == run


def test_prepare_caps_a_page_whose_sentence_marks_were_lost():
    # Already Latin, because fake_romanize transliterates marks, not letters.
    page = " ".join(["salaame negere"] * 200)  # no ። anywhere, one line
    out = prepare_geez(page, "am", fake_romanize)
    pieces = _runs(out)
    assert len(pieces) > 1
    assert all(len(p) <= MMS_UTTERANCE_LIMIT for p in pieces)
