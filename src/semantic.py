from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from src.config import Settings
from src.index_store import load_index
from src.schemas import Chunk


ConceptType = Literal["entity", "metric", "risk", "contract", "date", "governance"]


class BusinessConcept(BaseModel):
    concept_id: str = Field(description="Stable canonical concept identifier.")
    name: str = Field(description="Human-readable canonical business concept name.")
    concept_type: ConceptType = Field(description="Kind of business concept.")
    description: str = Field(description="Business definition of the concept.")
    preferred_terms: list[str] = Field(description="Preferred terms used for display and matching.")
    synonyms: list[str] = Field(default_factory=list, description="Alternative source terms mapped to this concept.")
    examples: list[str] = Field(default_factory=list, description="Example source phrases.")

    @property
    def all_terms(self) -> list[str]:
        seen = set()
        terms = []
        for term in [*self.preferred_terms, *self.synonyms]:
            normalized = _normalize_term(term)
            if normalized and normalized not in seen:
                seen.add(normalized)
                terms.append(term)
        return terms


class ConceptMention(BaseModel):
    concept_id: str = Field(description="Canonical concept that was matched.")
    concept_name: str = Field(description="Display name of the canonical concept.")
    matched_term: str = Field(description="Source term that triggered the match.")
    chunk_id: str = Field(description="Source chunk containing the matched term.")
    doc: str = Field(description="Source document filename.")
    page_start: int = Field(description="First source page.")
    page_end: int = Field(description="Last source page.")
    section_title: str | None = Field(default=None, description="Nearest section title.")
    quote: str = Field(description="Short source-text quote around the matched term.")


class SemanticIndex(BaseModel):
    generated_at: str = Field(description="UTC timestamp when the semantic index was generated.")
    concepts: list[BusinessConcept] = Field(description="Canonical business concepts.")
    mentions: list[ConceptMention] = Field(description="Concept mentions grounded in source chunks.")


def load_concept_definitions(settings: Settings | None = None) -> list[BusinessConcept]:
    settings = settings or Settings.from_env()
    if not settings.semantic_definitions_path.exists():
        return []
    data = json.loads(settings.semantic_definitions_path.read_text(encoding="utf-8"))
    return [BusinessConcept.model_validate(item) for item in data]


def build_semantic_index(settings: Settings, chunks: list[Chunk]) -> SemanticIndex:
    concepts = load_concept_definitions(settings)
    mentions: list[ConceptMention] = []
    for chunk in chunks:
        for concept in concepts:
            for term in concept.all_terms:
                if _term_in_text(term, chunk.text):
                    mentions.append(
                        ConceptMention(
                            concept_id=concept.concept_id,
                            concept_name=concept.name,
                            matched_term=term,
                            chunk_id=chunk.chunk_id,
                            doc=chunk.doc,
                            page_start=chunk.start_page,
                            page_end=chunk.end_page,
                            section_title=chunk.section_title,
                            quote=_quote_around(chunk.text, term),
                        )
                    )
                    break
    return SemanticIndex(generated_at=_utc_now(), concepts=concepts, mentions=mentions)


def save_semantic_index(settings: Settings, semantic_index: SemanticIndex) -> None:
    settings.semantic_index_path.parent.mkdir(parents=True, exist_ok=True)
    settings.semantic_index_path.write_text(
        json.dumps(semantic_index.model_dump(mode="json"), indent=2),
        encoding="utf-8",
    )


def load_semantic_index(settings: Settings | None = None) -> SemanticIndex:
    settings = settings or Settings.from_env()
    if not settings.semantic_index_path.exists():
        chunks, _ = load_index(settings.index_dir)
        semantic_index = build_semantic_index(settings, chunks)
        save_semantic_index(settings, semantic_index)
        return semantic_index
    data = json.loads(settings.semantic_index_path.read_text(encoding="utf-8"))
    return SemanticIndex.model_validate(data)


def list_business_concepts(settings: Settings | None = None) -> dict:
    semantic_index = load_semantic_index(settings)
    mention_counts = {}
    for mention in semantic_index.mentions:
        mention_counts[mention.concept_id] = mention_counts.get(mention.concept_id, 0) + 1
    return {
        "concepts": [
            {
                **concept.model_dump(mode="json"),
                "mention_count": mention_counts.get(concept.concept_id, 0),
            }
            for concept in semantic_index.concepts
        ]
    }


def resolve_business_term(term: str, settings: Settings | None = None) -> dict:
    semantic_index = load_semantic_index(settings)
    normalized_query = _normalize_term(term)
    matches = []
    for concept in semantic_index.concepts:
        for candidate in concept.all_terms:
            normalized_candidate = _normalize_term(candidate)
            if (
                normalized_query == normalized_candidate
                or normalized_query in normalized_candidate
                or normalized_candidate in normalized_query
            ):
                matches.append(
                    {
                        "concept_id": concept.concept_id,
                        "name": concept.name,
                        "concept_type": concept.concept_type,
                        "matched_term": candidate,
                        "description": concept.description,
                    }
                )
                break
    return {"term": term, "matches": matches}


def search_by_entity(entity: str, limit: int = 10, settings: Settings | None = None) -> dict:
    semantic_index = load_semantic_index(settings)
    terms = _terms(entity)
    scored = []
    for index, mention in enumerate(semantic_index.mentions):
        haystack = f"{mention.concept_name} {mention.matched_term} {mention.doc} {mention.section_title or ''} {mention.quote}".lower()
        score = sum(1 for term in terms if term in haystack)
        if score:
            scored.append((-score, index, mention))
    scored.sort()
    return {
        "query": entity,
        "matches": [_mention_payload(mention) for _, _, mention in scored[: max(1, limit)]],
    }


def get_entity_evidence(concept_or_term: str, limit: int = 10, settings: Settings | None = None) -> dict:
    semantic_index = load_semantic_index(settings)
    resolved_ids = {
        match["concept_id"] for match in resolve_business_term(concept_or_term, settings)["matches"]
    }
    if any(concept.concept_id == concept_or_term for concept in semantic_index.concepts):
        resolved_ids.add(concept_or_term)
    mentions = [mention for mention in semantic_index.mentions if mention.concept_id in resolved_ids]
    return {
        "query": concept_or_term,
        "concept_ids": sorted(resolved_ids),
        "evidence": [_mention_payload(mention) for mention in mentions[: max(1, limit)]],
    }


def _mention_payload(mention: ConceptMention) -> dict:
    return {
        "concept_id": mention.concept_id,
        "concept_name": mention.concept_name,
        "matched_term": mention.matched_term,
        "chunk_id": mention.chunk_id,
        "source": _source_label(mention),
        "quote": mention.quote,
    }


def _source_label(mention: ConceptMention) -> str:
    pages = (
        f"p.{mention.page_start}"
        if mention.page_start == mention.page_end
        else f"pp.{mention.page_start}-{mention.page_end}"
    )
    if mention.section_title:
        return f"{mention.doc} {pages}, {mention.section_title}"
    return f"{mention.doc} {pages}"


def _term_in_text(term: str, text: str) -> bool:
    escaped = re.escape(term.strip())
    if not escaped:
        return False
    return re.search(rf"(?<!\w){escaped}(?!\w)", text, flags=re.IGNORECASE) is not None


def _quote_around(text: str, term: str, limit: int = 260) -> str:
    match = re.search(re.escape(term), text, flags=re.IGNORECASE)
    if not match:
        return text[:limit].strip()
    sentence_start = text.rfind(".", 0, match.start())
    paragraph_start = text.rfind("\n", 0, match.start())
    start = max(sentence_start + 1, paragraph_start + 1, 0)
    sentence_end = text.find(".", match.end())
    paragraph_end = text.find("\n", match.end())
    end_candidates = [item for item in [sentence_end, paragraph_end] if item != -1]
    end = min(end_candidates) + 1 if end_candidates else min(len(text), match.end() + limit // 2)
    quote = re.sub(r"\s+", " ", text[start:end]).strip()
    if len(quote) <= limit:
        return quote
    return quote[: limit - 3].strip() + "..."


def _normalize_term(term: str) -> str:
    return re.sub(r"\s+", " ", term.strip().lower())


def _terms(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
