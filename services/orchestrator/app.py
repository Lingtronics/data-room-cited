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
) -> dict[str, Any]:
    correlation_id = x_correlation_id or str(uuid.uuid4())
    response.headers["x-correlation-id"] = correlation_id
    with span("agent.route", {"correlation_id": correlation_id, "entrypoint": "orchestrator"}):
        result = answer_with_diligence_supervisor(
            request.question,
            Settings.from_env(),
            force_multi_agent=request.force_multi_agent,
            allow_export=request.allow_export,
        )
    return {"ok": True, "correlation_id": correlation_id, "data": result.model_dump(mode="json")}
