from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal

import networkx as nx
from pydantic import BaseModel, Field

from src.config import Settings
from src.index_store import load_index
from src.schemas import Chunk
from src.semantic import ConceptMention, SemanticIndex, load_semantic_index


NodeType = Literal["document", "chunk", "company", "concept", "counterparty", "person", "competitor", "regulation", "claim"]


class Provenance(BaseModel):
    doc: str | None = Field(default=None, description="Source document filename.")
    page_start: int | None = Field(default=None, description="First source page.")
    page_end: int | None = Field(default=None, description="Last source page.")
    chunk_id: str | None = Field(default=None, description="Source chunk identifier.")
    quote: str | None = Field(default=None, description="Evidence quote from source text.")


class GraphNode(BaseModel):
    node_id: str = Field(description="Stable graph node identifier.")
    node_type: NodeType = Field(description="Type of graph node.")
    label: str = Field(description="Human-readable graph label.")
    provenance: list[Provenance] = Field(default_factory=list, description="Source provenance.")
    properties: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    source: str = Field(description="Source node identifier.")
    target: str = Field(description="Target node identifier.")
    relationship: str = Field(description="Relationship type.")
    provenance: list[Provenance] = Field(default_factory=list, description="Evidence for the relationship.")
    properties: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class KnowledgeGraphSnapshot(BaseModel):
    generated_at: str = Field(description="UTC timestamp when the graph snapshot was generated.")
    nodes: list[GraphNode] = Field(description="Graph nodes with provenance.")
    edges: list[GraphEdge] = Field(description="Graph relationships with provenance.")


KNOWN_ENTITIES = {
    "Meridian Analytics": "company",
    "Folium Stores plc": "counterparty",
    "Ardent Foods Group": "counterparty",
    "Northwell Pharmacy": "counterparty",
    "Crestmere Living": "counterparty",
    "Bowery & Sons Bakery": "counterparty",
    "Halden Group": "counterparty",
    "Pemberton Stores": "counterparty",
    "Lyra Beauty Co": "counterparty",
    "Marchmont Wines": "counterparty",
    "Eldridge Optical": "counterparty",
    "James Holloway": "person",
    "Priya Raghavan": "person",
    "Daniel Whitfield": "person",
    "Sarah Okonkwo": "person",
    "Marcus Chen": "person",
    "Helena Vasquez": "person",
    "Tom Bradbury": "person",
    "Bluecore": "competitor",
    "Daisy Intelligence": "competitor",
    "Particl": "competitor",
    "Salesforce Data Cloud": "competitor",
    "UK GDPR": "regulation",
    "EU Digital Markets Act": "regulation",
}


RELATIONSHIP_BY_ENTITY_TYPE = {
    "counterparty": "HAS_COUNTERPARTY",
    "person": "HAS_MANAGEMENT_PERSON",
    "competitor": "COMPETES_WITH",
    "regulation": "SUBJECT_TO_REGULATION",
}


def build_knowledge_graph(
    settings: Settings,
    chunks: list[Chunk],
    semantic_index: SemanticIndex | None = None,
) -> KnowledgeGraphSnapshot:
    semantic_index = semantic_index or load_semantic_index(settings)
    graph = nx.MultiDiGraph()
    company_id = _entity_id("company", "Meridian Analytics")
    _add_node(graph, company_id, node_type="company", label="Meridian Analytics")

    for chunk in chunks:
        document_id = _document_id(chunk.doc)
        chunk_id = _chunk_id(chunk.chunk_id)
        provenance = _provenance_from_chunk(chunk)
        _add_node(graph, document_id, node_type="document", label=chunk.doc, provenance=[provenance])
        _add_node(graph, chunk_id, node_type="chunk", label=chunk.chunk_id, provenance=[provenance])
        _add_edge(graph, document_id, chunk_id, "HAS_CHUNK", provenance=[provenance])
        _extract_known_entities(graph, company_id, chunk)
        _extract_claims(graph, company_id, chunk)

    for concept in semantic_index.concepts:
        concept_id = _concept_id(concept.concept_id)
        _add_node(
            graph,
            concept_id,
            node_type="concept",
            label=concept.name,
            properties={"concept_type": concept.concept_type},
        )

    for mention in semantic_index.mentions:
        _add_semantic_mention(graph, company_id, mention)

    return _snapshot_from_graph(graph)


def save_knowledge_graph(settings: Settings, snapshot: KnowledgeGraphSnapshot) -> None:
    settings.knowledge_graph_path.parent.mkdir(parents=True, exist_ok=True)
    settings.knowledge_graph_path.write_text(
        json.dumps(snapshot.model_dump(mode="json"), indent=2),
        encoding="utf-8",
    )


def load_knowledge_graph(settings: Settings | None = None) -> KnowledgeGraphSnapshot:
    settings = settings or Settings.from_env()
    if not settings.knowledge_graph_path.exists():
        chunks, _ = load_index(settings.index_dir)
        semantic_index = load_semantic_index(settings)
        snapshot = build_knowledge_graph(settings, chunks, semantic_index)
        save_knowledge_graph(settings, snapshot)
        return snapshot
    data = json.loads(settings.knowledge_graph_path.read_text(encoding="utf-8"))
    return KnowledgeGraphSnapshot.model_validate(data)


def search_entities(query: str, entity_type: str | None = None, limit: int = 10, settings: Settings | None = None) -> dict:
    snapshot = load_knowledge_graph(settings)
    terms = _terms(query)
    matches = []
    for index, node in enumerate(snapshot.nodes):
        if entity_type and node.node_type != entity_type:
            continue
        if node.node_type not in {"company", "counterparty", "person", "competitor", "regulation", "concept", "claim"}:
            continue
        haystack = f"{node.node_id} {node.label} {' '.join(str(value) for value in node.properties.values())}".lower()
        score = sum(1 for term in terms if term in haystack)
        if score:
            priority = 0 if node.node_type != "claim" else 1
            matches.append((-score, priority, node.label, index, node))
    matches.sort()
    return {"query": query, "matches": [_node_payload(node) for _, _, _, _, node in matches[: max(1, limit)]]}


def get_entity_relationships(entity_id_or_name: str, depth: int = 1, settings: Settings | None = None) -> dict:
    snapshot = load_knowledge_graph(settings)
    graph = _graph_from_snapshot(snapshot)
    node_id = _resolve_node_id(entity_id_or_name, snapshot)
    if node_id is None:
        return {"found": False, "query": entity_id_or_name, "relationships": []}

    visited = {node_id}
    frontier = [(node_id, 0)]
    relationships = []
    while frontier:
        current, current_depth = frontier.pop(0)
        if current_depth >= max(1, depth):
            continue
        for _, target, data in graph.out_edges(current, data=True):
            relationships.append(_edge_payload(current, target, data, snapshot))
            if target not in visited:
                visited.add(target)
                frontier.append((target, current_depth + 1))
        for source, _, data in graph.in_edges(current, data=True):
            relationships.append(_edge_payload(source, current, data, snapshot))
            if source not in visited:
                visited.add(source)
                frontier.append((source, current_depth + 1))
    return {"found": True, "entity_id": node_id, "relationships": relationships}


def find_supporting_evidence(query: str, limit: int = 10, settings: Settings | None = None) -> dict:
    snapshot = load_knowledge_graph(settings)
    terms = _terms(query)
    matches = []
    for index, node in enumerate(snapshot.nodes):
        if node.node_type != "claim":
            continue
        haystack = f"{node.label} {' '.join(str(value) for value in node.properties.values())}".lower()
        score = sum(1 for term in terms if term in haystack)
        if score:
            matches.append((-score, node.label, index, node))
    matches.sort()
    return {
        "query": query,
        "evidence": [_node_payload(node) for _, _, _, node in matches[: max(1, limit)]],
    }


def find_conflicting_claims(query: str | None = None, settings: Settings | None = None) -> dict:
    snapshot = load_knowledge_graph(settings)
    claims = [node for node in snapshot.nodes if node.node_type == "claim"]
    if query:
        query_terms = _terms(query)
        claims = [
            node
            for node in claims
            if any(term in f"{node.label} {' '.join(str(v) for v in node.properties.values())}".lower() for term in query_terms)
        ]
    by_subject: dict[str, list[GraphNode]] = defaultdict(list)
    for claim in claims:
        subject = str(claim.properties.get("subject") or "Meridian Analytics")
        by_subject[subject].append(claim)

    conflicts = []
    for subject, subject_claims in by_subject.items():
        positive = [claim for claim in subject_claims if claim.properties.get("polarity") == "positive"]
        negative = [claim for claim in subject_claims if claim.properties.get("polarity") == "negative"]
        for left in positive:
            for right in negative:
                conflicts.append(
                    {
                        "subject": subject,
                        "claim_a": _node_payload(left),
                        "claim_b": _node_payload(right),
                        "status": "candidate_not_adjudicated",
                    }
                )
    return {
        "query": query,
        "conflicts": conflicts,
        "note": "These are heuristic conflict candidates; a production version would use claim normalization and human review.",
    }


def _extract_known_entities(graph: nx.MultiDiGraph, company_id: str, chunk: Chunk) -> None:
    for label, entity_type in KNOWN_ENTITIES.items():
        if re.search(re.escape(label), chunk.text, flags=re.IGNORECASE):
            node_id = _entity_id(entity_type, label)
            provenance = _provenance_from_chunk(chunk, quote=_quote_around(chunk.text, label))
            _add_node(graph, node_id, node_type=entity_type, label=label, provenance=[provenance])
            _add_edge(graph, _chunk_id(chunk.chunk_id), node_id, "MENTIONS_ENTITY", provenance=[provenance])
            if entity_type != "company":
                _add_edge(
                    graph,
                    company_id,
                    node_id,
                    RELATIONSHIP_BY_ENTITY_TYPE.get(entity_type, "RELATED_TO"),
                    provenance=[provenance],
                )


def _extract_claims(graph: nx.MultiDiGraph, company_id: str, chunk: Chunk) -> None:
    for sentence in _sentences(chunk.text):
        if not _looks_like_claim(sentence):
            continue
        claim_id = f"claim:{hashlib.sha1(f'{chunk.chunk_id}:{sentence}'.encode('utf-8')).hexdigest()[:12]}"
        provenance = _provenance_from_chunk(chunk, quote=sentence)
        polarity = _claim_polarity(sentence)
        _add_node(
            graph,
            claim_id,
            node_type="claim",
            label=sentence[:180],
            provenance=[provenance],
            properties={
                "subject": _claim_subject(sentence),
                "polarity": polarity,
            },
        )
        _add_edge(graph, claim_id, _chunk_id(chunk.chunk_id), "SUPPORTED_BY", provenance=[provenance])
        relationship = "HAS_RISK" if polarity == "negative" else "REPORTS"
        _add_edge(graph, company_id, claim_id, relationship, provenance=[provenance])


def _add_semantic_mention(graph: nx.MultiDiGraph, company_id: str, mention: ConceptMention) -> None:
    concept_id = _concept_id(mention.concept_id)
    chunk_id = _chunk_id(mention.chunk_id)
    provenance = Provenance(
        doc=mention.doc,
        page_start=mention.page_start,
        page_end=mention.page_end,
        chunk_id=mention.chunk_id,
        quote=mention.quote,
    )
    _add_edge(graph, chunk_id, concept_id, "MENTIONS_CONCEPT", provenance=[provenance])
    relationship = {
        "contract": "HAS_CONTRACT_EVIDENCE",
        "revenue": "REPORTS_REVENUE_EVIDENCE",
        "risk": "HAS_RISK_EVIDENCE",
        "obligation": "HAS_OBLIGATION_EVIDENCE",
    }.get(mention.concept_id, "HAS_CONCEPT_EVIDENCE")
    _add_edge(graph, company_id, concept_id, relationship, provenance=[provenance])


def _add_node(
    graph: nx.MultiDiGraph,
    node_id: str,
    *,
    node_type: NodeType,
    label: str,
    provenance: list[Provenance] | None = None,
    properties: dict[str, str | int | float | bool | None] | None = None,
) -> None:
    existing = graph.nodes.get(node_id, {})
    existing_provenance = list(existing.get("provenance", []))
    for item in provenance or []:
        dumped = item.model_dump(mode="json")
        if dumped not in existing_provenance:
            existing_provenance.append(dumped)
    graph.add_node(
        node_id,
        node_type=node_type,
        label=label,
        provenance=existing_provenance,
        properties={**existing.get("properties", {}), **(properties or {})},
    )


def _add_edge(
    graph: nx.MultiDiGraph,
    source: str,
    target: str,
    relationship: str,
    *,
    provenance: list[Provenance] | None = None,
    properties: dict[str, str | int | float | bool | None] | None = None,
) -> None:
    graph.add_edge(
        source,
        target,
        relationship=relationship,
        provenance=[item.model_dump(mode="json") for item in provenance or []],
        properties=properties or {},
    )


def _snapshot_from_graph(graph: nx.MultiDiGraph) -> KnowledgeGraphSnapshot:
    nodes = [
        GraphNode(
            node_id=node_id,
            node_type=data["node_type"],
            label=data["label"],
            provenance=[Provenance.model_validate(item) for item in data.get("provenance", [])],
            properties=data.get("properties", {}),
        )
        for node_id, data in graph.nodes(data=True)
    ]
    edges = [
        GraphEdge(
            source=source,
            target=target,
            relationship=data["relationship"],
            provenance=[Provenance.model_validate(item) for item in data.get("provenance", [])],
            properties=data.get("properties", {}),
        )
        for source, target, data in graph.edges(data=True)
    ]
    nodes.sort(key=lambda node: node.node_id)
    edges.sort(key=lambda edge: (edge.source, edge.relationship, edge.target))
    return KnowledgeGraphSnapshot(generated_at=_utc_now(), nodes=nodes, edges=edges)


def _graph_from_snapshot(snapshot: KnowledgeGraphSnapshot) -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    for node in snapshot.nodes:
        graph.add_node(node.node_id, **node.model_dump(mode="json"))
    for edge in snapshot.edges:
        graph.add_edge(edge.source, edge.target, **edge.model_dump(mode="json"))
    return graph


def _resolve_node_id(query: str, snapshot: KnowledgeGraphSnapshot) -> str | None:
    normalized = _normalize(query)
    for node in snapshot.nodes:
        if normalized in {_normalize(node.node_id), _normalize(node.label)}:
            return node.node_id
    for node in snapshot.nodes:
        if normalized in _normalize(node.label) or normalized in _normalize(node.node_id):
            return node.node_id
    return None


def _node_payload(node: GraphNode) -> dict:
    return {
        "node_id": node.node_id,
        "node_type": node.node_type,
        "label": node.label,
        "properties": node.properties,
        "provenance": [item.model_dump(mode="json") for item in node.provenance[:5]],
    }


def _edge_payload(source: str, target: str, data: dict, snapshot: KnowledgeGraphSnapshot) -> dict:
    node_labels = {node.node_id: node.label for node in snapshot.nodes}
    return {
        "source": source,
        "source_label": node_labels.get(source, source),
        "relationship": data.get("relationship"),
        "target": target,
        "target_label": node_labels.get(target, target),
        "provenance": data.get("provenance", [])[:5],
    }


def _document_id(doc: str) -> str:
    return f"document:{_slug(doc)}"


def _chunk_id(chunk_id: str) -> str:
    return f"chunk:{chunk_id}"


def _concept_id(concept_id: str) -> str:
    return f"concept:{concept_id}"


def _entity_id(entity_type: str, label: str) -> str:
    return f"{entity_type}:{_slug(label)}"


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()


def _provenance_from_chunk(chunk: Chunk, quote: str | None = None) -> Provenance:
    return Provenance(
        doc=chunk.doc,
        page_start=chunk.start_page,
        page_end=chunk.end_page,
        chunk_id=chunk.chunk_id,
        quote=quote,
    )


def _sentences(text: str) -> list[str]:
    candidates = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text))
    return [candidate.strip() for candidate in candidates if 40 <= len(candidate.strip()) <= 350]


def _looks_like_claim(sentence: str) -> bool:
    lowered = sentence.lower()
    if re.search(r"\b\d+(?:\.\d+)?%|\b[£$]\s?\d|\b\d{4}\b", sentence):
        return True
    return any(
        term in lowered
        for term in [
            "risk",
            "headwind",
            "vacant",
            "departure",
            "account for",
            "contract",
            "arr",
            "revenue",
            "customer",
            "compet",
        ]
    )


def _claim_polarity(sentence: str) -> str:
    lowered = sentence.lower()
    if any(term in lowered for term in ["risk", "headwind", "vacant", "departure", "pressure", "weaken", "opt-out"]):
        return "negative"
    if any(term in lowered for term in ["growth", "strong", "core", "favourable", "capture"]):
        return "positive"
    return "neutral"


def _claim_subject(sentence: str) -> str:
    for label in KNOWN_ENTITIES:
        if re.search(re.escape(label), sentence, flags=re.IGNORECASE):
            return label
    return "Meridian Analytics"


def _quote_around(text: str, term: str, limit: int = 260) -> str:
    match = re.search(re.escape(term), text, flags=re.IGNORECASE)
    if not match:
        return text[:limit].strip()
    start = max(0, text.rfind(".", 0, match.start()) + 1)
    end = text.find(".", match.end())
    if end == -1:
        end = min(len(text), match.end() + limit // 2)
    quote = re.sub(r"\s+", " ", text[start : end + 1]).strip()
    if len(quote) <= limit:
        return quote
    return quote[: limit - 3].strip() + "..."


def _terms(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
