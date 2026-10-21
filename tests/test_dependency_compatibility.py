"""Credential-free compatibility checks for the security dependency updates."""
from __future__ import annotations

import asyncio
from pathlib import Path

from streamlit.testing.v1 import AppTest

from src.config import Settings
from src.voice_fixture import prepare

ROOT = Path(__file__).resolve().parents[1]


def test_streamlit_renders_synthetic_index_without_credentials(tmp_path, monkeypatch):
    fixture = tmp_path / "synthetic"
    prepare(fixture)
    settings = Settings(
        deepseek_api_key=None,
        data_dir=fixture / "data",
        index_dir=fixture / "index",
    )
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    monkeypatch.setenv("VOICE_FEATURE_ENABLED", "false")
    app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=15).run()
    assert not app.exception
    assert app.title[0].value == "Data Room Cited"
    assert any("3 chunks / 3 vectors" in item.value for item in app.sidebar.caption)
    app.text_input[0].set_value("What are the synthetic contract risks?").run()
    assert not app.exception
    assert next(button for button in app.button if button.label == "Ask").disabled
    assert next(button for button in app.sidebar.button if button.label == "Rebuild index").disabled
    assert any("DEEPSEEK_API_KEY" in item.value for item in app.warning)


def test_python_mcp_sdk_preserves_registered_citation_contract(monkeypatch, capsys):
    from scripts import mcp_server

    tools = asyncio.run(mcp_server.mcp.list_tools())
    citation = next(tool for tool in tools if tool.name == "verify_citation")
    assert set(citation.inputSchema["required"]) == {"chunk_id", "quote"}
    expected = {"verified": True, "chunk_id": "synthetic-compatibility"}
    calls = []

    def verify(**kwargs):
        calls.append(kwargs)
        print("synthetic diagnostic must not reach stdio transport")
        return expected

    monkeypatch.setattr(mcp_server.mcp_tools, "verify_citation", verify)
    result = asyncio.run(mcp_server.mcp.call_tool(
        "verify_citation", {"chunk_id": "synthetic-compatibility", "quote": "Synthetic only."}
    ))
    assert calls == [{"chunk_id": "synthetic-compatibility", "quote": "Synthetic only."}]
    assert result[1] == expected
    captured = capsys.readouterr()
    assert "synthetic diagnostic" not in captured.out + captured.err
