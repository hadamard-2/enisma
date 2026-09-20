from prepare import KOKORO_TOKEN_LIMIT, chunk_english, tokenize

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
