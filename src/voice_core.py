"""Read-only HTTP profile around existing Python retrieval and verification."""
from __future__ import annotations

import json
import uuid
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from src import mcp_tools, voice_fixture
from src.telemetry import span


def install_voice_profile(app: FastAPI) -> None:
    if not voice_fixture.enabled():
        return
    # Synchronous import/startup check: a broken fixture never starts serving.
    voice_fixture.configured_snapshot()

    @app.middleware("http")
    async def voice_boundary(request: Request, call_next):
        correlation_id = str(uuid.uuid4())

        def fail(code: str, status: int = 403):
            return JSONResponse({"ok": False, "correlation_id": correlation_id,
                                 "error": {"code": code, "message": "Voice fixture request denied."}},
                                status_code=status)

        if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
            return fail("local_only")
        if request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return fail("local_only")
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).hostname not in {"127.0.0.1", "localhost", "::1"}:
            return fail("local_only")
        try:
            snapshot = voice_fixture.configured_snapshot()
        except (ValueError, OSError):
            return fail("invalid_voice_fixture", 503)
        if request.method == "GET" and request.url.path == "/health":
            return JSONResponse({"ok": True, "correlation_id": correlation_id, "data": {
                "status": "ok", "voice_fixture": voice_fixture.fingerprint(),
                "workspace_id": voice_fixture.WORKSPACE, "read_only": True,
            }})
        allowed_routes = {"/retrieval/search": "documents:read", "/citations/verify": "citations:verify"}
        scope = allowed_routes.get(request.url.path)
        if request.method != "POST" or scope is None:
            return fail("voice_route_denied")
        scopes = set(request.headers.get("x-auth-scopes", "").split(","))
        docs = set(request.headers.get("x-allowed-document-ids", "").split(","))
        if (request.headers.get("x-workspace-id") != voice_fixture.WORKSPACE
                or not docs or not docs.issubset(set(voice_fixture.manifest()["documents"]))
                or scope not in scopes or not scopes.issubset(voice_fixture.READ_SCOPES)):
            return fail("voice_access_denied")
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 16_384:
                return fail("invalid_voice_input", 413)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError()
            chunks = {c["chunk_id"]: c for c in json.loads(snapshot["index/chunks.json"])}
            if request.url.path == "/retrieval/search":
                if (set(payload) - {"query", "top_k", "semantic"}
                        or not _text(payload.get("query"), 2_000)
                        or type(payload.get("top_k", 5)) is not int
                        or not 1 <= payload.get("top_k", 5) <= 5
                        or payload.get("semantic", False) is not False):
                    raise ValueError()

                def execute():
                    data = mcp_tools.search_data_room(payload["query"], top_k=payload.get("top_k", 5), semantic=False)
                    data["results"] = [
                        {**{key: value for key, value in r.items()
                            if key not in {"page", "page_start", "page_end", "source"}}, "page_label": None}
                        for r in data["results"] if r["doc"] in docs
                    ]
                    return data
            else:
                if (set(payload) != {"chunk_id", "quote"}
                        or not _text(payload.get("chunk_id"), 200)
                        or not _text(payload.get("quote"), 5_000)):
                    raise ValueError()
                chunk = chunks.get(payload["chunk_id"])
                if chunk is None or chunk["doc"] not in docs:
                    return fail("forbidden_document")

                def execute():
                    data = mcp_tools.verify_citation(payload["chunk_id"], payload["quote"])
                    data.pop("source", None)
                    # Only trusted metadata; text fixtures have sections, no PDF page labels.
                    if data.get("verified") is True:
                        data.update(document=chunk["doc"], page_label=None,
                                    section_title=chunk["section_title"])
                    return data
        except (ValueError, TypeError):
            return fail("invalid_voice_input", 400)
        with span("voice.core.read", {"tool.type": scope, "correlation_id": correlation_id}):
            try:
                data = await run_in_threadpool(execute)
            except Exception:
                return fail("voice_core_failed", 503)
        return JSONResponse({"ok": True, "correlation_id": correlation_id, "data": data})


def _text(value: object, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit
