from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src import knowledge_graph, semantic, taxonomy
from src.config import Settings


CASES_PATH = Path(__file__).resolve().parents[1] / "evals" / "data_management_cases.json"


def main() -> None:
    settings = Settings.from_env()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    results = {
        "entity_resolution": _score_entity_resolution(cases.get("entity_resolution", []), settings),
        "taxonomy_resolution": _score_taxonomy_resolution(cases.get("taxonomy_resolution", []), settings),
        "graph_entity_search": _score_graph_entity_search(cases.get("graph_entity_search", []), settings),
        "provenance": _score_provenance(cases.get("provenance", []), settings),
    }
    total_passed = sum(item["passed"] for item in results.values())
    total_cases = sum(item["total"] for item in results.values())
    print(json.dumps({"passed": total_passed, "total": total_cases, "suites": results}, indent=2))
    if total_passed != total_cases:
        raise SystemExit(1)


def _score_entity_resolution(cases: list[dict], settings: Settings) -> dict:
    passed = 0
    details = []
    for case in cases:
        result = semantic.resolve_business_term(case["term"], settings)
        concept_ids = {match["concept_id"] for match in result["matches"]}
        ok = case["expected_concept_id"] in concept_ids
        passed += int(ok)
        details.append({"case": case, "ok": ok, "concept_ids": sorted(concept_ids)})
    return {"passed": passed, "total": len(cases), "details": details}


def _score_taxonomy_resolution(cases: list[dict], settings: Settings) -> dict:
    passed = 0
    details = []
    for case in cases:
        result = taxonomy.resolve_taxonomy_concept(case["term"], settings)
        concept_ids = {match["concept_id"] for match in result["matches"]}
        ok = case["expected_concept_id"] in concept_ids
        passed += int(ok)
        details.append({"case": case, "ok": ok, "concept_ids": sorted(concept_ids)})
    return {"passed": passed, "total": len(cases), "details": details}


def _score_graph_entity_search(cases: list[dict], settings: Settings) -> dict:
    passed = 0
    details = []
    for case in cases:
        result = knowledge_graph.search_entities(case["query"], settings=settings)
        node_types = {match["node_type"] for match in result["matches"]}
        ok = case["expected_node_type"] in node_types
        passed += int(ok)
        details.append({"case": case, "ok": ok, "node_types": sorted(node_types)})
    return {"passed": passed, "total": len(cases), "details": details}


def _score_provenance(cases: list[dict], settings: Settings) -> dict:
    passed = 0
    details = []
    for case in cases:
        result = knowledge_graph.find_supporting_evidence(case["query"], settings=settings)
        has_chunk_id = any(
            item.get("chunk_id")
            for evidence in result["evidence"]
            for item in evidence.get("provenance", [])
        )
        ok = bool(has_chunk_id) == bool(case["expected_has_chunk_id"])
        passed += int(ok)
        details.append({"case": case, "ok": ok, "evidence_count": len(result["evidence"])})
    return {"passed": passed, "total": len(cases), "details": details}


if __name__ == "__main__":
    main()
