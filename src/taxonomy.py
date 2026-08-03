from __future__ import annotations

import re
from functools import lru_cache

from pydantic import BaseModel, Field

from src.config import Settings


class TaxonomyConcept(BaseModel):
    concept_id: str = Field(description="Controlled vocabulary concept identifier.")
    uri: str = Field(description="SKOS/RDF URI or compact URI.")
    pref_label: str = Field(description="Preferred controlled-vocabulary label.")
    alt_labels: list[str] = Field(default_factory=list, description="Alternative labels.")
    broader: list[str] = Field(default_factory=list, description="Broader concept identifiers.")
    related: list[str] = Field(default_factory=list, description="Related concept identifiers.")


class TaxonomyStore(BaseModel):
    concepts: list[TaxonomyConcept] = Field(description="Imported SKOS-like taxonomy concepts.")


def load_taxonomy(settings: Settings | None = None) -> TaxonomyStore:
    settings = settings or Settings.from_env()
    return _load_taxonomy_cached(str(settings.taxonomy_path))


@lru_cache(maxsize=4)
def _load_taxonomy_cached(path: str) -> TaxonomyStore:
    text = Settings.from_env().taxonomy_path.read_text(encoding="utf-8") if not path else _read(path)
    concepts = _parse_skos_turtle(text)
    return TaxonomyStore(concepts=concepts)


def resolve_taxonomy_concept(term: str, settings: Settings | None = None) -> dict:
    taxonomy = load_taxonomy(settings)
    normalized = _normalize(term)
    matches = []
    for concept in taxonomy.concepts:
        labels = [concept.pref_label, *concept.alt_labels]
        for label in labels:
            normalized_label = _normalize(label)
            if normalized == normalized_label or normalized in normalized_label or normalized_label in normalized:
                matches.append(concept.model_dump(mode="json"))
                break
    return {"term": term, "matches": matches}


def list_broader_concepts(concept_id: str, settings: Settings | None = None) -> dict:
    taxonomy = load_taxonomy(settings)
    by_id = {concept.concept_id: concept for concept in taxonomy.concepts}
    concept = _resolve_concept(concept_id, taxonomy)
    if concept is None:
        return {"found": False, "concept_id": concept_id, "broader": []}
    broader = [by_id[item].model_dump(mode="json") for item in concept.broader if item in by_id]
    return {"found": True, "concept_id": concept.concept_id, "broader": broader}


def list_related_concepts(concept_id: str, settings: Settings | None = None) -> dict:
    taxonomy = load_taxonomy(settings)
    by_id = {concept.concept_id: concept for concept in taxonomy.concepts}
    concept = _resolve_concept(concept_id, taxonomy)
    if concept is None:
        return {"found": False, "concept_id": concept_id, "related": []}
    related = [by_id[item].model_dump(mode="json") for item in concept.related if item in by_id]
    return {"found": True, "concept_id": concept.concept_id, "related": related}


def validate_entity_classification(
    entity_or_term: str,
    expected_concept_id: str,
    settings: Settings | None = None,
) -> dict:
    taxonomy = load_taxonomy(settings)
    matches = resolve_taxonomy_concept(entity_or_term, settings)["matches"]
    expected = _resolve_concept(expected_concept_id, taxonomy)
    if expected is None:
        return {
            "valid": False,
            "reason": "unknown_expected_concept",
            "entity_or_term": entity_or_term,
            "expected_concept_id": expected_concept_id,
        }
    matched_ids = {match["concept_id"] for match in matches}
    valid = expected.concept_id in matched_ids or any(
        _is_descendant_of(match_id, expected.concept_id, taxonomy) for match_id in matched_ids
    )
    return {
        "valid": valid,
        "entity_or_term": entity_or_term,
        "expected_concept_id": expected.concept_id,
        "matches": matches,
        "reason": "matched_expected_or_child" if valid else "no_matching_taxonomy_concept",
    }


def _parse_skos_turtle(text: str) -> list[TaxonomyConcept]:
    concepts: list[TaxonomyConcept] = []
    for block in re.split(r"\s*\.\s*(?=<|$)", text, flags=re.MULTILINE):
        subject_match = re.search(r"<([^>]+)>", block)
        if not subject_match or "skos:Concept" not in block:
            continue
        uri = subject_match.group(1)
        concept_id = _concept_id_from_uri(uri)
        pref_label = _first_label(block, "prefLabel") or concept_id.replace("_", " ")
        alt_labels = _labels(block, "altLabel")
        broader = [_concept_id_from_uri(item) for item in re.findall(r"skos:broader\s+<([^>]+)>", block)]
        related = [_concept_id_from_uri(item) for item in re.findall(r"skos:related\s+<([^>]+)>", block)]
        concepts.append(
            TaxonomyConcept(
                concept_id=concept_id,
                uri=uri,
                pref_label=pref_label,
                alt_labels=alt_labels,
                broader=broader,
                related=related,
            )
        )
    concepts.sort(key=lambda item: item.concept_id)
    return concepts


def _resolve_concept(concept_id_or_label: str, taxonomy: TaxonomyStore) -> TaxonomyConcept | None:
    normalized = _normalize(concept_id_or_label)
    for concept in taxonomy.concepts:
        labels = [concept.concept_id, concept.pref_label, *concept.alt_labels]
        if normalized in {_normalize(label) for label in labels}:
            return concept
    return None


def _is_descendant_of(child_id: str, parent_id: str, taxonomy: TaxonomyStore) -> bool:
    by_id = {concept.concept_id: concept for concept in taxonomy.concepts}
    queue = list(by_id.get(child_id, TaxonomyConcept(concept_id="", uri="", pref_label="")).broader)
    visited = set()
    while queue:
        current = queue.pop(0)
        if current == parent_id:
            return True
        if current in visited or current not in by_id:
            continue
        visited.add(current)
        queue.extend(by_id[current].broader)
    return False


def _labels(block: str, property_name: str) -> list[str]:
    return re.findall(rf"skos:{property_name}\s+\"([^\"]+)\"", block)


def _first_label(block: str, property_name: str) -> str | None:
    labels = _labels(block, property_name)
    return labels[0] if labels else None


def _concept_id_from_uri(uri: str) -> str:
    tail = re.split(r"[/#:]", uri.rstrip("/#"))[-1]
    return re.sub(r"[^A-Za-z0-9_]+", "_", tail).strip("_")


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()
