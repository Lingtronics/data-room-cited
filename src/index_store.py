from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from src.config import CHUNKS_PATH, EMBEDDINGS_PATH
from src.schemas import Chunk


def save_index(index_dir: Path, chunks: list[Chunk], embeddings: np.ndarray) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / CHUNKS_PATH.name).write_text(
        json.dumps([chunk.model_dump() for chunk in chunks], indent=2),
        encoding="utf-8",
    )
    np.save(index_dir / EMBEDDINGS_PATH.name, embeddings)


def load_index(index_dir: Path) -> tuple[list[Chunk], np.ndarray]:
    chunks_path = index_dir / CHUNKS_PATH.name
    embeddings_path = index_dir / EMBEDDINGS_PATH.name
    if not chunks_path.exists() or not embeddings_path.exists():
        raise FileNotFoundError(
            f"Index not found in {index_dir}. Run scripts/build_index.py first."
        )
    chunks = [_chunk_from_json(item) for item in json.loads(chunks_path.read_text(encoding="utf-8"))]
    embeddings = np.load(embeddings_path)
    _validate_index_lengths(chunks, embeddings)
    return chunks, embeddings


def _chunk_from_json(item: dict) -> Chunk:
    if "chunk_id" in item:
        return Chunk(**item)
    return Chunk(
        chunk_id=item["id"],
        doc=item["document"],
        page=item["page_start"],
        page_start=item.get("page_start"),
        page_end=item.get("page_end"),
        section_title=item.get("section_title"),
        text=item["text"],
        context=item.get("context"),
    )


def retrieve(
    *,
    query_embedding: np.ndarray,
    chunks: list[Chunk],
    embeddings: np.ndarray,
    top_k: int,
) -> list[tuple[Chunk, float]]:
    _validate_index_lengths(chunks, embeddings)
    if embeddings.size == 0 or not chunks:
        return []
    scores = embeddings @ query_embedding
    top_indices = np.argsort(scores)[::-1][:top_k]
    return [(chunks[int(index)], float(scores[int(index)])) for index in top_indices]


def _validate_index_lengths(chunks: list[Chunk], embeddings: np.ndarray) -> None:
    if len(chunks) != embeddings.shape[0]:
        raise ValueError(
            "Index length mismatch: "
            f"chunks.json has {len(chunks)} chunks, but embeddings.npy has {embeddings.shape[0]} rows."
        )
