import math
import struct
import wave

import pytest

from stitch import StitchError, id3_title_tag, stitch

MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
MPEG2_RATES = [22050, 24000, 16000]


def write_wav(path, seconds, rate=16000, channels=1, width=2):
    """A 440 Hz tone. Stereo repeats each sample for both channels."""
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        if width == 2:
            samples = [
                struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate)))
                for i in range(frames)
            ]
        else:
            samples = [bytes([128])] * frames
        w.writeframes(b"".join(s * channels for s in samples))
    return str(path)


def audio_start(data: bytes) -> int:
    if data[:3] != b"ID3":
        return 0
    size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
    return 10 + size


def first_frame(data: bytes):
    h = data[audio_start(data):][:4]
    assert h[0] == 0xFF and (h[1] & 0xE0) == 0xE0, "no MPEG frame sync after the tag"
    return {
        "version": (h[1] >> 3) & 0b11,  # 0b10 = MPEG-2
        "layer": (h[1] >> 1) & 0b11,  # 0b01 = Layer III
        "kbps": MPEG2_L3_KBPS[h[2] >> 4],
        "rate": MPEG2_RATES[(h[2] >> 2) & 0b11],
        "mode": h[3] >> 6,  # 0b11 = mono
    }


def keep_going(_fraction):
    return True


@pytest.mark.parametrize("rate", [16000, 24000])
def test_output_is_mpeg2_layer3_at_64kbps_mono(tmp_path, rate):
    wavs = [write_wav(tmp_path / "a.wav", 1.0, rate)]
    out = tmp_path / "book.mp3"
    sample_rate, _ = stitch(wavs, str(out), 600, 64, "", keep_going)
    frame = first_frame(out.read_bytes())
    assert sample_rate == rate
    assert frame == {"version": 0b10, "layer": 0b01, "kbps": 64, "rate": rate, "mode": 0b11}


def test_duration_is_the_pages_plus_the_gaps_between_them(tmp_path):
    wavs = [
        write_wav(tmp_path / "a.wav", 1.0),
        write_wav(tmp_path / "b.wav", 2.0),
        write_wav(tmp_path / "c.wav", 0.5),
    ]
    out = tmp_path / "book.mp3"
    _, duration_ms = stitch(wavs, str(out), 600, 64, "", keep_going)
    assert duration_ms == 4700  # 3.5 s of pages + two 600 ms gaps
    data = out.read_bytes()
    # CBR: seconds = audio bytes * 8 / bitrate. Allow for LAME's padding frames.
    estimated = (len(data) - audio_start(data)) * 8 / 64000
    assert abs(estimated - 4.7) < 0.15


def test_the_title_tag_carries_a_geez_title(tmp_path):
    title = "ባዮሎጂ 9ኛ ክፍል"
    out = tmp_path / "book.mp3"
    stitch([write_wav(tmp_path / "a.wav", 0.5)], str(out), 600, 64, title, keep_going)
    data = out.read_bytes()
    assert data[:3] == b"ID3" and data[3] == 3 and data[4] == 0
    frame = data[10:]
    assert frame[:4] == b"TIT2"
    size = int.from_bytes(frame[4:8], "big")
    body = frame[10 : 10 + size]
    assert body[0] == 0x01
    assert body[1:3] == b"\xff\xfe"
    assert body[3:].decode("utf-16-le") == title


def test_an_empty_title_writes_no_tag(tmp_path):
    out = tmp_path / "book.mp3"
    stitch([write_wav(tmp_path / "a.wav", 0.5)], str(out), 600, 64, "", keep_going)
    assert out.read_bytes()[:3] != b"ID3"
    assert id3_title_tag("") == b""


def test_mixed_sample_rates_are_refused_naming_both_files(tmp_path):
    wavs = [write_wav(tmp_path / "a.wav", 0.5, 16000), write_wav(tmp_path / "b.wav", 0.5, 24000)]
    out = tmp_path / "book.mp3"
    with pytest.raises(StitchError, match=r"b\.wav: 24000 Hz, but a\.wav is 16000 Hz"):
        stitch(wavs, str(out), 600, 64, "", keep_going)
    assert not out.exists(), "nothing may be written before every input checks out"


def test_stereo_is_refused(tmp_path):
    with pytest.raises(StitchError, match=r"s\.wav: 2 channels, expected mono"):
        stitch([write_wav(tmp_path / "s.wav", 0.5, channels=2)], str(tmp_path / "o.mp3"), 0, 64, "", keep_going)


def test_8_bit_audio_is_refused(tmp_path):
    with pytest.raises(StitchError, match=r"e\.wav: 8-bit samples, expected 16-bit"):
        stitch([write_wav(tmp_path / "e.wav", 0.5, width=1)], str(tmp_path / "o.mp3"), 0, 64, "", keep_going)


def test_a_missing_file_is_refused(tmp_path):
    with pytest.raises(StitchError, match=r"gone\.wav: file not found"):
        stitch([str(tmp_path / "gone.wav")], str(tmp_path / "o.mp3"), 0, 64, "", keep_going)


def test_no_files_is_refused(tmp_path):
    with pytest.raises(StitchError, match="nothing to stitch"):
        stitch([], str(tmp_path / "o.mp3"), 0, 64, "", keep_going)


def test_a_cancel_stops_early_and_leaves_the_file_for_the_caller(tmp_path):
    wavs = [write_wav(tmp_path / "a.wav", 3.0)]
    out = tmp_path / "book.mp3"
    _, duration_ms = stitch(wavs, str(out), 0, 64, "", lambda _f: False)
    assert duration_ms < 3000
    assert out.exists(), "the stitcher never deletes its output; Rust owns cleanup"


def test_progress_only_rises_and_ends_at_one(tmp_path):
    wavs = [write_wav(tmp_path / "a.wav", 2.5), write_wav(tmp_path / "b.wav", 1.5)]
    seen = []

    def record(fraction):
        seen.append(fraction)
        return True

    stitch(wavs, str(tmp_path / "book.mp3"), 600, 64, "", record)
    assert seen == sorted(seen)
    assert seen[-1] == 1.0
    assert len(seen) > 2
