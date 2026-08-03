from __future__ import annotations

from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
import io
import sys
from pathlib import Path
from typing import Any

sys.path.append(str(Path(__file__).resolve().parents[1]))

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:
    raise SystemExit(
        "The MCP Python SDK is not installed. Run: .\\.venv\\Scripts\\pip.exe install -r requirements.txt"
    ) from exc

from src import mcp_tools


def _stdio_safe(fn: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any) -> dict[str, Any]:
    sink = io.StringIO()
    with redirect_stdout(sink), redirect_stderr(sink):
        return fn(*args, **kwargs)


mcp = FastMCP(
    "data-room-cited",
    instructions=(
        "MCP tools for searching a local diligence data room, inspecting chunks, "
        "verifying citations, reporting coverage, rebuilding the index, exporting outlines, "
        "and inspecting catalogue, semantic, graph, and taxonomy metadata."
    ),
)


@mcp.tool()
def list_documents() -> dict[str, Any]:
    """List PDFs in data/ and whether each has indexed chunks."""
    return _stdio_safe(mcp_tools.list_documents)


@mcp.tool()
def search_data_room(
    query: str,
    top_k: int | None = None,
    semantic: bool = True,
) -> dict[str, Any]:
    """Search the local data-room index and return relevant source chunks."""
    return _stdio_safe(mcp_tools.search_data_room, query=query, top_k=top_k, semantic=semantic)


@mcp.tool()
def get_chunk(chunk_id: str) -> dict[str, Any]:
    """Open one indexed source chunk by chunk_id."""
    return _stdio_safe(mcp_tools.get_chunk, chunk_id=chunk_id)


@mcp.tool()
def verify_citation(chunk_id: str, quote: str) -> dict[str, Any]:
    """Verify that quote appears in the original source text for chunk_id."""
    return _stdio_safe(mcp_tools.verify_citation, chunk_id=chunk_id, quote=quote)


@mcp.tool()
def get_document_coverage() -> dict[str, Any]:
    """Report indexed coverage by document, including missing or OCR-needed PDFs."""
    return _stdio_safe(mcp_tools.get_document_coverage)


@mcp.tool()
def search_catalog(query: str, limit: int = 10) -> dict[str, Any]:
    """Search the local metadata catalogue by title, domain, classification, status, or chunk ID."""
    return _stdio_safe(mcp_tools.search_catalog, query=query, limit=limit)


@mcp.tool()
def get_data_asset(asset_id: str) -> dict[str, Any]:
    """Get one catalogue asset by asset_id."""
    return _stdio_safe(mcp_tools.get_data_asset, asset_id=asset_id)


@mcp.tool()
def get_asset_lineage(asset_id: str, depth: int = 2) -> dict[str, Any]:
    """Trace upstream and downstream lineage for a catalogue asset."""
    return _stdio_safe(mcp_tools.get_asset_lineage, asset_id=asset_id, depth=depth)


@mcp.tool()
def get_data_quality_status() -> dict[str, Any]:
    """Summarize catalogue quality status, including OCR and stale-source warnings."""
    return _stdio_safe(mcp_tools.get_data_quality_status)


@mcp.tool()
def list_business_concepts() -> dict[str, Any]:
    """List canonical diligence concepts and their source mention counts."""
    return _stdio_safe(mcp_tools.list_business_concepts)


@mcp.tool()
def resolve_business_term(term: str) -> dict[str, Any]:
    """Resolve a source term to canonical business concepts."""
    return _stdio_safe(mcp_tools.resolve_business_term, term=term)


@mcp.tool()
def search_by_entity(entity: str, limit: int = 10) -> dict[str, Any]:
    """Search semantic mentions by entity, term, source document, or quote text."""
    return _stdio_safe(mcp_tools.search_by_entity, entity=entity, limit=limit)


@mcp.tool()
def get_entity_evidence(concept_or_term: str, limit: int = 10) -> dict[str, Any]:
    """Return source evidence for a canonical concept or business term."""
    return _stdio_safe(mcp_tools.get_entity_evidence, concept_or_term=concept_or_term, limit=limit)


@mcp.tool()
def search_entities(query: str, entity_type: str | None = None, limit: int = 10) -> dict[str, Any]:
    """Search graph entities, concepts, and claims."""
    return _stdio_safe(
        mcp_tools.search_entities,
        query=query,
        entity_type=entity_type,
        limit=limit,
    )


@mcp.tool()
def get_entity_relationships(entity_id_or_name: str, depth: int = 1) -> dict[str, Any]:
    """Get graph relationships around an entity, concept, chunk, document, or claim."""
    return _stdio_safe(
        mcp_tools.get_entity_relationships,
        entity_id_or_name=entity_id_or_name,
        depth=depth,
    )


@mcp.tool()
def find_supporting_evidence(query: str, limit: int = 10) -> dict[str, Any]:
    """Find graph claim nodes and source provenance that support a topic."""
    return _stdio_safe(mcp_tools.find_supporting_evidence, query=query, limit=limit)


@mcp.tool()
def find_conflicting_claims(query: str | None = None) -> dict[str, Any]:
    """Find heuristic candidate conflicts among extracted claim nodes."""
    return _stdio_safe(mcp_tools.find_conflicting_claims, query=query)


@mcp.tool()
def resolve_taxonomy_concept(term: str) -> dict[str, Any]:
    """Resolve a term against the imported SKOS/RDF taxonomy."""
    return _stdio_safe(mcp_tools.resolve_taxonomy_concept, term=term)


@mcp.tool()
def list_broader_concepts(concept_id: str) -> dict[str, Any]:
    """List broader SKOS taxonomy concepts."""
    return _stdio_safe(mcp_tools.list_broader_concepts, concept_id=concept_id)


@mcp.tool()
def list_related_concepts(concept_id: str) -> dict[str, Any]:
    """List related SKOS taxonomy concepts."""
    return _stdio_safe(mcp_tools.list_related_concepts, concept_id=concept_id)


@mcp.tool()
def validate_entity_classification(entity_or_term: str, expected_concept_id: str) -> dict[str, Any]:
    """Validate whether a term resolves to an expected taxonomy concept or descendant."""
    return _stdio_safe(
        mcp_tools.validate_entity_classification,
        entity_or_term=entity_or_term,
        expected_concept_id=expected_concept_id,
    )


@mcp.tool()
def rebuild_index(contextualize: bool | None = None) -> dict[str, Any]:
    """Rebuild the local chunks and embeddings index from data/*.pdf."""
    return _stdio_safe(mcp_tools.rebuild_index, contextualize=contextualize)


@mcp.tool()
def export_powerpoint_outline(
    title: str,
    outline_markdown: str,
    filename: str | None = None,
) -> dict[str, Any]:
    """Export a Markdown PowerPoint outline with citations to exports/."""
    return _stdio_safe(
        mcp_tools.export_powerpoint_outline,
        title=title,
        outline_markdown=outline_markdown,
        filename=filename,
    )


@mcp.tool()
def enterprise_connector_plan() -> dict[str, Any]:
    """Describe planned SharePoint, Box, and CRM connector architecture."""
    return _stdio_safe(mcp_tools.enterprise_connector_plan)


if __name__ == "__main__":
    mcp.run()
