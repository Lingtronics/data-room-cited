from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field


PROJECT_ROOT = Path(__file__).resolve().parents[1]

load_dotenv(PROJECT_ROOT / ".env")


def _path_from_env(name: str, default: str) -> Path:
    value = Path(os.getenv(name, default))
    if not value.is_absolute():
        value = PROJECT_ROOT / value
    return value


def _int_from_env(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _bool_from_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


LLM_PROVIDER = os.getenv("LLM_PROVIDER", "deepseek")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY") or None
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
LLM_MODEL_ID = os.getenv("LLM_MODEL_ID", "deepseek-chat")
CONTEXT_MODEL_ID = os.getenv("CONTEXT_MODEL_ID", "deepseek-chat")
RERANK_MODEL_ID = os.getenv("RERANK_MODEL_ID", "deepseek-chat")
ANSWER_MAX_TOKENS = _int_from_env("ANSWER_MAX_TOKENS", 5000)

EMBEDDING_MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "BAAI/bge-small-en-v1.5")
EMBEDDING_DIMENSIONS = _int_from_env("EMBEDDING_DIMENSIONS", 384)

DATA_DIR = _path_from_env("DATA_DIR", "data")
INDEX_DIR = _path_from_env("INDEX_DIR", "index")
EXPORT_DIR = _path_from_env("EXPORT_DIR", "exports")
CHUNKS_PATH = INDEX_DIR / "chunks.json"
EMBEDDINGS_PATH = INDEX_DIR / "embeddings.npy"

TOP_K = _int_from_env("TOP_K", 6)
TOP_K_INITIAL = _int_from_env("TOP_K_INITIAL", max(TOP_K * 3, TOP_K))
CHUNK_TARGET_CHARS = _int_from_env("CHUNK_TARGET_CHARS", _int_from_env("CHUNK_CHARS", 1800))
CHUNK_OVERLAP_CHARS = _int_from_env("CHUNK_OVERLAP_CHARS", _int_from_env("CHUNK_OVERLAP", 250))

RERANK_ENABLED = _bool_from_env("RERANK_ENABLED", True)
CONTEXTUAL_RETRIEVAL_ENABLED = _bool_from_env("CONTEXTUAL_RETRIEVAL_ENABLED", False)
CONTEXT_GENERATION_WORKERS = _int_from_env("CONTEXT_GENERATION_WORKERS", 4)
AGENT_MAX_TOOL_TURNS = _int_from_env("AGENT_MAX_TOOL_TURNS", 6)

INDEX_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseModel):
    llm_provider: str = Field(default=LLM_PROVIDER)
    deepseek_api_key: str | None = Field(default=DEEPSEEK_API_KEY)
    llm_base_url: str = Field(default=LLM_BASE_URL)
    llm_model_id: str = Field(default=LLM_MODEL_ID)
    context_model_id: str = Field(default=CONTEXT_MODEL_ID)
    rerank_model_id: str = Field(default=RERANK_MODEL_ID)
    answer_max_tokens: int = Field(default=ANSWER_MAX_TOKENS, ge=500)
    embedding_model_id: str = Field(default=EMBEDDING_MODEL_ID)
    embedding_dimensions: int = Field(default=EMBEDDING_DIMENSIONS)
    data_dir: Path = Field(default=DATA_DIR)
    index_dir: Path = Field(default=INDEX_DIR)
    export_dir: Path = Field(default=EXPORT_DIR)
    chunks_path: Path = Field(default=CHUNKS_PATH)
    embeddings_path: Path = Field(default=EMBEDDINGS_PATH)
    top_k: int = Field(default=TOP_K, ge=1)
    top_k_initial: int = Field(default=TOP_K_INITIAL, ge=1)
    chunk_target_chars: int = Field(default=CHUNK_TARGET_CHARS, ge=200)
    chunk_overlap_chars: int = Field(default=CHUNK_OVERLAP_CHARS, ge=0)
    rerank_enabled: bool = Field(default=RERANK_ENABLED)
    contextual_retrieval_enabled: bool = Field(default=CONTEXTUAL_RETRIEVAL_ENABLED)
    context_generation_workers: int = Field(default=CONTEXT_GENERATION_WORKERS, ge=1)
    agent_max_tool_turns: int = Field(default=AGENT_MAX_TOOL_TURNS, ge=1)

    @classmethod
    def from_env(cls, env_file: str | Path = PROJECT_ROOT / ".env") -> "Settings":
        load_dotenv(env_file)
        index_dir = _path_from_env("INDEX_DIR", "index")
        export_dir = _path_from_env("EXPORT_DIR", "exports")
        index_dir.mkdir(parents=True, exist_ok=True)
        export_dir.mkdir(parents=True, exist_ok=True)
        chunk_target_chars = _int_from_env(
            "CHUNK_TARGET_CHARS", _int_from_env("CHUNK_CHARS", CHUNK_TARGET_CHARS)
        )
        chunk_overlap_chars = _int_from_env(
            "CHUNK_OVERLAP_CHARS", _int_from_env("CHUNK_OVERLAP", CHUNK_OVERLAP_CHARS)
        )
        return cls(
            llm_provider=os.getenv("LLM_PROVIDER", LLM_PROVIDER),
            deepseek_api_key=os.getenv("DEEPSEEK_API_KEY") or None,
            llm_base_url=os.getenv("LLM_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL", LLM_BASE_URL),
            llm_model_id=os.getenv("LLM_MODEL_ID", LLM_MODEL_ID),
            context_model_id=os.getenv("CONTEXT_MODEL_ID", CONTEXT_MODEL_ID),
            rerank_model_id=os.getenv("RERANK_MODEL_ID", RERANK_MODEL_ID),
            answer_max_tokens=_int_from_env("ANSWER_MAX_TOKENS", ANSWER_MAX_TOKENS),
            embedding_model_id=os.getenv("EMBEDDING_MODEL_ID", EMBEDDING_MODEL_ID),
            embedding_dimensions=_int_from_env("EMBEDDING_DIMENSIONS", EMBEDDING_DIMENSIONS),
            data_dir=_path_from_env("DATA_DIR", "data"),
            index_dir=index_dir,
            export_dir=export_dir,
            chunks_path=index_dir / CHUNKS_PATH.name,
            embeddings_path=index_dir / EMBEDDINGS_PATH.name,
            top_k=_int_from_env("TOP_K", TOP_K),
            top_k_initial=_int_from_env("TOP_K_INITIAL", TOP_K_INITIAL),
            chunk_target_chars=chunk_target_chars,
            chunk_overlap_chars=chunk_overlap_chars,
            rerank_enabled=_bool_from_env("RERANK_ENABLED", RERANK_ENABLED),
            contextual_retrieval_enabled=_bool_from_env(
                "CONTEXTUAL_RETRIEVAL_ENABLED", CONTEXTUAL_RETRIEVAL_ENABLED
            ),
            context_generation_workers=_int_from_env(
                "CONTEXT_GENERATION_WORKERS", CONTEXT_GENERATION_WORKERS
            ),
            agent_max_tool_turns=_int_from_env("AGENT_MAX_TOOL_TURNS", AGENT_MAX_TOOL_TURNS),
        )

    @property
    def deepseek_base_url(self) -> str:
        return self.llm_base_url

    @property
    def chunk_chars(self) -> int:
        return self.chunk_target_chars

    @property
    def chunk_overlap(self) -> int:
        return self.chunk_overlap_chars

    def require_deepseek_api_key(self) -> str:
        if not self.deepseek_api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not set. Add it to .env or the shell environment.")
        return self.deepseek_api_key
