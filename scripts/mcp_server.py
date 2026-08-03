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
        "verifying citations, reporting coverage, rebuilding the index, and exporting outlines."
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
