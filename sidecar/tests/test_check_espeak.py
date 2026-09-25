"""The frozen binary's espeak-ng self-check.

English needs a 326 MB model to synthesize, which a build's smoke test does
not download. espeak-ng — the part most likely to break when frozen on a new
OS — needs no model at all, so it is checked on its own through this flag.
"""

import json

import server


def test_check_espeak_phonemizes_a_word_and_exits_cleanly(capsys):
    assert server.main(["--check-espeak"]) == 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert isinstance(printed, str) and printed.strip()
