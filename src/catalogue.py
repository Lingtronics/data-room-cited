from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from src.config import Settings
from src.index_store import load_index
from src.schemas import Chunk


AssetType = Literal["document", "chunk", "generated_artifact"]
ExtractionStatus = Literal["indexed", "needs_ocr", "missing_source_pdf", "generated"]


class LineageRef(BaseModel):
    asset_id: str = Field(description="Catalogue asset identifier at the other end of the lineage edge.")
    relationship: str = Field(description="Relationship type, such as HAS_CHUNK or USED_AS_EVIDENCE.")


class DataAsset(BaseModel):
    asset_id: str = Field(description="Stable local catalogue identifier.")
    asset_type: AssetType = Field(description="Type of asset represented in the catalogue.")
    title: str = Field(description="Human-readable title or filename.")
    owner: str = Field(description="Business or technical owner when known.")
    source_system: str = Field(description="Source system or local folder that supplied the asset.")
    data_classification: str = Field(description="Classification such as internal or confidential.")
    sensitivity_level: str = Field(description="Low, medium, or high sensitivity.")
    business_domain: str = Field(description="Primary business domain inferred from filename and text.")
    ingestion_timestamp: str = Field(description="UTC timestamp when this catalogue snapshot was built.")
    document_version: str = Field(description="Document or artifact version when known.")
    extraction_status: ExtractionStatus = Field(description="Whether text extraction/indexing succeeded.")
    indexed_pages: list[int] = Field(default_factory=list, description="One-indexed pages represented.")
    chunk_ids: list[str] = Field(default_factory=list, description="Chunks belonging to or cited by this asset.")
    upstream: list[LineageRef] = Field(default_factory=list, description="Assets this asset depends on.")
    downstream: list[LineageRef] = Field(default_factory=list, description="Assets derived from this asset.")
    warnings: list[str] = Field(default_factory=list, description="Quality or governance warnings.")
    metadata: dict[str, str | int | float | bool | None] = Field(
        default_factory=dict,
        description="Additional local metadata for inspection.",
    )


class Catalogue(BaseModel):
    generated_at: str = Field(description="UTC timestamp when the catalogue was generated.")
    assets: list[DataAsset] = Field(description="Document, chunk, and generated artifact assets.")


def build_catalogue(settings: Settings, chunks: list[Chunk]) -> Catalogue:
    generated_at = _utc_now()
    chunks_by_doc: dict[str, list[Chunk]] = defaultdict(list)
    for chunk in chunks:
        chunks_by_doc[chunk.doc].append(chunk)

    pdfs_by_name = {pdf.name: pdf for pdf in sorted(settings.data_dir.glob("*.pdf"))}
    assets: list[DataAsset] = []
    doc_asset_ids: dict[str, str] = {}

    for doc_name in sorted(set(pdfs_by_name) | set(chunks_by_doc)):
        doc_chunks = chunks_by_doc.get(doc_name, [])
        doc_asset_id = _document_asset_id(doc_name)
        doc_asset_ids[doc_name] = doc_asset_id
        pages = sorted({page for chunk in doc_chunks for page in range(chunk.start_page, chunk.end_page + 1)})
        classification = _classification_for_document(doc_name, doc_chunks)
        status: ExtractionStatus = "indexed"
        warnings: list[str] = []
        if doc_name in pdfs_by_name and not doc_chunks:
            status = "needs_ocr"
            warnings.append("No indexed chunks. Run OCR before relying on this document.")
        elif doc_name not in pdfs_by_name:
            status = "missing_source_pdf"
            warnings.append("Indexed chunks exist, but the source PDF is no longer in data/.")
        assets.append(
            DataAsset(
                asset_id=doc_asset_id,
                asset_type="document",
                title=Path(doc_name).stem.replace("_", " "),
                owner="Unknown",
                source_system="local data/ folder",
                data_classification=classification,
                sensitivity_level=_sensitivity_for(classification, doc_name),
                business_domain=_business_domain_for(doc_name, doc_chunks),
                ingestion_timestamp=generated_at,
                document_version=_version_for(doc_name),
                extraction_status=status,
                indexed_pages=pages,
                chunk_ids=[chunk.chunk_id for chunk in doc_chunks],
                warnings=warnings,
                metadata={
                    "filename": doc_name,
                    "size_bytes": pdfs_by_name[doc_name].stat().st_size if doc_name in pdfs_by_name else None,
                    "indexed_chunks": len(doc_chunks),
                },
            )
        )

    for chunk in chunks:
        chunk_asset_id = _chunk_asset_id(chunk.chunk_id)
        doc_asset_id = doc_asset_ids.get(chunk.doc, _document_asset_id(chunk.doc))
        assets.append(
            DataAsset(
                asset_id=chunk_asset_id,
                asset_type="chunk",
                title=f"{chunk.doc} / {chunk.chunk_id}",
                owner="Unknown",
                source_system="local chunker",
                data_classification=_classification_for_document(chunk.doc, [chunk]),
                sensitivity_level=_sensitivity_for(_classification_for_document(chunk.doc, [chunk]), chunk.doc),
                business_domain=_business_domain_for(chunk.doc, [chunk]),
                ingestion_timestamp=generated_at,
                document_version=_version_for(chunk.doc),
                extraction_status="indexed",
                indexed_pages=list(range(chunk.start_page, chunk.end_page + 1)),
                chunk_ids=[chunk.chunk_id],
                upstream=[LineageRef(asset_id=doc_asset_id, relationship="CHUNK_OF")],
                metadata={
                    "doc": chunk.doc,
                    "page_start": chunk.start_page,
                    "page_end": chunk.end_page,
                    "section_title": chunk.section_title,
                    "has_generated_context": bool(chunk.context),
                },
            )
        )

    assets.extend(_artifact_assets(settings, generated_at))
    return _with_downstream(Catalogue(generated_at=generated_at, assets=assets))


def save_catalogue(settings: Settings, catalogue: Catalogue) -> None:
    settings.catalogue_path.parent.mkdir(parents=True, exist_ok=True)
    settings.catalogue_path.write_text(
        json.dumps(catalogue.model_dump(mode="json"), indent=2),
        encoding="utf-8",
    )


def load_catalogue(settings: Settings | None = None) -> Catalogue:
    settings = settings or Settings.from_env()
    if not settings.catalogue_path.exists():
        chunks, _ = load_index(settings.index_dir)
        catalogue = build_catalogue(settings, chunks)
        save_catalogue(settings, catalogue)
        return catalogue
    data = json.loads(settings.catalogue_path.read_text(encoding="utf-8"))
    return Catalogue.model_validate(data)


def search_catalogue(query: str, limit: int = 10, settings: Settings | None = None) -> dict:
    catalogue = load_catalogue(settings)
    terms = _terms(query)
    scored: list[tuple[int, int, DataAsset]] = []
    for index, asset in enumerate(catalogue.assets):
        haystack = " ".join(
            [
                asset.asset_id,
                asset.title,
                asset.asset_type,
                asset.source_system,
                asset.data_classification,
                asset.sensitivity_level,
                asset.business_domain,
                asset.extraction_status,
                " ".join(asset.chunk_ids),
            ]
        ).lower()
        score = sum(1 for term in terms if term in haystack)
        if score:
            scored.append((-score, index, asset))
    scored.sort()
    return {
        "query": query,
        "matches": [_asset_summary(asset) for _, _, asset in scored[: max(1, limit)]],
    }


def get_data_asset(asset_id: str, settings: Settings | None = None) -> dict:
    asset = _asset_by_id(asset_id, settings)
    if asset is None:
        return {"found": False, "asset_id": asset_id}
    return {"found": True, "asset": asset.model_dump(mode="json")}


def get_asset_lineage(asset_id: str, depth: int = 2, settings: Settings | None = None) -> dict:
    catalogue = load_catalogue(settings)
    by_id = {asset.asset_id: asset for asset in catalogue.assets}
    if asset_id not in by_id:
        return {"found": False, "asset_id": asset_id, "lineage": []}

    visited = {asset_id}
    queue: deque[tuple[str, int]] = deque([(asset_id, 0)])
    lineage = []
    while queue:
        current_id, current_depth = queue.popleft()
        if current_depth >= max(0, depth):
            continue
        asset = by_id[current_id]
        for direction, refs in (("upstream", asset.upstream), ("downstream", asset.downstream)):
            for ref in refs:
                if ref.asset_id not in by_id:
                    continue
                lineage.append(
                    {
                        "from": current_id if direction == "downstream" else ref.asset_id,
                        "to": ref.asset_id if direction == "downstream" else current_id,
                        "relationship": ref.relationship,
                        "direction": direction,
                        "asset": _asset_summary(by_id[ref.asset_id]),
                    }
                )
                if ref.asset_id not in visited:
                    visited.add(ref.asset_id)
                    queue.append((ref.asset_id, current_depth + 1))
    return {"found": True, "asset_id": asset_id, "lineage": lineage}


def get_data_quality_status(settings: Settings | None = None) -> dict:
    catalogue = load_catalogue(settings)
    by_status = defaultdict(int)
    warnings = []
    for asset in catalogue.assets:
        by_status[asset.extraction_status] += 1
        for warning in asset.warnings:
            warnings.append({"asset_id": asset.asset_id, "warning": warning})
    return {
        "generated_at": catalogue.generated_at,
        "asset_count": len(catalogue.assets),
        "status_counts": dict(sorted(by_status.items())),
        "warnings": warnings,
    }


def _artifact_assets(settings: Settings, generated_at: str) -> list[DataAsset]:
    assets: list[DataAsset] = []
    for path in sorted(settings.export_dir.glob("*")):
        if path.suffix.lower() not in {".md", ".txt"} or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        chunk_ids = sorted(set(re.findall(r"\b[0-9A-Za-z_(). -]+-\d{4}\b", text)))
        assets.append(
            DataAsset(
                asset_id=f"artifact:{_slug(path.stem)}",
                asset_type="generated_artifact",
                title=path.stem.replace("_", " "),
                owner="Unknown",
                source_system="local exports/ folder",
                data_classification="internal",
                sensitivity_level="medium",
                business_domain="diligence output",
                ingestion_timestamp=generated_at,
                document_version="generated",
                extraction_status="generated",
                indexed_pages=[],
                chunk_ids=chunk_ids,
                upstream=[
                    LineageRef(asset_id=_chunk_asset_id(chunk_id), relationship="USED_AS_EVIDENCE")
                    for chunk_id in chunk_ids
                ],
                metadata={"path": str(path), "characters": len(text)},
            )
        )
    return assets


def _with_downstream(catalogue: Catalogue) -> Catalogue:
    by_id = {asset.asset_id: asset for asset in catalogue.assets}
    downstream: dict[str, list[LineageRef]] = defaultdict(list)
    for asset in catalogue.assets:
        for ref in asset.upstream:
            downstream[ref.asset_id].append(LineageRef(asset_id=asset.asset_id, relationship=ref.relationship))
    updated = []
    for asset in catalogue.assets:
        updated.append(asset.model_copy(update={"downstream": downstream.get(asset.asset_id, [])}))
    return Catalogue(generated_at=catalogue.generated_at, assets=updated)


def _asset_by_id(asset_id: str, settings: Settings | None) -> DataAsset | None:
    catalogue = load_catalogue(settings)
    return next((asset for asset in catalogue.assets if asset.asset_id == asset_id), None)


def _asset_summary(asset: DataAsset) -> dict:
    return {
        "asset_id": asset.asset_id,
        "asset_type": asset.asset_type,
        "title": asset.title,
        "business_domain": asset.business_domain,
        "classification": asset.data_classification,
        "sensitivity": asset.sensitivity_level,
        "extraction_status": asset.extraction_status,
        "indexed_pages": asset.indexed_pages,
        "chunk_ids": asset.chunk_ids[:10],
        "warnings": asset.warnings,
    }


def _classification_for_document(doc_name: str, chunks: list[Chunk]) -> str:
    text = " ".join(chunk.text[:500] for chunk in chunks).lower()
    name = doc_name.lower()
    if "strictly confidential" in text or "project castor" in text or "contract" in name:
        return "confidential"
    return "internal"


def _sensitivity_for(classification: str, doc_name: str) -> str:
    lowered = doc_name.lower()
    if classification == "confidential" or any(term in lowered for term in ["contract", "financial"]):
        return "high"
    if any(term in lowered for term in ["market", "management"]):
        return "medium"
    return "low"


def _business_domain_for(doc_name: str, chunks: list[Chunk]) -> str:
    text = f"{doc_name} {' '.join(chunk.section_title or '' for chunk in chunks)}".lower()
    if any(term in text for term in ["contract", "legal"]):
        return "contracts and legal"
    if any(term in text for term in ["financial", "arr", "revenue", "margin"]):
        return "financial performance"
    if any(term in text for term in ["market", "competitor", "landscape"]):
        return "market and competition"
    if any(term in text for term in ["management", "leadership", "cto", "founder"]):
        return "management"
    if any(term in text for term in ["customer", "commercial"]):
        return "commercial"
    return "company overview"


def _version_for(doc_name: str) -> str:
    match = re.search(r"\b(20\d{2}(?:[-_ ]?(?:Q[1-4]|0[1-9]|1[0-2]))?)\b", doc_name)
    return match.group(1) if match else "unknown"


def _document_asset_id(doc_name: str) -> str:
    return f"document:{_slug(Path(doc_name).stem)}"


def _chunk_asset_id(chunk_id: str) -> str:
    return f"chunk:{chunk_id}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return slug or "asset"


def _terms(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
