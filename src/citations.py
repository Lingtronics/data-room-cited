from __future__ import annotations

import re

from src.schemas import Citation


def normalize_for_quote_match(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def quote_in_source(quote: str, source_text: str) -> bool:
    normalized_quote = normalize_for_quote_match(quote)
    if not normalized_quote:
        return False
    return normalized_quote in normalize_for_quote_match(source_text)


def split_verified_citations(
    citations: list[Citation],
    source_text_by_chunk_id: dict[str, str],
) -> tuple[list[Citation], list[Citation]]:
    verified: list[Citation] = []
    unverified: list[Citation] = []
    for citation in citations:
        source_text = source_text_by_chunk_id.get(citation.chunk_id, "")
        if quote_in_source(citation.quote, source_text):
            verified.append(citation)
        else:
            unverified.append(citation)
    return verified, unverified
