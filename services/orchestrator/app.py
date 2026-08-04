from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Response
from pydantic import BaseModel, Field

sys.path.append(str(Path(__file__).resolve().parents[2]))

from src.config import Settings
from src.diligence_agents import answer_with_diligence_supervisor
from src.telemetry import setup_telemetry, span


class AskRequest(BaseModel):
    question: str = Field(min_length=1)
    force_multi_agent: bool = False
    allow_export: bool = False


app = FastAPI(
    title="Data Room Cited Orchestrator",
    version="1.0.0",
    description="HTTP wrapper for deterministic and multi-agent diligence workflows.",
)
setup_telemetry("data-room-cited.orchestrator")


@app.get("/health")
def health(x_correlation_id: str | None = Header(default=None)) -> dict[str, Any]:
    return {"ok": True, "correlation_id": x_correlation_id or str(uuid.uuid4())}


@app.post("/ask")
def ask(
    request: AskRequest,
    response: Response,
    x_correlation_id: str | None = Header(default=None),
    x_workspace_id: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
    x_auth_scopes: str | None = Header(default=None),
    x_approval_grants: str | None = Header(default=None),
) -> dict[str, Any]:
    correlation_id = x_correlation_id or str(uuid.uuid4())
    scopes = _split_header(x_auth_scopes)
    approval_grants = _split_header(x_approval_grants)
    allow_export = request.allow_export and _has_export_approval(scopes, approval_grants)
    response.headers["x-correlation-id"] = correlation_id
    with span(
        "agent.route",
        {
            "correlation_id": correlation_id,
            "entrypoint": "orchestrator",
            "workspace_id": x_workspace_id or "local",
            "user_id": x_user_id or "anonymous",
            "export_requested": request.allow_export,
            "export_approved": allow_export,
        },
    ):
        result = answer_with_diligence_supervisor(
            request.question,
            Settings.from_env(),
            force_multi_agent=request.force_multi_agent,
            allow_export=allow_export,
        )
    return {"ok": True, "correlation_id": correlation_id, "data": result.model_dump(mode="json")}


def _has_export_approval(scopes: list[str], approval_grants: list[str]) -> bool:
    has_scope = "exports:write" in scopes or "admin:connectors" in scopes
    has_approval = "export_powerpoint_outline" in approval_grants or "*" in approval_grants
    return has_scope and has_approval


def _split_header(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.replace(" ", ",").split(",") if item.strip()]
