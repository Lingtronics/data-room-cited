"""Opt-in, immutable synthetic corpus boundary shared by the existing RAG core.

The manifest is trusted repository code, never a client-supplied approval file.
No network calls, model downloads or alternate retrieval implementation.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "fixtures" / "voice"
WORKSPACE = "voice-synthetic-v1"
READ_SCOPES = {"documents:read", "citations:verify"}


class VoiceFixtureError(ValueError):
    pass


def enabled() -> bool:
    value = os.getenv("VOICE_FEATURE_ENABLED", "false")
    if value not in {"true", "false"}:
        raise VoiceFixtureError("VOICE_FEATURE_ENABLED must be true or false.")
    return value == "true"


def manifest() -> dict:
    return json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))


def fingerprint() -> str:
    return hashlib.sha256((BUNDLE / "manifest.json").read_bytes()).hexdigest()


def _plain_path(path: Path) -> Path:
    absolute = path.absolute()
    for part in (absolute, *absolute.parents):
        # Reparse points include Windows junctions (also works on Python 3.11).
        if part.is_symlink() or getattr(part.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise VoiceFixtureError("Voice fixture paths must not contain links or junctions.")
    return absolute.resolve(strict=True)


def read_bundle(data_dir: Path, index_dir: Path) -> dict[str, bytes]:
    """Validate exact file sets and bytes, then return the checked snapshot."""
    spec = manifest()
    output: dict[str, bytes] = {}
    try:
        data, index = _plain_path(data_dir), _plain_path(index_dir)
        if data == index or data in index.parents or index in data.parents:
            raise VoiceFixtureError("Voice data and index directories must be separate.")
        if data == (ROOT / "data").resolve() or index == (ROOT / "index").resolve():
            raise VoiceFixtureError("Voice mode cannot use the ordinary data/index directories.")
        for kind, directory in (("data", data), ("index", index)):
            expected = spec["files"][kind]
            if {p.name for p in directory.iterdir()} != set(expected):
                raise VoiceFixtureError("Voice fixture contains missing or unapproved files.")
            for name, entry in expected.items():
                path = directory / name
                _plain_path(path)
                if not path.is_file() or path.stat().st_size != entry["bytes"]:
                    raise VoiceFixtureError("Voice fixture file size/type differs from approved data.")
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                    raise VoiceFixtureError("Voice fixture hash differs from approved synthetic data.")
                output[f"{kind}/{name}"] = raw
    except OSError as exc:
        raise VoiceFixtureError("Voice fixture missing or unreadable; run prepare_voice_fixture.py.") from exc
    return output


def configured_snapshot() -> dict[str, bytes]:
    if os.getenv("VOICE_READ_ONLY_DEMO") != "true":
        raise VoiceFixtureError("Voice mode requires VOICE_READ_ONLY_DEMO=true.")
    if os.getenv("DOCUMENT_SOURCE_TYPE", "local") != "local":
        raise VoiceFixtureError("Voice mode cannot use an external document connector.")
    paths = [os.getenv(name) for name in (
        "VOICE_FIXTURE_DATA_DIR", "VOICE_FIXTURE_INDEX_DIR", "DATA_DIR", "INDEX_DIR"
    )]
    if not all(paths):
        raise VoiceFixtureError("Set explicit VOICE_FIXTURE_DATA_DIR/INDEX_DIR and matching DATA_DIR/INDEX_DIR.")
    data, index, active_data, active_index = [Path(p) for p in paths]
    if any(not p.is_absolute() for p in (data, index, active_data, active_index)):
        raise VoiceFixtureError("Voice fixture paths must be absolute.")
    if _plain_path(data) != _plain_path(active_data) or _plain_path(index) != _plain_path(active_index):
        raise VoiceFixtureError("Active DATA_DIR/INDEX_DIR must match the voice fixture directories.")
    return read_bundle(data, index)


def prepare(destination: Path) -> None:
    """Create a new dedicated directory; never overwrite an existing corpus."""
    read_bundle(BUNDLE / "data", BUNDLE / "index")
    destination.mkdir(parents=True, exist_ok=False)
    for name in ("data", "index"):
        shutil.copytree(BUNDLE / name, destination / name)
    read_bundle(destination / "data", destination / "index")
