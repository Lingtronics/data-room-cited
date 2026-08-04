from __future__ import annotations

import logging
import re

from src.config import Settings
from src.embeddings import embed_one
from src.index_store import load_index, retrieve
from src.llm import RerankCandidate, answer_question, create_chat_provider, listwise_rerank
from src.schemas import Chunk


LOGGER = logging.getLogger(__name__)


BROAD_QUESTION_PATTERNS = [
    r"\bsummary\b",
    r"\bsummarize\b",
    r"\boverview\b",
    r"\bexecutive summary\b",
    r"\bpresentation\b",
    r"\bpowerpoint\b",
    r"\bslide\b",
    r"\bdeck\b",
    r"\breadout\b",
    r"\bimportant things\b",
    r"\bmost important\b",
    r"\bbefore diving\b",
    r"\bmissing\b",
    r"\bunclear\b",
    r"\bgaps?\b",
    r"\bdon't cover\b",
    r"\bdoes not cover\b",
    r"\bnot covered\b",
    r"\brisks?\b",
    r"\bred flags?\b",
    r"\binconsisten",
    r"\bcontradict",
    r"\bconflict",
]


def answer_from_index(question: str, settings: Settings | None = None) -> str:
    settings = settings or Settings.from_env()
    provider = create_chat_provider(settings)
    chunks, embeddings = load_index(settings.index_dir)

    if is_broad_question(question):
        LOGGER.info("Using whole-corpus context for broad question.")
        selected = [_candidate_from_chunk(chunk) for chunk in chunks]
    else:
        query_embedding = embed_one(question)
        initial = retrieve(
            query_embedding=query_embedding,
            chunks=chunks,
            embeddings=embeddings,
            top_k=max(settings.top_k_initial, settings.top_k),
        )
        candidates = [_candidate_from_chunk(chunk, score=score) for chunk, score in initial]
        selected = _rerank_or_fallback(provider, settings, question, candidates)

    source_label_by_chunk_id = {candidate.id: candidate.source or "Unknown source" for candidate in selected}
    source_text_by_chunk_id = {candidate.id: candidate.text for candidate in selected}
    context_blocks = [
        f"[chunk_id: {candidate.id} | source: {candidate.source}]\n{candidate.text}" for candidate in selected
    ]
    return answer_question(
        provider,
        settings,
        question=question,
        context_blocks=context_blocks,
        source_text_by_chunk_id=source_text_by_chunk_id,
        source_label_by_chunk_id=source_label_by_chunk_id,
    )


def _rerank_or_fallback(
    provider,
    settings: Settings,
    question: str,
    candidates: list[RerankCandidate],
) -> list[RerankCandidate]:
    cosine_top_k = candidates[: settings.top_k]
    if not settings.rerank_enabled:
        return cosine_top_k
    try:
        return listwise_rerank(
            provider,
            settings,
            query=question,
            candidates=candidates,
            top_k=settings.top_k,
        )
    except Exception as exc:
        LOGGER.warning("Reranking failed; falling back to cosine top-k. Error: %s", exc)
        return cosine_top_k


def _candidate_from_chunk(chunk: Chunk, *, score: float | None = None) -> RerankCandidate:
    return RerankCandidate(
        id=chunk.id,
        text=chunk.text,
        source=chunk.source_label,
        score=score,
        metadata={
            "document": chunk.doc,
            "page_start": chunk.start_page,
            "page_end": chunk.end_page,
            "section_title": chunk.section_title,
        },
    )


def is_broad_question(question: str) -> bool:
    normalized = question.lower()
    return any(re.search(pattern, normalized) for pattern in BROAD_QUESTION_PATTERNS)


def _is_broad_question(question: str) -> bool:
    return is_broad_question(question)
