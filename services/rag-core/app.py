from __future__ import annotations

import json
import sys
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Generic, TypeVar

from fastapi import FastAPI, Header, Query, Request, Response
from opentelemetry.trace import SpanKind
from pydantic import BaseModel, Field

sys.path.append(str(Path(__file__).resolve().parents[2]))

from src import mcp_tools
from src.document_sources import AccessContext
from src.telemetry import setup_telemetry, span


T = TypeVar("T")


class SuccessEnvelope(BaseModel, Generic[T]):
    ok: bool = Field(default=True)
    correlation_id: str
    data: T


class ErrorEnvelope(BaseModel):
    ok: bool = Field(default=False)
    correlation_id: str
    error: dict[str, str]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int | None = Field(default=None, ge=1, le=50)
    semantic: bool = True


class VerifyCitationRequest(BaseModel):
    chunk_id: str = Field(min_length=1)
    quote: str = Field(min_length=1)


class RebuildIndexRequest(BaseModel):
    contextualize: bool | None = None


class ExportOutlineRequest(BaseModel):
    title: str = Field(min_length=1)
    outline_markdown: str = Field(min_length=1)
    filename: str | None = None


class SyncDocumentSourceRequest(BaseModel):
    rebuild: bool = False
    contextualize: bool | None = None


app = FastAPI(
    title="Data Room Cited RAG Core",
    version="1.0.0",
    description="Internal HTTP wrapper around the trusted Python data-room evidence functions.",
)
setup_telemetry("data-room-cited.rag-core")


@app.middleware("http")
async def telemetry_middleware(request: Request, call_next):
    with span(
        "rag_core.http.request",
        {
            "http.request.method": request.method,
            "url.path": request.url.path,
            "correlation_id": request.headers.get("x-correlation-id"),
        },
        kind=SpanKind.SERVER,
        context_headers=dict(request.headers),
    ):
        return await call_next(request)


@app.get("/health")
def health(x_correlation_id: str | None = Header(default=None)) -> SuccessEnvelope[dict[str, str]]:
    return _ok({"status": "ok"}, x_correlation_id)


@app.post("/retrieval/search")
def search_data_room(
    request: SearchRequest,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.search_data_room(
            query=request.query,
            top_k=request.top_k,
            semantic=request.semantic,
        ),
    )


@app.get("/chunks/{chunk_id}")
def get_chunk(
    chunk_id: str,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(response, x_correlation_id, lambda: mcp_tools.get_chunk(chunk_id=chunk_id))


@app.post("/citations/verify")
def verify_citation(
    request: VerifyCitationRequest,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.verify_citation(chunk_id=request.chunk_id, quote=request.quote),
    )


@app.get("/documents/coverage")
def get_document_coverage(
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(response, x_correlation_id, mcp_tools.get_document_coverage)


@app.get("/documents/{document_id}")
def get_document(
    document_id: str,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    asset_id = document_id if document_id.startswith("document:") else f"document:{document_id}"
    return _call(response, x_correlation_id, lambda: mcp_tools.get_data_asset(asset_id=asset_id))


@app.get("/catalogue/search")
def search_catalogue(
    response: Response,
    query: str = Query(min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(response, x_correlation_id, lambda: mcp_tools.search_catalog(query=query, limit=limit))


@app.get("/catalogue/assets/{asset_id:path}/lineage")
def get_asset_lineage(
    asset_id: str,
    response: Response,
    depth: int = Query(default=2, ge=1, le=5),
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.get_asset_lineage(asset_id=asset_id, depth=depth),
    )


@app.get("/catalogue/assets/{asset_id:path}")
def get_data_asset(
    asset_id: str,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(response, x_correlation_id, lambda: mcp_tools.get_data_asset(asset_id=asset_id))


@app.get("/connectors/documents")
def list_document_source_documents(
    request: Request,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.list_document_source_documents(_access_context_from_headers(request)),
    )


@app.post("/connectors/sync")
def sync_configured_document_source(
    request: SyncDocumentSourceRequest,
    http_request: Request,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.sync_configured_document_source(
            rebuild=request.rebuild,
            contextualize=request.contextualize,
            access_context=_access_context_from_headers(http_request),
        ),
    )


@app.get("/graph/evidence")
def find_supporting_evidence(
    response: Response,
    query: str = Query(min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.find_supporting_evidence(query=query, limit=limit),
    )


@app.get("/graph/entities")
def search_entities(
    response: Response,
    query: str = Query(min_length=1),
    entity_type: str | None = None,
    limit: int = Query(default=10, ge=1, le=50),
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.search_entities(query=query, entity_type=entity_type, limit=limit),
    )


@app.post("/index/rebuild")
def rebuild_index(
    request: RebuildIndexRequest,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.rebuild_index(contextualize=request.contextualize),
    )


@app.post("/exports/outlines")
def export_powerpoint_outline(
    request: ExportOutlineRequest,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    return _call(
        response,
        x_correlation_id,
        lambda: mcp_tools.export_powerpoint_outline(
            title=request.title,
            outline_markdown=request.outline_markdown,
            filename=request.filename,
        ),
    )


@app.get("/evals/latest")
def get_latest_evals(
    response: Response,
    x_correlation_id: str | None = Header(default=None),
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    def read_evals() -> dict[str, Any]:
        path = Path(__file__).resolve().parents[2] / "evals" / "data_management_cases.json"
        return {
            "name": "data_management_cases",
            "path": str(path),
            "cases": json.loads(path.read_text(encoding="utf-8")),
        }

    return _call(response, x_correlation_id, read_evals)


def _call(
    response: Response,
    correlation_id: str | None,
    fn: Callable[[], dict[str, Any]],
) -> SuccessEnvelope[dict[str, Any]] | ErrorEnvelope:
    request_id = correlation_id or str(uuid.uuid4())
    response.headers["x-correlation-id"] = request_id
    try:
        return _ok(fn(), request_id)
    except Exception as exc:
        response.status_code = 500
        return ErrorEnvelope(
            correlation_id=request_id,
            error={
                "code": exc.__class__.__name__,
                "message": str(exc),
            },
        )


def _ok(data: dict[str, Any], correlation_id: str | None) -> SuccessEnvelope[dict[str, Any]]:
    return SuccessEnvelope(correlation_id=correlation_id or str(uuid.uuid4()), data=data)


def _access_context_from_headers(request: Request) -> AccessContext:
    return AccessContext(
        workspace_id=request.headers.get("x-workspace-id", "local"),
        user_id=request.headers.get("x-user-id", "internal-service"),
        role=request.headers.get("x-user-role", "reader"),
        scopes=_split_header(request.headers.get("x-auth-scopes")),
        allowed_document_ids=_split_header(request.headers.get("x-allowed-document-ids")),
    )


def _split_header(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


# Opt-in boundary runs before ordinary routes/telemetry and leaves them unchanged
# when voice is disabled. It reuses mcp_tools rather than adding retrieval logic.
from src.voice_core import install_voice_profile

install_voice_profile(app)
