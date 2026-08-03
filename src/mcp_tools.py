from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from src import catalogue, knowledge_graph, semantic, taxonomy
from src.citations import quote_in_source
from src.config import Settings
from src.embeddings import embed_one
from src.index_builder import build_index
from src.index_store import load_index, retrieve
from src.schemas import Chunk


MAX_CHUNK_TEXT_CHARS = 5000
MAX_SEARCH_TOP_K = 50


def list_documents() -> dict[str, Any]:
    settings = Settings.from_env()
    pdfs = sorted(settings.data_dir.glob("*.pdf"))
    indexed_chunks = _load_chunks_or_empty(settings)
    chunk_counts = Counter(chunk.doc for chunk in indexed_chunks)
    return {
        "data_dir": str(settings.data_dir),
        "index_dir": str(settings.index_dir),
        "documents": [
            {
                "filename": pdf.name,
                "size_bytes": pdf.stat().st_size,
                "indexed_chunks": chunk_counts.get(pdf.name, 0),
                "indexed": chunk_counts.get(pdf.name, 0) > 0,
            }
            for pdf in pdfs
        ],
        "indexed_documents_without_pdf": sorted(
            doc for doc in chunk_counts if not (settings.data_dir / doc).exists()
        ),
    }


def search_data_room(query: str, top_k: int | None = None, semantic: bool = True) -> dict[str, Any]:
    settings = Settings.from_env()
    chunks, embeddings = load_index(settings.index_dir)
    selected_top_k = _clamp_top_k(top_k or settings.top_k)
    if not semantic:
        results = _lexical_search(query, chunks, selected_top_k)
        return {
            "query": query,
            "top_k": selected_top_k,
            "mode": "lexical",
            "results": [
                _chunk_payload(chunk, score=score, include_text=True) for chunk, score in results
            ],
        }

    query_embedding = embed_one(query)
    results = retrieve(
        query_embedding=query_embedding,
        chunks=chunks,
        embeddings=embeddings,
        top_k=selected_top_k,
    )
    return {
        "query": query,
        "top_k": selected_top_k,
        "mode": "semantic",
        "results": [
            _chunk_payload(chunk, score=score, include_text=True) for chunk, score in results
        ],
    }


def get_chunk(chunk_id: str) -> dict[str, Any]:
    chunk = _chunk_by_id(chunk_id)
    if chunk is None:
        return {
            "found": False,
            "chunk_id": chunk_id,
            "error": "Unknown chunk_id. Run list_documents or search_data_room first.",
        }
    return {"found": True, "chunk": _chunk_payload(chunk, include_text=True, include_context=True)}


def verify_citation(chunk_id: str, quote: str) -> dict[str, Any]:
    chunk = _chunk_by_id(chunk_id)
    if chunk is None:
        return {
            "verified": False,
            "reason": "unknown_chunk_id",
            "chunk_id": chunk_id,
            "quote": quote,
        }
    if not quote.strip():
        return {
            "verified": False,
            "reason": "empty_quote",
            "chunk_id": chunk_id,
            "source": chunk.source_label,
            "quote": quote,
        }
    verified = quote_in_source(quote, chunk.text)
    return {
        "verified": verified,
        "reason": "verified" if verified else "quote_not_found_in_source_text",
        "chunk_id": chunk_id,
        "source": chunk.source_label,
        "quote": quote,
    }


def get_document_coverage() -> dict[str, Any]:
    settings = Settings.from_env()
    pdfs_by_name = {pdf.name: pdf for pdf in sorted(settings.data_dir.glob("*.pdf"))}
    chunks = _load_chunks_or_empty(settings)
    embeddings_shape: tuple[int, ...] | None = None
    index_error: str | None = None
    try:
        _, embeddings = load_index(settings.index_dir)
        embeddings_shape = tuple(int(item) for item in embeddings.shape)
    except Exception as exc:
        index_error = str(exc)

    chunks_by_doc: dict[str, list[Chunk]] = defaultdict(list)
    for chunk in chunks:
        chunks_by_doc[chunk.doc].append(chunk)

    all_doc_names = sorted(set(pdfs_by_name) | set(chunks_by_doc))
    documents = []
    for doc_name in all_doc_names:
        doc_chunks = chunks_by_doc.get(doc_name, [])
        pages = sorted(
            {
                page
                for chunk in doc_chunks
                for page in range(chunk.start_page, chunk.end_page + 1)
            }
        )
        warnings = []
        if doc_name in pdfs_by_name and not doc_chunks:
            warnings.append("No indexed chunks. This may need OCR or the index may be stale.")
        if doc_name not in pdfs_by_name and doc_chunks:
            warnings.append("Indexed chunks exist, but the source PDF is no longer in data/.")
        documents.append(
            {
                "filename": doc_name,
                "pdf_present": doc_name in pdfs_by_name,
                "indexed_chunks": len(doc_chunks),
                "indexed_pages": pages,
                "page_start": min(pages) if pages else None,
                "page_end": max(pages) if pages else None,
                "contextualized_chunks": sum(1 for chunk in doc_chunks if chunk.context),
                "warnings": warnings,
            }
        )

    return {
        "data_dir": str(settings.data_dir),
        "index_dir": str(settings.index_dir),
        "index_error": index_error,
        "embedding_shape": embeddings_shape,
        "pdf_count": len(pdfs_by_name),
        "indexed_document_count": sum(1 for item in documents if item["indexed_chunks"]),
        "total_chunks": len(chunks),
        "documents": documents,
    }


def rebuild_index(contextualize: bool | None = None) -> dict[str, Any]:
    settings = Settings.from_env()
    result = build_index(settings, contextualize=contextualize)
    return {
        "chunk_count": result.chunk_count,
        "embedding_shape": result.embedding_shape,
        "contextualized_count": result.contextualized_count,
        "context_failure_count": result.context_failure_count,
        "catalogue_asset_count": result.catalogue_asset_count,
        "semantic_mention_count": result.semantic_mention_count,
        "graph_node_count": result.graph_node_count,
        "graph_edge_count": result.graph_edge_count,
        "index_dir": str(settings.index_dir),
    }


def export_powerpoint_outline(
    title: str,
    outline_markdown: str,
    filename: str | None = None,
) -> dict[str, Any]:
    settings = Settings.from_env()
    settings.export_dir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_export_name(filename or title)
    output_path = _unique_export_path(settings.export_dir / f"{safe_name}.md")
    content = f"# {title.strip() or 'Data Room Cited Outline'}\n\n{outline_markdown.strip()}\n"
    output_path.write_text(content, encoding="utf-8")
    try:
        chunks = _load_chunks_or_empty(settings)
        catalogue.save_catalogue(settings, catalogue.build_catalogue(settings, chunks))
    except Exception:
        pass
    return {
        "exported": True,
        "path": str(output_path),
        "title": title,
        "format": "markdown_powerpoint_outline",
        "characters": len(content),
    }


def search_catalog(query: str, limit: int = 10) -> dict[str, Any]:
    return catalogue.search_catalogue(query=query, limit=limit, settings=Settings.from_env())


def get_data_asset(asset_id: str) -> dict[str, Any]:
    return catalogue.get_data_asset(asset_id=asset_id, settings=Settings.from_env())


def get_asset_lineage(asset_id: str, depth: int = 2) -> dict[str, Any]:
    return catalogue.get_asset_lineage(asset_id=asset_id, depth=depth, settings=Settings.from_env())


def get_data_quality_status() -> dict[str, Any]:
    return catalogue.get_data_quality_status(settings=Settings.from_env())


def list_business_concepts() -> dict[str, Any]:
    return semantic.list_business_concepts(settings=Settings.from_env())


def resolve_business_term(term: str) -> dict[str, Any]:
    return semantic.resolve_business_term(term=term, settings=Settings.from_env())


def search_by_entity(entity: str, limit: int = 10) -> dict[str, Any]:
    return semantic.search_by_entity(entity=entity, limit=limit, settings=Settings.from_env())


def get_entity_evidence(concept_or_term: str, limit: int = 10) -> dict[str, Any]:
    return semantic.get_entity_evidence(
        concept_or_term=concept_or_term,
        limit=limit,
        settings=Settings.from_env(),
    )


def search_entities(query: str, entity_type: str | None = None, limit: int = 10) -> dict[str, Any]:
    return knowledge_graph.search_entities(
        query=query,
        entity_type=entity_type,
        limit=limit,
        settings=Settings.from_env(),
    )


def get_entity_relationships(entity_id_or_name: str, depth: int = 1) -> dict[str, Any]:
    return knowledge_graph.get_entity_relationships(
        entity_id_or_name=entity_id_or_name,
        depth=depth,
        settings=Settings.from_env(),
    )


def find_supporting_evidence(query: str, limit: int = 10) -> dict[str, Any]:
    return knowledge_graph.find_supporting_evidence(
        query=query,
        limit=limit,
        settings=Settings.from_env(),
    )


def find_conflicting_claims(query: str | None = None) -> dict[str, Any]:
    return knowledge_graph.find_conflicting_claims(query=query, settings=Settings.from_env())


def resolve_taxonomy_concept(term: str) -> dict[str, Any]:
    return taxonomy.resolve_taxonomy_concept(term=term, settings=Settings.from_env())


def list_broader_concepts(concept_id: str) -> dict[str, Any]:
    return taxonomy.list_broader_concepts(concept_id=concept_id, settings=Settings.from_env())


def list_related_concepts(concept_id: str) -> dict[str, Any]:
    return taxonomy.list_related_concepts(concept_id=concept_id, settings=Settings.from_env())


def validate_entity_classification(entity_or_term: str, expected_concept_id: str) -> dict[str, Any]:
    return taxonomy.validate_entity_classification(
        entity_or_term=entity_or_term,
        expected_concept_id=expected_concept_id,
        settings=Settings.from_env(),
    )


def enterprise_connector_plan() -> dict[str, Any]:
    return {
        "status": "planned_not_implemented",
        "reason": (
            "Enterprise connectors need client-approved auth, tenant configuration, "
            "data residency, and audit requirements before they should access real documents."
        ),
        "planned_connectors": [
            {
                "name": "SharePoint",
                "purpose": "Pull approved diligence documents from client or firm workspaces.",
            },
            {
                "name": "Box",
                "purpose": "Sync data-room files from managed deal folders.",
            },
            {
                "name": "CRM",
                "purpose": "Attach verified diligence outputs to client/project records.",
            },
        ],
        "data_management_extension_points": [
            "metadata catalogue",
            "semantic layer",
            "knowledge graph",
            "SKOS/RDF taxonomy resolution",
            "MCP tool boundary",
        ],
    }


def _load_chunks_or_empty(settings: Settings) -> list[Chunk]:
    try:
        chunks, _ = load_index(settings.index_dir)
    except Exception:
        return []
    return chunks


def _chunk_by_id(chunk_id: str) -> Chunk | None:
    settings = Settings.from_env()
    chunks = _load_chunks_or_empty(settings)
    return next((chunk for chunk in chunks if chunk.chunk_id == chunk_id), None)


def _lexical_search(query: str, chunks: list[Chunk], top_k: int) -> list[tuple[Chunk, float]]:
    query_terms = _terms(query)
    if not query_terms:
        return []
    query_counts = Counter(query_terms)
    scored: list[tuple[int, Chunk, float]] = []
    for index, chunk in enumerate(chunks):
        chunk_terms = Counter(_terms(f"{chunk.source_label} {chunk.text}"))
        score = sum(min(count, chunk_terms.get(term, 0)) for term, count in query_counts.items())
        if score:
            scored.append((index, chunk, float(score)))
    scored.sort(key=lambda item: (-item[2], item[0]))
    return [(chunk, score) for _, chunk, score in scored[:top_k]]


def _terms(text: str) -> list[str]:
    return re.findall(r"[a-z0-9$%]+", text.lower())


def _chunk_payload(
    chunk: Chunk,
    *,
    score: float | None = None,
    include_text: bool = False,
    include_context: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "chunk_id": chunk.chunk_id,
        "doc": chunk.doc,
        "page": chunk.page,
        "page_start": chunk.start_page,
        "page_end": chunk.end_page,
        "section_title": chunk.section_title,
        "source": chunk.source_label,
    }
    if score is not None:
        payload["score"] = score
    if include_text:
        payload["text"] = _truncate(chunk.text, MAX_CHUNK_TEXT_CHARS)
    else:
        payload["text_preview"] = _truncate(chunk.text, 300)
    if include_context:
        payload["context"] = chunk.context
    return payload


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _clamp_top_k(top_k: int) -> int:
    return min(max(1, int(top_k)), MAX_SEARCH_TOP_K)


def _safe_export_name(name: str) -> str:
    base = Path(name).stem
    slug = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip(" .-_")
    if not slug:
        slug = "data-room-outline"
    return slug[:80]


def _unique_export_path(path: Path) -> Path:
    if not path.exists():
        return path
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return path.with_name(f"{path.stem}_{timestamp}{path.suffix}")
