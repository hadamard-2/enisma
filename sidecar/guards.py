"""Startup and pipeline assertions for failures that are otherwise silent.

Both guards here exist because the thing they catch does not raise on its own.
"""

from __future__ import annotations

import pathlib

# espeak-ng keeps `path_home` in a fixed-size buffer and, when the data path it
# is handed does not fit, silently falls back to the path compiled into the
# library — which exists only on the machine that built the wheel. It then
# terminates the process rather than returning an error, so there is no Python
# exception, no traceback, and buffered stdout is lost: the sidecar simply dies.
# Measured boundary: 159 characters work, 160 do not.
ESPEAK_PATH_LIMIT = 159

def assert_espeak_data_path(path: str) -> None:
    """Fail loudly before espeak-ng can fail silently.

    Measures the resolved path, because that is the string espeak-ng is handed:
    phonemizer resolves the path before passing it on, and a symlinked
    component can make the resolved form longer than the one given here.
    """
    resolved = str(pathlib.Path(path).resolve())
    if len(resolved) > ESPEAK_PATH_LIMIT:
        raise RuntimeError(
            f"espeak-ng data path is {len(resolved)} characters; the limit is "
            f"{ESPEAK_PATH_LIMIT}. Stage the data at a shorter path — past the "
            f"limit espeak-ng ignores it and terminates the process. "
            f"Path: {resolved}"
        )


def assert_no_digits(text: str, context: str) -> None:
    """Catch numerals the converter declined to turn into words.

    The MMS symbol tables are Latin-letter only. Any numeral character of any
    script — ASCII digits, or the Ethiopic numerals ('፩'-'፼') used by
    Amharic, Tigrigna, and Oromo source text — that survives number expansion
    would be dropped or mis-synthesized downstream with no trace. `\\d` only
    matches Unicode category Nd (decimal digit), which excludes the Ethiopic
    numerals (category No), so this checks `str.isnumeric()` per character
    instead to catch numerals of any script.
    """
    if any(ch.isnumeric() for ch in text):
        raise RuntimeError(
            f"number expansion left digits in {context} text, which the model "
            f"cannot speak: {text!r}"
        )
