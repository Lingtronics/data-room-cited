from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from src import mcp_tools, voice_fixture
from src.index_store import load_index
from src.voice_core import install_voice_profile


@pytest.fixture
def fixture_env(tmp_path, monkeypatch):
    root = tmp_path / "voice"
    voice_fixture.prepare(root)
    for name, value in {
        "VOICE_FEATURE_ENABLED": "true", "VOICE_READ_ONLY_DEMO": "true",
        "VOICE_FIXTURE_DATA_DIR": str(root / "data"), "DATA_DIR": str(root / "data"),
        "VOICE_FIXTURE_INDEX_DIR": str(root / "index"), "INDEX_DIR": str(root / "index"),
        "DOCUMENT_SOURCE_TYPE": "local", "OTEL_SDK_DISABLED": "true",
        "DEEPSEEK_API_KEY": "", "ELEVENLABS_API_KEY": "",
    }.items():
        monkeypatch.setenv(name, value)
    return root


def request(app, path, *, method="POST", payload=None, headers=None, peer="127.0.0.1"):
    async def run():
        transport = httpx.ASGITransport(app=app, client=(peer, 12345))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.request(method, path, json=payload, headers=headers)
    return asyncio.run(run())


def headers(docs=None, scope="documents:read,citations:verify"):
    return {"x-workspace-id": voice_fixture.WORKSPACE, "x-auth-scopes": scope,
            "x-allowed-document-ids": ",".join(docs or voice_fixture.manifest()["documents"])}


def app():
    instance = FastAPI()
    install_voice_profile(instance)
    return instance


def test_preparation_is_exclusive_and_index_reuses_existing_loader(fixture_env):
    with pytest.raises(FileExistsError):
        voice_fixture.prepare(fixture_env)
    chunks, embeddings = load_index(fixture_env / "index")
    assert len(chunks) == 3
    assert embeddings.shape == (3, 384)
    assert not embeddings.any()
    for chunk in chunks:
        assert chunk.text in (fixture_env / "data" / chunk.doc).read_text()


@pytest.mark.parametrize("change", ["extra_data", "extra_index", "changed_text", "changed_chunk", "missing", "linked_index"])
def test_unapproved_or_modified_corpus_is_rejected(fixture_env, tmp_path, change):
    if change == "extra_data":
        (fixture_env / "data" / "private.pdf").write_bytes(b"synthetic negative-test sentinel")
    elif change == "extra_index":
        (fixture_env / "index" / "private.json").write_text("{}")
    elif change == "changed_text":
        (fixture_env / "data" / voice_fixture.manifest()["documents"][0]).write_text("changed")
    elif change == "changed_chunk":
        target = fixture_env / "index" / "chunks.json"
        target.write_bytes(target.read_bytes().replace(b"Alder", b"Other"))
    elif change == "missing":
        (fixture_env / "index" / "embeddings.npy").unlink()
    else:
        # A symlink test is portable on Linux; Windows may need developer mode.
        target = fixture_env / "index" / "chunks.json"
        saved = tmp_path / "copy.json"
        target.rename(saved)
        try:
            target.symlink_to(saved)
        except OSError:
            pytest.skip("OS does not permit symlink creation")
    with pytest.raises((ValueError, OSError)):
        voice_fixture.configured_snapshot()


@pytest.mark.parametrize("name,value", [
    ("VOICE_READ_ONLY_DEMO", "false"), ("DOCUMENT_SOURCE_TYPE", "s3"),
    ("DATA_DIR", "data"), ("INDEX_DIR", "index"), ("VOICE_FIXTURE_DATA_DIR", ""),
])
def test_unsafe_configuration_refuses_startup(fixture_env, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises((ValueError, OSError)):
        app()


def test_disabled_profile_preserves_ordinary_app(monkeypatch):
    monkeypatch.setenv("VOICE_FEATURE_ENABLED", "false")
    assert not app().user_middleware
    monkeypatch.setenv("VOICE_FEATURE_ENABLED", "typo")
    with pytest.raises(ValueError):
        app()


def test_search_and_verified_metadata_without_external_credentials(fixture_env, monkeypatch):
    monkeypatch.setattr(mcp_tools, "embed_one", lambda *_: pytest.fail("No model calls in lexical fixture"))
    service = app()
    found = request(service, "/retrieval/search", payload={"query": "automatic renewal"}, headers=headers())
    assert found.status_code == 200
    assert found.json()["data"]["mode"] == "lexical"
    chunk = found.json()["data"]["results"][0]
    assert chunk["page_label"] is None
    assert "page" not in chunk and "source" not in chunk
    verified = request(service, "/citations/verify", payload={"chunk_id": chunk["chunk_id"], "quote": chunk["text"]}, headers=headers())
    assert verified.json()["data"]["verified"] is True
    assert verified.json()["data"]["document"] == chunk["doc"]
    assert verified.json()["data"]["page_label"] is None
    assert "source" not in verified.json()["data"]
    wrong = request(service, "/citations/verify", payload={"chunk_id": chunk["chunk_id"], "quote": "fabricated earnings"}, headers=headers())
    assert wrong.json()["data"]["verified"] is False
    assert "document" not in wrong.json()["data"]


def test_cross_document_and_unknown_chunk_fail_closed(fixture_env):
    service = app()
    only_contracts = headers(["synthetic_contracts_2025.txt"])
    for cid in ["voice-notes-2024-1", "private-guessed-1"]:
        denied = request(service, "/citations/verify", payload={"chunk_id": cid, "quote": "SYNTHETIC"}, headers=only_contracts)
        assert denied.status_code == 403
        assert "source" not in denied.text
    found = request(service, "/retrieval/search", payload={"query": "Birch pilot"}, headers=only_contracts)
    assert found.json()["data"]["results"] == []


@pytest.mark.parametrize("path", ["/index/rebuild", "/connectors/sync", "/exports/outlines", "/chunks/voice-notes-2024-1", "/docs", "/openapi.json", "/catalogue/search"])
def test_direct_core_routes_cannot_bypass_gateway(fixture_env, path):
    before = voice_fixture.configured_snapshot()
    denied = request(app(), path, payload={}, headers=headers())
    assert denied.status_code == 403
    assert voice_fixture.configured_snapshot() == before


@pytest.mark.parametrize("payload", [
    {"query": "x", "semantic": True}, {"query": "x", "year": 2025},
    {"query": "x", "top_k": 6}, {"query": "x", "top_k": True},
    {"query": "x" * 2001}, {"query": " "}, [],
])
def test_strict_bounded_voice_inputs(fixture_env, payload):
    assert request(app(), "/retrieval/search", payload=payload, headers=headers()).status_code == 400


def test_fixture_drift_and_untrusted_access_fail_after_startup(fixture_env):
    service = app()
    for bad in [headers(scope="admin:connectors"), headers(["private.pdf"]), {},
                {**headers(), "x-workspace-id": "other-workspace"}]:
        assert request(service, "/retrieval/search", payload={"query": "renewal"}, headers=bad).status_code == 403
    assert request(service, "/health", method="GET", peer="203.0.113.1").status_code == 403
    assert request(service, "/health", method="GET", headers={"host": "evil.test"}).status_code == 403
    (fixture_env / "data" / "extra.txt").write_text("synthetic sentinel")
    assert request(service, "/health", method="GET").status_code == 503


def test_upstream_exception_is_sanitized(fixture_env, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("secret-and-document-excerpt-sentinel")
    monkeypatch.setattr(mcp_tools, "search_data_room", broken)
    result = request(app(), "/retrieval/search", payload={"query": "renewal"}, headers=headers())
    assert result.status_code == 503
    assert "secret-and-document" not in result.text


def test_verification_authority_fields_and_oversized_body_are_denied(fixture_env):
    service = app()
    invalid = request(service, "/citations/verify", payload={
        "chunk_id": "voice-contracts-2025-1", "quote": "SYNTHETIC", "verified": True,
    }, headers=headers())
    assert invalid.status_code == 400
    oversized = request(service, "/retrieval/search", payload={"query": "x" * 17_000}, headers=headers())
    assert oversized.status_code == 413
