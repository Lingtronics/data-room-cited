from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from src.config import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID


_MODEL: Any | None = None


def _get_model() -> Any:
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer

        try:
            _MODEL = SentenceTransformer(EMBEDDING_MODEL_ID, local_files_only=True)
        except Exception:
            _MODEL = SentenceTransformer(EMBEDDING_MODEL_ID)
    return _MODEL


def embed_texts(texts: Sequence[str]) -> np.ndarray:
    if len(texts) == 0:
        return np.empty((0, EMBEDDING_DIMENSIONS), dtype=np.float32)

    model = _get_model()
    vectors = model.encode(
        list(texts),
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.shape != (len(texts), EMBEDDING_DIMENSIONS):
        raise ValueError(
            f"Embedding shape mismatch for {EMBEDDING_MODEL_ID}: "
            f"expected {(len(texts), EMBEDDING_DIMENSIONS)}, got {vectors.shape}"
        )
    return vectors


def embed_one(text: str) -> np.ndarray:
    return embed_texts([text])[0]
