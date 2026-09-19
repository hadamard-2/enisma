"""Startup and pipeline assertions for failures that are otherwise silent.

Both guards here exist because the thing they catch does not raise on its own.
"""

from __future__ import annotations

import re

# espeak-ng keeps `path_home` in a fixed-size buffer and, when the data path it
# is handed does not fit, silently falls back to the path compiled into the
# library — which exists only on the machine that built the wheel. It then
# terminates the process rather than returning an error, so there is no Python
# exception, no traceback, and buffered stdout is lost: the sidecar simply dies.
# Measured boundary: 159 characters work, 160 do not.
ESPEAK_PATH_LIMIT = 159

_DIGITS = re.compile(r"\d")


def assert_espeak_data_path(path: str) -> None:
    """Fail loudly before espeak-ng can fail silently."""
    if len(path) > ESPEAK_PATH_LIMIT:
        raise RuntimeError(
            f"espeak-ng data path is {len(path)} characters; the limit is "
            f"{ESPEAK_PATH_LIMIT}. Stage the data at a shorter path — past the "
            f"limit espeak-ng ignores it and terminates the process. Path: {path}"
        )


def assert_no_digits(text: str, context: str) -> None:
    """Catch numbers the converter declined to turn into words.

    num2words2 has no branch above 10**9 for Tigrigna or Oromo and returns the
    raw digits instead. Those digits are not in the MMS symbol tables, so they
    would be dropped later and the number would go unspoken with no trace. We
    do not convert them — that is a deliberate v0 omission — but the omission
    should be visible rather than silent.
    """
    if _DIGITS.search(text):
        raise RuntimeError(
            f"number expansion left digits in {context} text, which the model "
            f"cannot speak: {text!r}"
        )
