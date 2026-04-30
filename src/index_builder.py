from __future__ import annotations

import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from src.config import Settings
from src.documents import load_pdf_chunks
from src.embeddings import embed_texts
from src.index_store import save_index
from src.llm import contextualize_chunk, create_chat_provider


LOGGER = logging.getLogger(__name__)
ProgressCallback = Callable[[str], None]


@dataclass(frozen=True)
class BuildIndexResult:
    chunk_count: int
    embedding_shape: tuple[int, ...]
    contextualized_count: int
    context_failure_count: int


def build_index(
    settings: Settings,
    *,
    contextualize: bool | None = None,
    progress: ProgressCallback | None = None,
) -> BuildIndexResult:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    _notify(progress, "Chunking PDFs...")
    chunks = load_pdf_chunks(
        settings.data_dir,
        chunk_chars=settings.chunk_target_chars,
        chunk_overlap=settings.chunk_overlap_chars,
    )

    contextualize = (
        settings.contextual_retrieval_enabled
        if contextualize is None
        else contextualize
    )
    contextualized_count = 0
    context_failure_count = 0

    if contextualize and chunks:
        provider = create_chat_provider(settings)

        def generate_context(chunk_index: int) -> tuple[int, str, bool]:
            chunk = chunks[chunk_index]
            try:
                context = contextualize_chunk(
                    provider,
                    settings,
                    document_name=chunk.doc,
                    chunk_text=chunk.text,
                )
            except Exception as exc:
                LOGGER.warning(
                    "Context generation failed for %s; using vanilla embedding for this chunk. Error: %s",
                    chunk.chunk_id,
                    exc,
                )
                return chunk_index, "", False
            return chunk_index, context.strip(), True

        with ThreadPoolExecutor(max_workers=settings.context_generation_workers) as executor:
            for chunk_index, context, success in executor.map(generate_context, range(len(chunks))):
                chunk = chunks[chunk_index]
                chunk.context = context
                if success and context:
                    contextualized_count += 1
                elif not success:
                    context_failure_count += 1
                index = chunk_index + 1
                _notify(progress, f"Contextualized {index}/{len(chunks)} chunks...")

    _notify(progress, "Embedding chunks...")
    embeddings = embed_texts([chunk.text_for_embedding for chunk in chunks])
    _notify(progress, "Saving index...")
    save_index(settings.index_dir, chunks, embeddings)
    _notify(progress, f"Indexed {len(chunks)} chunks.")
    return BuildIndexResult(
        chunk_count=len(chunks),
        embedding_shape=tuple(int(dim) for dim in embeddings.shape),
        contextualized_count=contextualized_count,
        context_failure_count=context_failure_count,
    )


def _notify(progress: ProgressCallback | None, message: str) -> None:
    if progress is not None:
        progress(message)
