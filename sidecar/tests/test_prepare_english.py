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
    # No sentence boundary to split on; it must be truncated, not passed
    # through oversized -- the style vector is indexed by token count and has
    # only 510 rows.
    monster = "word " * 400
    for chunk in chunk_english(monster, VOCAB, fake_phonemize):
        assert len(chunk) <= KOKORO_TOKEN_LIMIT


def test_empty_text_produces_no_chunks():
    assert chunk_english("   ", VOCAB, fake_phonemize) == []
