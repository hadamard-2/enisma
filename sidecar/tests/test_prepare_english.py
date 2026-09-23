from prepare import KOKORO_PACK_TARGET, KOKORO_STYLE_ROWS, KOKORO_TOKEN_LIMIT, chunk_english, tokenize

VOCAB = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz .,")}


def fake_phonemize(text: str) -> str:
    # One "phoneme" per character keeps the token arithmetic legible.
    return text.lower()


def test_tokenize_drops_symbols_the_vocab_does_not_have():
    assert tokenize("ab!c", VOCAB) == [VOCAB["a"], VOCAB["b"], VOCAB["c"]]


def test_short_text_is_a_single_chunk():
    chunks = chunk_english("hello there.", VOCAB, fake_phonemize)
    assert len(chunks) == 1
    assert len(chunks[0]) <= KOKORO_TOKEN_LIMIT


def test_a_long_page_is_split_on_sentence_boundaries():
    sentence = "the cell is the basic unit of life. "
    chunks = chunk_english(sentence * 40, VOCAB, fake_phonemize)
    assert len(chunks) > 1


def test_no_chunk_exceeds_the_context_limit():
    sentence = "the cell is the basic unit of life. "
    for chunk in chunk_english(sentence * 60, VOCAB, fake_phonemize):
        assert len(chunk) <= KOKORO_TOKEN_LIMIT


def test_a_single_sentence_longer_than_the_limit_is_still_bounded():
    # No sentence boundary to split on; it must be split finer, not passed
    # through oversized -- the style vector is indexed by token count and has
    # only 510 rows.
    monster = "word " * 400
    for chunk in chunk_english(monster, VOCAB, fake_phonemize):
        assert len(chunk) <= KOKORO_TOKEN_LIMIT


def test_empty_text_produces_no_chunks():
    assert chunk_english("   ", VOCAB, fake_phonemize) == []


def _decode(chunks) -> str:
    back = {i: ch for ch, i in VOCAB.items()}
    return "".join(back[t] for chunk in chunks for t in chunk)


def _spoken(text: str) -> str:
    # Everything the fake vocab can carry, ignoring whitespace: chunk seams
    # replace spaces, so spaces are the one thing a split may change.
    return "".join(ch for ch in text.lower() if ch in VOCAB and not ch.isspace())


def test_an_over_long_sentence_is_split_with_nothing_lost():
    monster = "the cell is a unit, " * 60 + "and that is all."
    chunks = chunk_english(monster, VOCAB, fake_phonemize)
    assert len(chunks) > 1
    assert all(len(c) <= KOKORO_TOKEN_LIMIT for c in chunks)
    assert _spoken(_decode(chunks)) == _spoken(monster)


def test_a_long_run_without_sentence_punctuation_loses_nothing():
    # The OCR-table case: a column of captions with no terminal punctuation.
    table = " ".join(f"row{n % 10}" for n in range(300))
    chunks = chunk_english(table, VOCAB, fake_phonemize)
    assert len(chunks) > 1
    assert all(len(c) <= KOKORO_TOKEN_LIMIT for c in chunks)
    assert _spoken(_decode(chunks)) == _spoken(table)


def test_one_unbroken_token_run_still_respects_the_ceiling():
    unbroken = "a" * (KOKORO_TOKEN_LIMIT * 3 + 7)
    chunks = chunk_english(unbroken, VOCAB, fake_phonemize)
    assert len(chunks) == 4
    assert all(len(c) <= KOKORO_TOKEN_LIMIT for c in chunks)
    assert _spoken(_decode(chunks)) == _spoken(unbroken)


def test_no_chunk_can_index_past_the_last_style_row():
    # The regression: a run with no sentence punctuation, no commas and no
    # spaces falls through to the raw-token path, which used to emit chunks of
    # exactly 510 tokens. styles has rows 0..509, and the engine looks up
    # styles[len(tokens)], so a 510-token chunk is an IndexError. 509 is the
    # largest token count with a real style row. Asserted against the literal,
    # not the constant, so moving the constant cannot move the goalposts.
    assert KOKORO_STYLE_ROWS == 510
    unbroken = "z" * (KOKORO_STYLE_ROWS * 2)
    chunks = chunk_english(unbroken, VOCAB, fake_phonemize)
    assert max(len(c) for c in chunks) <= 509
    assert _spoken(_decode(chunks)) == _spoken(unbroken)


# ---- Line breaks and dotted numbers -----------------------------------------

from prepare import end_lines, prepare_english  # noqa: E402


def test_a_line_break_becomes_a_sentence_end():
    # Neither engine pauses at a bare newline, so a heading ran straight into
    # the text under it.
    assert end_lines("Sections\nDefinition of Biology") == "Sections. Definition of Biology."


def test_a_line_that_already_ends_in_punctuation_is_left_alone():
    assert end_lines("Why study it?\nIt is useful:\nfirst, second;") == (
        "Why study it? It is useful: first, second;"
    )


def test_blank_lines_and_trailing_spaces_add_nothing():
    assert end_lines("Unit 1 \n\n\n  Sections  \n") == "Unit 1. Sections."


def test_geez_marks_count_as_line_ends():
    assert end_lines("ሰላም።\nጥያቄ፧\nዝርዝር፣") == "ሰላም። ጥያቄ፧ ዝርዝር፣"


def test_dotted_numbers_are_read_with_point():
    # In punctuation-preserving mode the phonemizer takes the dot in "1.1" for
    # a sentence end, which both misreads it and used to cost the rest of the
    # sentence.
    assert prepare_english("1.4.1 Laboratory tools") == "1 point 4 point 1 Laboratory tools."
    assert prepare_english("It weighs 3.5 kg.") == "It weighs 3 point 5 kg."


def test_a_dot_that_is_not_between_digits_is_kept():
    assert prepare_english("Section 1.5.\nThe U.S. system.") == "Section 1 point 5. The U.S. system."



# ---- Chunk size -------------------------------------------------------------


def test_short_sentences_are_grouped_only_up_to_the_pack_target():
    # Stop can only land between chunks, so chunks are kept small: grouped
    # sentences never push a chunk past the target, far below the ceiling.
    sentence = "the cell is the basic unit of life. "  # 36 tokens with the fake
    chunks = chunk_english(sentence * 40, VOCAB, fake_phonemize)
    assert all(len(c) <= KOKORO_PACK_TARGET for c in chunks)
    # ...but they are still grouped, not one call per sentence.
    assert len(chunks) < 40


def test_a_sentence_longer_than_the_target_stays_whole():
    # Smaller chunks must never cost a sentence its prosody: one that is over
    # the target but within the ceiling gets a chunk of its own, uncut.
    words = "word " * 60  # 300 tokens, no comma to split at
    long_sentence = words.strip() + "."
    chunks = chunk_english(f"short one. {long_sentence} short two.", VOCAB, fake_phonemize)
    assert [len(c) for c in chunks] == [len("short one."), len(long_sentence), len("short two.")]
