from __future__ import annotations

import json
from pathlib import Path

from src.document_sources import (
    AccessContext,
    LocalFileDocumentSource,
    load_source_manifest,
    sync_document_source,
)


def test_local_file_document_source_sync_is_incremental_and_idempotent(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    data_dir = tmp_path / "data"
    manifest_path = tmp_path / "index" / "source_manifest.json"
    source_dir.mkdir()
    first_pdf = source_dir / "first.pdf"
    first_pdf.write_bytes(b"%PDF-1.4 first")

    source = LocalFileDocumentSource(source_dir)
    context = AccessContext(workspace_id="deal-alpha", user_id="user-1", role="admin")

    first_sync = sync_document_source(
        source,
        destination_dir=data_dir,
        manifest_path=manifest_path,
        context=context,
    )

    assert first_sync.added == ["first.pdf"]
    assert first_sync.updated == []
    assert (data_dir / "first.pdf").exists()

    second_sync = sync_document_source(
        source,
        destination_dir=data_dir,
        manifest_path=manifest_path,
        context=context,
    )

    assert second_sync.added == []
    assert second_sync.updated == []
    assert second_sync.unchanged_count == 1

    first_pdf.write_bytes(b"%PDF-1.4 first changed")
    third_sync = sync_document_source(
        source,
        destination_dir=data_dir,
        manifest_path=manifest_path,
        context=context,
    )

    assert third_sync.updated == ["first.pdf"]

    first_pdf.unlink()
    fourth_sync = sync_document_source(
        source,
        destination_dir=data_dir,
        manifest_path=manifest_path,
        context=context,
    )

    assert fourth_sync.deleted == ["first.pdf"]
    assert not (data_dir / "first.pdf").exists()
    assert load_source_manifest(manifest_path) is not None


def test_local_file_document_source_applies_acl_sidecars(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    (source_dir / "allowed.pdf").write_bytes(b"allowed")
    restricted = source_dir / "restricted.pdf"
    restricted.write_bytes(b"restricted")
    restricted.with_suffix(".acl.json").write_text(
        json.dumps({"allowed_workspaces": ["other-deal"], "allowed_roles": ["admin"]}),
        encoding="utf-8",
    )

    source = LocalFileDocumentSource(source_dir)
    context = AccessContext(workspace_id="deal-alpha", user_id="user-1", role="admin")

    documents = source.list_documents(context)

    assert [document.filename for document in documents] == ["allowed.pdf"]


def test_local_file_source_does_not_duplicate_when_source_is_data_dir(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest_path = tmp_path / "index" / "source_manifest.json"
    data_dir.mkdir()
    (data_dir / "existing.pdf").write_bytes(b"%PDF already in data")

    source = LocalFileDocumentSource(data_dir)
    context = AccessContext(workspace_id="local", user_id="user-1", role="admin")

    result = sync_document_source(
        source,
        destination_dir=data_dir,
        manifest_path=manifest_path,
        context=context,
    )

    assert result.added == ["existing.pdf"]
    assert sorted(path.name for path in data_dir.glob("*.pdf")) == ["existing.pdf"]
