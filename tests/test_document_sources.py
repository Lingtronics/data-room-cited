from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

from src.document_sources import (
    AccessContext,
    LocalFileDocumentSource,
    S3DocumentSource,
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


def test_s3_document_source_discovers_paginated_objects_with_tags_metadata_and_acl() -> None:
    client = FakeS3Client(page_size=1)
    client.put_object(
        "room/alpha.pdf",
        b"%PDF alpha",
        etag="etag-alpha",
        version_id="v1",
        tags={
            "classification": "confidential",
            "sensitivity": "high",
            "allowed_workspaces": "deal-alpha",
            "allowed_roles": "admin",
        },
        metadata={"owner": "commercial-dd"},
    )
    client.put_object(
        "room/restricted.pdf",
        b"%PDF restricted",
        tags={"allowed_workspaces": "deal-beta"},
    )
    client.put_object("room/notes.txt", b"not a pdf")
    source = S3DocumentSource(bucket="dataroom", prefix="room", client=client)
    context = AccessContext(workspace_id="deal-alpha", user_id="user-1", role="admin")

    documents = source.list_documents(context)

    assert [document.filename for document in documents] == ["alpha.pdf"]
    document = documents[0]
    assert document.document_id == "s3://dataroom/room/alpha.pdf"
    assert document.content_hash == "etag-alpha"
    assert document.version == "v1"
    assert document.data_classification == "confidential"
    assert document.sensitivity_level == "high"
    assert document.acl["allowed_workspaces"] == ["deal-alpha"]
    assert document.acl["allowed_roles"] == ["admin"]
    assert document.metadata["object_tags"]["classification"] == "confidential"
    assert document.metadata["user_metadata"]["owner"] == "commercial-dd"


def test_s3_document_source_tracks_versions_etags_deletions_and_repeat_sync(
    tmp_path: Path,
) -> None:
    client = FakeS3Client()
    client.put_object("room/alpha.pdf", b"%PDF alpha", etag="etag-alpha", version_id="v1")
    source = S3DocumentSource(bucket="dataroom", prefix="room", client=client)
    context = AccessContext(workspace_id="deal-alpha", user_id="user-1", role="admin")

    first_changes = source.get_changes(None, context)
    assert [document.filename for document in first_changes.added] == ["alpha.pdf"]

    destination_dir = tmp_path / "data"
    manifest_path = tmp_path / "index" / "source_manifest.json"
    first_sync = sync_document_source(
        source,
        destination_dir=destination_dir,
        manifest_path=manifest_path,
        context=context,
    )
    assert first_sync.added == ["alpha.pdf"]
    assert (destination_dir / "alpha.pdf").read_bytes() == b"%PDF alpha"

    repeat_sync = sync_document_source(
        source,
        destination_dir=destination_dir,
        manifest_path=manifest_path,
        context=context,
    )
    assert repeat_sync.added == []
    assert repeat_sync.updated == []
    assert repeat_sync.unchanged_count == 1

    client.put_object("room/alpha.pdf", b"%PDF alpha v2", etag="etag-alpha-2", version_id="v2")
    updated_changes = source.get_changes(first_changes.cursor, context)
    assert [document.version for document in updated_changes.updated] == ["v2"]

    updated_sync = sync_document_source(
        source,
        destination_dir=destination_dir,
        manifest_path=manifest_path,
        context=context,
    )
    assert updated_sync.updated == ["alpha.pdf"]
    assert (destination_dir / "alpha.pdf").read_bytes() == b"%PDF alpha v2"

    cursor_after_update = source.get_changes(first_changes.cursor, context).cursor
    client.delete_object("room/alpha.pdf")
    deleted_changes = source.get_changes(cursor_after_update, context)
    assert [document.filename for document in deleted_changes.deleted] == ["alpha.pdf"]

    deleted_sync = sync_document_source(
        source,
        destination_dir=destination_dir,
        manifest_path=manifest_path,
        context=context,
    )
    assert deleted_sync.deleted == ["alpha.pdf"]
    assert not (destination_dir / "alpha.pdf").exists()


def test_s3_document_source_surfaces_download_failures() -> None:
    client = FakeS3Client()
    client.put_object("room/fails.pdf", b"%PDF fail", fail_download=True)
    source = S3DocumentSource(bucket="dataroom", prefix="room", client=client)
    context = AccessContext(workspace_id="deal-alpha", user_id="user-1", role="admin")

    try:
        source.download_document("fails.pdf", context)
    except RuntimeError as exc:
        assert "download failed" in str(exc)
    else:
        raise AssertionError("Expected S3 download failure to propagate.")


class FakeS3Client:
    def __init__(self, *, page_size: int = 100):
        self.page_size = page_size
        self.objects: dict[str, dict[str, Any]] = {}

    def put_object(
        self,
        key: str,
        body: bytes,
        *,
        etag: str | None = None,
        version_id: str | None = None,
        tags: dict[str, str] | None = None,
        metadata: dict[str, str] | None = None,
        fail_download: bool = False,
    ) -> None:
        self.objects[key] = {
            "body": body,
            "etag": etag or f"etag-{len(body)}",
            "version_id": version_id,
            "tags": tags or {},
            "metadata": metadata or {},
            "last_modified": datetime(2026, 8, 4, tzinfo=timezone.utc),
            "fail_download": fail_download,
        }

    def delete_object(self, key: str) -> None:
        self.objects.pop(key, None)

    def get_paginator(self, operation_name: str) -> "FakeS3Paginator":
        assert operation_name == "list_objects_v2"
        return FakeS3Paginator(self)

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        record = self.objects[Key]
        return {
            "ContentLength": len(record["body"]),
            "ETag": f'"{record["etag"]}"',
            "VersionId": record["version_id"],
            "LastModified": record["last_modified"],
            "Metadata": record["metadata"],
            "ServerSideEncryption": "AES256",
        }

    def get_object_tagging(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        record = self.objects[Key]
        return {"TagSet": [{"Key": key, "Value": value} for key, value in record["tags"].items()]}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        record = self.objects[Key]
        if record["fail_download"]:
            raise RuntimeError("download failed")
        return {"Body": BytesIO(record["body"])}


class FakeS3Paginator:
    def __init__(self, client: FakeS3Client):
        self.client = client

    def paginate(self, *, Bucket: str, Prefix: str) -> list[dict[str, Any]]:
        contents = []
        for key, record in sorted(self.client.objects.items()):
            if not key.startswith(Prefix):
                continue
            contents.append(
                {
                    "Key": key,
                    "Size": len(record["body"]),
                    "ETag": f'"{record["etag"]}"',
                    "LastModified": record["last_modified"],
                }
            )
        return [
            {"Contents": contents[index : index + self.client.page_size]}
            for index in range(0, len(contents), self.client.page_size)
        ]
