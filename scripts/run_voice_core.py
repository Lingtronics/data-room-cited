"""Start only the synthetic read-only RAG profile on loopback."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if __name__ == "__main__":
    from src import voice_fixture
    import uvicorn

    if not voice_fixture.enabled():
        raise SystemExit("Set VOICE_FEATURE_ENABLED=true for the voice-only launcher.")
    if os.getenv("RAG_CORE_HOST", "127.0.0.1") != "127.0.0.1":
        raise SystemExit("Voice RAG core must bind to 127.0.0.1.")
    voice_fixture.configured_snapshot()
    uvicorn.run("app:app", app_dir=str(voice_fixture.ROOT / "services" / "rag-core"),
                host="127.0.0.1", port=int(os.getenv("RAG_CORE_PORT", "8767")),
                access_log=False)
