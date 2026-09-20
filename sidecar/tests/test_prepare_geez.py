import pytest

from prepare import expand_numbers, prepare_geez

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
    return text.replace("።", ".")


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
