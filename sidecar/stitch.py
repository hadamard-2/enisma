"""Join per-page WAV takes into one MP3.

Knows nothing about pages, projects or freshness: an ordered list of WAVs in,
one MP3 out. The caller decides the gap, the bitrate and the title, so this
module holds no opinion about any of them.

Every input is checked before a byte is encoded, so a mismatch fails in
milliseconds rather than after encoding hours of audio, and nothing is written
for an input set that would have failed anyway.
"""

from __future__ import annotations

import os
import wave
from typing import Callable

import lameenc

# How much PCM to read and encode at a time. Bounds memory to one chunk however
# long the book is, and is how often a cancel is noticed.
CHUNK_SECONDS = 1


class StitchError(ValueError):
    """An input the stitcher refuses. The message names the file and is shown as-is."""


def id3_title_tag(title: str) -> bytes:
    """An ID3v2.3 tag holding one TIT2 frame in UTF-16 with a BOM.

    v2.3 rather than v2.4 for player support, and UTF-16 because v2.3 has no
    UTF-8 and titles are often Ge'ez. Frame sizes in v2.3 are plain big-endian;
    only the tag header's size is syncsafe.
    """
    if not title:
        return b""
    body = b"\x01" + b"\xff\xfe" + title.encode("utf-16-le")
    frame = b"TIT2" + len(body).to_bytes(4, "big") + b"\x00\x00" + body
    size = len(frame)
    syncsafe = bytes(
        [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
    )
    return b"ID3" + b"\x03\x00" + b"\x00" + syncsafe + frame


def _check_inputs(wavs: list[str]) -> tuple[int, int]:
    """Validate every input. Returns (sample_rate, total_frames)."""
    if not wavs:
        raise StitchError("nothing to stitch: no audio files were given")
    first_rate: int | None = None
    first_name = ""
    total = 0
    for path in wavs:
        name = os.path.basename(path)
        try:
            with wave.open(path, "rb") as w:
                channels = w.getnchannels()
                width = w.getsampwidth()
                rate = w.getframerate()
                frames = w.getnframes()
        except FileNotFoundError:
            raise StitchError(f"{name}: file not found") from None
        except (wave.Error, EOFError) as exc:
            raise StitchError(f"{name}: not a PCM WAV file ({exc})") from None
        if channels != 1:
            raise StitchError(f"{name}: {channels} channels, expected mono")
        if width != 2:
            raise StitchError(f"{name}: {width * 8}-bit samples, expected 16-bit")
        if first_rate is None:
            first_rate, first_name = rate, name
        elif rate != first_rate:
            raise StitchError(f"{name}: {rate} Hz, but {first_name} is {first_rate} Hz")
        total += frames
    assert first_rate is not None
    return first_rate, total


def _ms(frames: int, rate: int) -> int:
    return frames * 1000 // rate


def stitch(
    wavs: list[str],
    out_path: str,
    gap_ms: int,
    bitrate_kbps: int,
    title: str,
    on_progress: Callable[[float], bool],
) -> tuple[int, int]:
    """Encode `wavs`, in order, into one CBR mono MP3 at `out_path`.

    Returns (sample_rate, duration_ms). `on_progress` receives the fraction of
    samples encoded and returns False to stop; a stop returns early and leaves
    whatever was written, because the caller owns `out_path` and its cleanup.
    """
    sample_rate, page_frames = _check_inputs(wavs)
    gap_frames = sample_rate * gap_ms // 1000
    total = page_frames + gap_frames * (len(wavs) - 1)

    encoder = lameenc.Encoder()
    encoder.silence()
    encoder.set_bit_rate(bitrate_kbps)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(1)
    encoder.set_quality(2)

    chunk = sample_rate * CHUNK_SECONDS
    done = 0
    with open(out_path, "wb") as out:
        out.write(id3_title_tag(title))
        for index, path in enumerate(wavs):
            if index > 0 and gap_frames:
                out.write(encoder.encode(b"\x00\x00" * gap_frames))
                done += gap_frames
            with wave.open(path, "rb") as w:
                while True:
                    pcm = w.readframes(chunk)
                    if not pcm:
                        break
                    out.write(encoder.encode(pcm))
                    done += len(pcm) // 2
                    if not on_progress(done / total if total else 1.0):
                        return sample_rate, _ms(done, sample_rate)
        out.write(encoder.flush())
    on_progress(1.0)
    return sample_rate, _ms(total, sample_rate)
