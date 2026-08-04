from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi.testclient import TestClient


def test_orchestrator_derives_export_approval_from_authenticated_context(monkeypatch) -> None:
    module = _load_orchestrator_module()
    captured: dict[str, Any] = {}

    class DummyResult:
        def model_dump(self, mode: str = "json") -> dict[str, Any]:
            return {"allow_export_seen": captured["allow_export"]}

    def fake_supervisor(
        question: str,
        settings: object,
        *,
        force_multi_agent: bool,
        allow_export: bool,
    ) -> DummyResult:
        captured["question"] = question
        captured["force_multi_agent"] = force_multi_agent
        captured["allow_export"] = allow_export
        return DummyResult()

    monkeypatch.setattr(module, "answer_with_diligence_supervisor", fake_supervisor)
    monkeypatch.setattr(module.Settings, "from_env", classmethod(lambda cls: object()))

    client = TestClient(module.app)

    no_approval = client.post(
        "/ask",
        json={
            "question": "Prepare and export a slide deck.",
            "force_multi_agent": True,
            "allow_export": True,
        },
    )
    assert no_approval.status_code == 200
    assert captured["allow_export"] is False

    approved = client.post(
        "/ask",
        json={
            "question": "Prepare and export a slide deck.",
            "force_multi_agent": True,
            "allow_export": True,
        },
        headers={
            "x-auth-scopes": "documents:read exports:write",
            "x-approval-grants": "export_powerpoint_outline",
            "x-workspace-id": "deal-alpha",
            "x-user-id": "consultant-1",
        },
    )
    assert approved.status_code == 200
    assert captured["allow_export"] is True


def _load_orchestrator_module() -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "services" / "orchestrator" / "app.py"
    spec = importlib.util.spec_from_file_location("orchestrator_app_under_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load orchestrator module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
