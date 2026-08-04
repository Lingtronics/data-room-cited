from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Protocol

from pydantic import BaseModel, Field


class AccessContext(BaseModel):
    workspace_id: str = Field(description="Authenticated tenant or workspace identifier.")
    user_id: str = Field(description="Authenticated user or service principal identifier.")
    role: str = Field(default="reader", description="Authenticated role used for source ACL filtering.")
    scopes: list[str] = Field(default_factory=list, description="Tool or connector scopes granted.")
    allowed_document_ids: list[str] = Field(
        default_factory=list,
        description="Optional source document allowlist. Empty means all documents allowed by ACL.",
    )


class DocumentMetadata(BaseModel):
    document_id: str = Field(description="Stable source-system document identifier.")
    title: str = Field(description="Human-readable document title.")
    filename: str = Field(description="Safe local filename for the document.")
    source_system: str = Field(description="Source system, such as local-file or s3.")
    uri: str = Field(description="Source-system URI.")
    content_hash: str = Field(description="Hash or provider checksum used for change detection.")
    version: str = Field(description="Source object version or synthetic version.")
    size_bytes: int = Field(description="Document size in bytes.")
    last_modified: str | None = Field(default=None, description="Source last-modified timestamp.")
    data_classification: str = Field(default="internal", description="Source classification.")
    sensitivity_level: str = Field(default="low", description="Source sensitivity level.")
    acl: dict[str, Any] = Field(default_factory=dict, description="Source ACL metadata.")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional source metadata.")
    deleted: bool = Field(default=False, description="Whether this source document is deleted.")


class ChangeSet(BaseModel):
    cursor: str = Field(description="Opaque cursor representing the current source snapshot.")
    added: list[DocumentMetadata] = Field(default_factory=list)
    updated: list[DocumentMetadata] = Field(default_factory=list)
    deleted: list[DocumentMetadata] = Field(default_factory=list)
    unchanged: list[DocumentMetadata] = Field(default_factory=list)


class SourceSyncRecord(BaseModel):
    metadata: DocumentMetadata
    local_path: str
    synced_at: str


class SourceSyncManifest(BaseModel):
    source_system: str
    cursor: str
    generated_at: str
    records: dict[str, SourceSyncRecord] = Field(default_factory=dict)


class SourceSyncResult(BaseModel):
    source_system: str
    manifest_path: str
    cursor: str
    added: list[str]
    updated: list[str]
    deleted: list[str]
    unchanged_count: int


class DocumentSource(Protocol):
    source_system: str

    def list_documents(self, context: AccessContext) -> list[DocumentMetadata]:
        """List documents visible to the authenticated context."""

    def download_document(self, document_id: str, context: AccessContext) -> BinaryIO:
        """Return a readable binary stream for one document."""

    def get_changes(self, cursor: str | None, context: AccessContext) -> ChangeSet:
        """Return source changes since an opaque cursor."""


class LocalFileDocumentSource:
    source_system = "local-file"

    def __init__(self, source_dir: Path):
        self.source_dir = source_dir

    def list_documents(self, context: AccessContext) -> list[DocumentMetadata]:
        self.source_dir.mkdir(parents=True, exist_ok=True)
        documents = [
            _metadata_for_local_pdf(path)
            for path in sorted(self.source_dir.glob("*.pdf"))
        ]
        return [document for document in documents if _metadata_allowed(document, context)]

    def download_document(self, document_id: str, context: AccessContext) -> BinaryIO:
        document = _find_document(self.list_documents(context), document_id)
        if document is None:
            raise FileNotFoundError(f"Document is not visible or does not exist: {document_id}")
        return open(self.source_dir / document.filename, "rb")

    def get_changes(self, cursor: str | None, context: AccessContext) -> ChangeSet:
        current = self.list_documents(context)
        return _changes_from_cursor(cursor, current, self.source_system)


class S3DocumentSource:
    source_system = "s3"

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str = "",
        endpoint_url: str | None = None,
        client: Any | None = None,
    ):
        if not bucket:
            raise ValueError("S3 bucket is required.")
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.client = client or _boto3_client(endpoint_url)

    def list_documents(self, context: AccessContext) -> list[DocumentMetadata]:
        documents: list[DocumentMetadata] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix):
            for item in page.get("Contents", []):
                key = item["Key"]
                if key.endswith("/") or not key.lower().endswith(".pdf"):
                    continue
                metadata = self._metadata_for_object(key, item)
                if _metadata_allowed(metadata, context):
                    documents.append(metadata)
        return documents

    def download_document(self, document_id: str, context: AccessContext) -> BinaryIO:
        document = _find_document(self.list_documents(context), document_id)
        if document is None:
            raise FileNotFoundError(f"Document is not visible or does not exist: {document_id}")
        key = document.metadata["s3_key"]
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"]

    def get_changes(self, cursor: str | None, context: AccessContext) -> ChangeSet:
        current = self.list_documents(context)
        return _changes_from_cursor(cursor, current, self.source_system)

    def _metadata_for_object(self, key: str, item: dict[str, Any]) -> DocumentMetadata:
        head = self.client.head_object(Bucket=self.bucket, Key=key)
        tags = _s3_tags(self.client, self.bucket, key)
        etag = str(head.get("ETag") or item.get("ETag") or "").strip('"')
        version = str(head.get("VersionId") or etag or item.get("LastModified") or "unknown")
        last_modified = item.get("LastModified") or head.get("LastModified")
        metadata = head.get("Metadata", {}) or {}
        classification = tags.get("classification") or metadata.get("classification") or "internal"
        sensitivity = tags.get("sensitivity") or metadata.get("sensitivity") or "low"
        return DocumentMetadata(
            document_id=f"s3://{self.bucket}/{key}",
            title=Path(key).stem.replace("_", " "),
            filename=_safe_filename(Path(key).name),
            source_system=self.source_system,
            uri=f"s3://{self.bucket}/{key}",
            content_hash=etag or _hash_text(f"{self.bucket}/{key}/{version}"),
            version=version,
            size_bytes=int(item.get("Size") or head.get("ContentLength") or 0),
            last_modified=_isoformat(last_modified),
            data_classification=classification,
            sensitivity_level=sensitivity,
            acl={"tags": tags},
            metadata={
                "bucket": self.bucket,
                "s3_key": key,
                "etag": etag,
                "server_side_encryption": head.get("ServerSideEncryption"),
            },
        )


def source_from_settings(settings: Any) -> DocumentSource:
    source_type = settings.document_source_type.lower()
    if source_type == "local":
        return LocalFileDocumentSource(settings.local_source_dir)
    if source_type == "s3":
        return S3DocumentSource(
            bucket=settings.s3_source_bucket or "",
            prefix=settings.s3_source_prefix,
            endpoint_url=settings.s3_endpoint_url,
        )
    raise ValueError(f"Unsupported DOCUMENT_SOURCE_TYPE: {settings.document_source_type}")


def default_access_context(settings: Any) -> AccessContext:
    return AccessContext(
        workspace_id="local",
        user_id="local-user",
        role="admin",
        scopes=["documents:read", "index:write"],
        allowed_document_ids=[],
    )


def sync_document_source(
    source: DocumentSource,
    *,
    destination_dir: Path,
    manifest_path: Path,
    context: AccessContext,
) -> SourceSyncResult:
    destination_dir.mkdir(parents=True, exist_ok=True)
    previous = load_source_manifest(manifest_path)
    changes = source.get_changes(previous.cursor if previous else None, context)
    previous_records = previous.records if previous else {}
    records: dict[str, SourceSyncRecord] = {
        document_id: record
        for document_id, record in previous_records.items()
        if document_id not in {document.document_id for document in changes.deleted}
    }
    added: list[str] = []
    updated: list[str] = []
    deleted: list[str] = []

    for document in changes.deleted:
        record = previous_records.get(document.document_id)
        if record:
            local_path = Path(record.local_path)
            if local_path.exists() and local_path.resolve().parent == destination_dir.resolve():
                local_path.unlink()
        records.pop(document.document_id, None)
        deleted.append(document.filename)

    for label, documents in (("added", changes.added), ("updated", changes.updated)):
        for document in documents:
            destination = _existing_local_destination(document, destination_dir)
            if destination is None:
                previous_record = records.get(document.document_id)
                destination = _destination_for_document(destination_dir, document, previous_record)
                stream = source.download_document(document.document_id, context)
                try:
                    _write_stream(stream, destination)
                finally:
                    close = getattr(stream, "close", None)
                    if callable(close):
                        close()
            record = SourceSyncRecord(
                metadata=document,
                local_path=str(destination),
                synced_at=_utc_now(),
            )
            records[document.document_id] = record
            if label == "added":
                added.append(document.filename)
            else:
                updated.append(document.filename)

    manifest = SourceSyncManifest(
        source_system=source.source_system,
        cursor=changes.cursor,
        generated_at=_utc_now(),
        records=records,
    )
    save_source_manifest(manifest_path, manifest)
    return SourceSyncResult(
        source_system=source.source_system,
        manifest_path=str(manifest_path),
        cursor=changes.cursor,
        added=added,
        updated=updated,
        deleted=deleted,
        unchanged_count=len(changes.unchanged),
    )


def load_source_manifest(path: Path) -> SourceSyncManifest | None:
    if not path.exists():
        return None
    return SourceSyncManifest.model_validate_json(path.read_text(encoding="utf-8"))


def save_source_manifest(path: Path, manifest: SourceSyncManifest) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")


def _metadata_for_local_pdf(path: Path) -> DocumentMetadata:
    stat = path.stat()
    content_hash = _hash_file(path)
    acl = _read_acl(path)
    return DocumentMetadata(
        document_id=f"local://{path.name}",
        title=path.stem.replace("_", " "),
        filename=_safe_filename(path.name),
        source_system=LocalFileDocumentSource.source_system,
        uri=str(path.resolve()),
        content_hash=content_hash,
        version=f"{stat.st_mtime_ns}:{content_hash[:12]}",
        size_bytes=stat.st_size,
        last_modified=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        data_classification=str(acl.get("classification") or "internal"),
        sensitivity_level=str(acl.get("sensitivity") or "low"),
        acl=acl,
        metadata={"source_path": str(path.resolve())},
    )


def _changes_from_cursor(
    cursor: str | None,
    current: list[DocumentMetadata],
    source_system: str,
) -> ChangeSet:
    previous = _decode_cursor(cursor)
    current_by_id = {document.document_id: document for document in current}
    added: list[DocumentMetadata] = []
    updated: list[DocumentMetadata] = []
    unchanged: list[DocumentMetadata] = []
    for document in current:
        old = previous.get(document.document_id)
        signature = _signature(document)
        if old is None:
            added.append(document)
        elif old != signature:
            updated.append(document)
        else:
            unchanged.append(document)
    deleted = [
        DocumentMetadata(
            document_id=document_id,
            title=document_id,
            filename=_safe_filename(document_id.split("/")[-1]),
            source_system=source_system,
            uri=document_id,
            content_hash=signature.get("content_hash", ""),
            version=signature.get("version", ""),
            size_bytes=0,
            deleted=True,
        )
        for document_id, signature in previous.items()
        if document_id not in current_by_id
    ]
    return ChangeSet(
        cursor=_encode_cursor(current),
        added=added,
        updated=updated,
        deleted=deleted,
        unchanged=unchanged,
    )


def _metadata_allowed(document: DocumentMetadata, context: AccessContext) -> bool:
    if context.allowed_document_ids:
        allowed = {_normalize_document_id(item) for item in context.allowed_document_ids}
        candidates = {
            _normalize_document_id(document.document_id),
            _normalize_document_id(document.filename),
            _normalize_document_id(document.uri),
        }
        if allowed.isdisjoint(candidates):
            return False
    allowed_workspaces = _acl_list(document.acl, "allowed_workspaces")
    if allowed_workspaces and context.workspace_id not in allowed_workspaces:
        return False
    allowed_roles = _acl_list(document.acl, "allowed_roles")
    if allowed_roles and context.role not in allowed_roles:
        return False
    return True


def _acl_list(acl: dict[str, Any], key: str) -> list[str]:
    value = acl.get(key)
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _find_document(documents: list[DocumentMetadata], document_id: str) -> DocumentMetadata | None:
    normalized = _normalize_document_id(document_id)
    return next(
        (
            document
            for document in documents
            if normalized
            in {
                _normalize_document_id(document.document_id),
                _normalize_document_id(document.filename),
                _normalize_document_id(document.uri),
            }
        ),
        None,
    )


def _encode_cursor(documents: list[DocumentMetadata]) -> str:
    payload = {
        document.document_id: _signature(document)
        for document in sorted(documents, key=lambda item: item.document_id)
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str | None) -> dict[str, dict[str, str]]:
    if not cursor:
        return {}
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(document_id): {
            "version": str(signature.get("version", "")),
            "content_hash": str(signature.get("content_hash", "")),
        }
        for document_id, signature in data.items()
        if isinstance(signature, dict)
    }


def _signature(document: DocumentMetadata) -> dict[str, str]:
    return {"version": document.version, "content_hash": document.content_hash}


def _safe_filename(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(name).name).strip(" .")
    if not safe.lower().endswith(".pdf"):
        safe = f"{Path(safe).stem or 'document'}.pdf"
    return safe


def _unique_destination(destination_dir: Path, filename: str) -> Path:
    candidate = destination_dir / _safe_filename(filename)
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 2
    while True:
        next_candidate = destination_dir / f"{stem}_{counter}{suffix}"
        if not next_candidate.exists():
            return next_candidate
        counter += 1


def _destination_for_document(
    destination_dir: Path,
    document: DocumentMetadata,
    previous_record: SourceSyncRecord | None,
) -> Path:
    if previous_record:
        previous_path = Path(previous_record.local_path)
        if previous_path.parent.resolve() == destination_dir.resolve():
            return previous_path
    return _unique_destination(destination_dir, document.filename)


def _existing_local_destination(document: DocumentMetadata, destination_dir: Path) -> Path | None:
    source_path = document.metadata.get("source_path")
    if not isinstance(source_path, str):
        return None
    candidate = Path(source_path)
    try:
        if candidate.resolve().parent == destination_dir.resolve() and candidate.exists():
            return candidate
    except OSError:
        return None
    return None


def _read_acl(path: Path) -> dict[str, Any]:
    for sidecar in (path.with_suffix(f"{path.suffix}.acl.json"), path.with_suffix(".acl.json")):
        if sidecar.exists():
            return json.loads(sidecar.read_text(encoding="utf-8"))
    return {}


def _write_stream(stream: BinaryIO, destination: Path) -> None:
    tmp_path = destination.with_suffix(f"{destination.suffix}.tmp")
    with open(tmp_path, "wb") as output:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    tmp_path.replace(destination)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_document_id(value: str) -> str:
    return Path(value.replace("\\", "/").split("/")[-1]).name.lower()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _isoformat(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _s3_tags(client: Any, bucket: str, key: str) -> dict[str, str]:
    try:
        response = client.get_object_tagging(Bucket=bucket, Key=key)
    except Exception:
        return {}
    return {item["Key"]: item["Value"] for item in response.get("TagSet", [])}


def _boto3_client(endpoint_url: str | None) -> Any:
    import boto3

    kwargs = {"endpoint_url": endpoint_url} if endpoint_url else {}
    return boto3.client("s3", **kwargs)
