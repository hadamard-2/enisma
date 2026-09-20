"""The model manifest and the integrity checks around it.

Every test here is offline by construction: the manifest is a local JSON file,
and the download path is exercised against a file:// URL over a temp directory.
Nothing in this file may reach the network — a test that needs a remote to be
up is a test that fails on the plane, which is where this product is meant to
work.
"""

import hashlib

import pytest

import models


def test_every_language_in_the_manifest_has_files():
    for lang in ("en", "am", "ti", "om"):
        entries = models.files_for(lang)
        assert entries, f"{lang} has no files"
        for e in entries:
            assert e["url"].startswith("https://")
            assert e["path"].startswith(f"{lang}/")
            assert e["size"] > 0


def test_the_manifest_carries_a_real_hash_for_every_file():
    for lang in ("en", "am", "ti", "om"):
        for e in models.files_for(lang):
            assert len(e["sha256"]) == 64, f"{e['path']} has no real hash"
            int(e["sha256"], 16)  # hex, or this raises


def test_the_manifest_ships_only_fp32_kokoro_weights():
    # The quantized variants are slower on CPU and q8f16 segfaults onnxruntime.
    paths = [e["path"] for e in models.files_for("en")]
    assert "en/model.onnx" in paths
    assert not any("quantized" in p or "q8f16" in p or "fp16" in p for p in paths)


def test_english_carries_the_kokoro_voices():
    paths = [e["path"] for e in models.files_for("en")]
    assert "en/voices/af_heart.bin" in paths


def test_verify_accepts_a_matching_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert models.verify(str(f), hashlib.sha256(b"hello").hexdigest())


def test_verify_rejects_a_corrupt_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert not models.verify(str(f), "0" * 64)


def test_verify_rejects_a_missing_file(tmp_path):
    assert not models.verify(str(tmp_path / "nope"), "0" * 64)


def test_status_reports_a_language_absent_when_files_are_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    assert models.status()["am"] is False


def _local_manifest(tmp_path, payload: bytes, sha256: str) -> dict:
    """A one-file manifest served from disk, so the fetch never leaves the box."""
    src = tmp_path / "remote" / "thing.bin"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(payload)
    return {
        "languages": {
            "xx": [
                {
                    "url": src.as_uri(),
                    "path": "xx/thing.bin",
                    "size": len(payload),
                    "sha256": sha256,
                }
            ]
        },
        "voices": {"names": []},
    }


def test_fetch_installs_a_file_whose_hash_matches(tmp_path, monkeypatch):
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(
        models, "manifest", lambda: _local_manifest(tmp_path, payload, good)
    )

    seen = []
    models.fetch("xx", lambda path, fraction: seen.append((path, fraction)))

    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == payload
    assert seen and seen[-1][1] == pytest.approx(1.0)


def test_fetch_refuses_to_install_a_file_whose_hash_does_not_match(
    tmp_path, monkeypatch
):
    payload = b"tampered bytes"
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(
        models, "manifest", lambda: _local_manifest(tmp_path, payload, "0" * 64)
    )

    with pytest.raises(RuntimeError, match="checksum"):
        models.fetch("xx", lambda path, fraction: None)

    target = tmp_path / "models" / "xx" / "thing.bin"
    # Neither the file nor its scratch half-sibling survives: a model directory
    # is never left in a state the engine would try to load.
    assert not target.exists()
    assert not target.with_suffix(target.suffix + ".part").exists()
