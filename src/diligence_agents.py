from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from typing import Any, Literal

from openai import OpenAI
from pydantic import BaseModel, Field, ValidationError

from src import mcp_tools
from src.config import Settings
from src.rag import answer_from_index, is_broad_question
from src.schemas import Citation
from src.telemetry import span


LOGGER = logging.getLogger(__name__)


ClaimType = Literal["observed_fact", "inferred_risk", "unanswered_question"]
AuditStatus = Literal["pass", "revise", "reject"]
Route = Literal["deterministic_rag", "multi_agent_diligence"]


class AgentBudget(BaseModel):
    max_model_calls: int = Field(description="Maximum LLM calls across the supervisor run.")
    max_tool_calls: int = Field(description="Maximum deterministic tool calls across the supervisor run.")
    max_retries: int = Field(description="Maximum retry attempts for malformed structured LLM output.")
    max_elapsed_seconds: int = Field(description="Wall-clock time budget for the supervisor run.")
    max_context_chars: int = Field(description="Maximum evidence characters passed into any one agent call.")

    @classmethod
    def from_settings(cls, settings: Settings) -> "AgentBudget":
        return cls(
            max_model_calls=settings.multi_agent_max_model_calls,
            max_tool_calls=settings.multi_agent_max_tool_calls,
            max_retries=settings.multi_agent_max_retries,
            max_elapsed_seconds=settings.multi_agent_max_elapsed_seconds,
            max_context_chars=settings.multi_agent_max_context_chars,
        )


class TraceEvent(BaseModel):
    agent: str = Field(description="Agent or deterministic component that produced the event.")
    action: str = Field(description="Decision, model call, tool call, or release-gate action.")
    status: str = Field(description="Outcome status such as started, ok, blocked, rejected, or fallback.")
    detail: str = Field(description="Short human-readable explanation.")
    elapsed_seconds: float = Field(description="Elapsed time since the supervisor run began.")


class EvidenceQueryPlan(BaseModel):
    queries: list[str] = Field(description="Search queries the research agent should run.")
    entities: list[str] = Field(description="Entities or concepts worth inspecting in graph/catalogue tools.")
    rationale: str = Field(description="Why these queries cover the diligence request.")


class EvidenceItem(BaseModel):
    evidence_id: str = Field(description="Stable identifier used by later agents.")
    source_tool: str = Field(description="Tool that produced the evidence.")
    query: str | None = Field(default=None, description="Research query that found this item.")
    chunk_id: str | None = Field(default=None, description="Source chunk ID when available.")
    doc: str | None = Field(default=None, description="Source document filename.")
    page_start: int | None = Field(default=None, description="First source page.")
    page_end: int | None = Field(default=None, description="Final source page.")
    section_title: str | None = Field(default=None, description="Source section title.")
    source: str | None = Field(default=None, description="Human-readable source label.")
    quote_or_excerpt: str = Field(description="Verbatim source quote or excerpt.")
    score: float | None = Field(default=None, description="Retrieval or graph score when available.")


class EvidenceBundle(BaseModel):
    question: str = Field(description="Original broad diligence question.")
    search_queries: list[str] = Field(description="Queries executed by the evidence research agent.")
    coverage_summary: dict[str, Any] = Field(description="Document coverage and extraction status.")
    evidence: list[EvidenceItem] = Field(description="Evidence candidates for analysis.")
    research_notes: list[str] = Field(description="Important caveats or coverage observations.")


class CandidateClaim(BaseModel):
    claim_id: str = Field(description="Stable claim identifier.")
    claim: str = Field(description="Candidate diligence claim or unanswered question.")
    claim_type: ClaimType = Field(description="Observed fact, inferred risk, or unanswered question.")
    supporting_evidence_ids: list[str] = Field(
        default_factory=list,
        description="Evidence IDs used to support the claim.",
    )
    citations: list[Citation] = Field(
        default_factory=list,
        description="Exact source citations proposed for this claim.",
    )
    rationale: str = Field(description="Why the claim matters for commercial diligence.")


class CandidateClaimSet(BaseModel):
    claims: list[CandidateClaim] = Field(description="Candidate claims generated from the evidence bundle.")
    missing_information: list[str] = Field(description="Questions the evidence does not answer.")


class CitationVerification(BaseModel):
    chunk_id: str
    quote: str
    verified: bool
    reason: str
    source: str | None = None


class AuditedClaim(BaseModel):
    claim_id: str
    claim: str
    claim_type: ClaimType
    status: AuditStatus
    reason: str
    supporting_evidence_ids: list[str] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    verifications: list[CitationVerification] = Field(default_factory=list)


class AuditReport(BaseModel):
    audited_claims: list[AuditedClaim]

    @property
    def approved_claims(self) -> list[AuditedClaim]:
        return [claim for claim in self.audited_claims if claim.status in {"pass", "revise"}]

    @property
    def rejected_claims(self) -> list[AuditedClaim]:
        return [claim for claim in self.audited_claims if claim.status == "reject"]


class MultiAgentResult(BaseModel):
    route: Route
    answer: str
    trace: list[TraceEvent] = Field(default_factory=list)
    approved_claims: list[AuditedClaim] = Field(default_factory=list)
    rejected_claims: list[AuditedClaim] = Field(default_factory=list)
    budget: AgentBudget | None = None
    model_calls_used: int = 0
    tool_calls_used: int = 0
    exported_path: str | None = None


class _AuditDecision(BaseModel):
    claim_id: str
    status: AuditStatus
    reason: str
    revised_claim: str | None = None


class _AuditDecisionSet(BaseModel):
    decisions: list[_AuditDecision]


class _ReportDraft(BaseModel):
    markdown: str


class _AgentRuntime:
    def __init__(self, settings: Settings, budget: AgentBudget):
        self.settings = settings
        self.budget = budget
        self.started_at = time.monotonic()
        self.model_calls = 0
        self.tool_calls = 0
        self.trace: list[TraceEvent] = []

    def record(self, agent: str, action: str, status: str, detail: str) -> None:
        self.trace.append(
            TraceEvent(
                agent=agent,
                action=action,
                status=status,
                detail=_one_line(detail, 260),
                elapsed_seconds=round(time.monotonic() - self.started_at, 2),
            )
        )

    def check_budget(self) -> None:
        if time.monotonic() - self.started_at > self.budget.max_elapsed_seconds:
            raise RuntimeError("Multi-agent elapsed-time budget exceeded.")
        if self.model_calls > self.budget.max_model_calls:
            raise RuntimeError("Multi-agent model-call budget exceeded.")
        if self.tool_calls > self.budget.max_tool_calls:
            raise RuntimeError("Multi-agent tool-call budget exceeded.")

    def use_model(self, agent: str, purpose: str) -> None:
        self.model_calls += 1
        self.record(agent, "model_call", "started", purpose)
        self.check_budget()

    def use_tool(
        self,
        agent: str,
        allowed_tools: set[str],
        tool_name: str,
        args: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        args = args or {}
        if tool_name not in allowed_tools:
            self.record(agent, "tool_call", "blocked", f"{tool_name} is not in allowlist")
            raise PermissionError(f"{agent} is not allowed to call {tool_name}.")
        if self.tool_calls >= self.budget.max_tool_calls:
            self.record(agent, "tool_call", "blocked", "Tool-call budget exhausted.")
            raise RuntimeError("Multi-agent tool-call budget exceeded.")
        self.tool_calls += 1
        self.record(agent, "tool_call", "started", f"{tool_name}({json.dumps(args, ensure_ascii=False)})")
        self.check_budget()
        with span(
            "mcp.tool.call",
            {
                "agent_name": agent,
                "tool_name": tool_name,
                "workspace_id": "local",
            },
        ):
            result = _dispatch_tool(tool_name, args)
        self.record(agent, "tool_call", "ok", f"{tool_name} returned {_result_size(result)}")
        return result


RESEARCH_AGENT = "Evidence Research Agent"
RISK_AGENT = "Contract and Risk Agent"
AUDIT_AGENT = "Citation Audit Agent"
REPORT_AGENT = "Report Builder Agent"
SUPERVISOR = "Supervisor"

RESEARCH_TOOLS = {
    "list_documents",
    "search_data_room",
    "get_chunk",
    "get_document_coverage",
    "search_catalog",
    "find_supporting_evidence",
    "get_entity_relationships",
}
AUDIT_TOOLS = {"verify_citation"}
REPORT_TOOLS = {"export_powerpoint_outline"}


def answer_with_diligence_supervisor(
    question: str,
    settings: Settings | None = None,
    *,
    force_multi_agent: bool = False,
    allow_export: bool = False,
) -> MultiAgentResult:
    settings = settings or Settings.from_env()
    budget = AgentBudget.from_settings(settings)
    runtime = _AgentRuntime(settings, budget)
    runtime.record(SUPERVISOR, "route_decision", "started", "Classifying request.")

    with span("agent.route", {"agent.route": "supervisor", "workspace_id": "local"}):
        if not settings.multi_agent_enabled and not force_multi_agent:
            runtime.record(SUPERVISOR, "route_decision", "deterministic", "Multi-agent workflow disabled.")
            answer = answer_from_index(question, settings)
            return _result("deterministic_rag", answer, runtime)

        if not force_multi_agent and not is_broad_question(question):
            runtime.record(
                SUPERVISOR,
                "route_decision",
                "deterministic",
                "Simple factual request stays on the lower-cost RAG path.",
            )
            answer = answer_from_index(question, settings)
            return _result("deterministic_rag", answer, runtime)

    runtime.record(
        SUPERVISOR,
        "route_decision",
        "multi_agent",
        "Broad diligence request routed to specialist agents.",
    )
    try:
        evidence = _run_evidence_research_agent(question, runtime)
        candidates = _run_contract_and_risk_agent(evidence, runtime)
        audit = _run_citation_audit_agent(candidates, runtime)
        answer, exported_path = _run_report_builder_agent(
            question,
            audit,
            runtime,
            allow_export=allow_export,
        )
        return _result(
            "multi_agent_diligence",
            answer,
            runtime,
            approved_claims=audit.approved_claims,
            rejected_claims=audit.rejected_claims,
            exported_path=exported_path,
        )
    except Exception as exc:
        LOGGER.exception("Multi-agent workflow failed.")
        runtime.record(SUPERVISOR, "fallback", "ok", f"Falling back to deterministic RAG: {exc}")
        answer = answer_from_index(question, settings)
        return _result("deterministic_rag", answer, runtime)


def format_multi_agent_result(result: MultiAgentResult, *, include_trace: bool = True) -> str:
    parts = [result.answer, f"Route: {result.route}"]
    if result.exported_path:
        parts.append(f"Exported: {result.exported_path}")
    if include_trace and result.trace:
        trace_lines = [
            f"- {event.elapsed_seconds:>5.2f}s | {event.agent} | {event.action} | "
            f"{event.status} | {event.detail}"
            for event in result.trace
        ]
        parts.append("Agent trace:\n" + "\n".join(trace_lines))
    return "\n\n".join(parts)


def _run_evidence_research_agent(question: str, runtime: _AgentRuntime) -> EvidenceBundle:
    runtime.record(RESEARCH_AGENT, "start", "ok", "Planning evidence queries.")
    plan = _create_research_plan(question, runtime)
    coverage = runtime.use_tool(RESEARCH_AGENT, RESEARCH_TOOLS, "get_document_coverage")
    runtime.use_tool(RESEARCH_AGENT, RESEARCH_TOOLS, "list_documents")

    items: list[EvidenceItem] = []
    seen_chunks: set[str] = set()
    notes = _coverage_notes(coverage)

    executed_queries = plan.queries[:3]
    for query in executed_queries:
        search = runtime.use_tool(
            RESEARCH_AGENT,
            RESEARCH_TOOLS,
            "search_data_room",
            {"query": query, "top_k": 3, "semantic": True},
        )
        for result in search.get("results", [])[:3]:
            chunk_id = str(result.get("chunk_id") or "")
            if not chunk_id or chunk_id in seen_chunks:
                continue
            seen_chunks.add(chunk_id)
            chunk = runtime.use_tool(RESEARCH_AGENT, RESEARCH_TOOLS, "get_chunk", {"chunk_id": chunk_id})
            chunk_payload = chunk.get("chunk") if chunk.get("found") else result
            items.append(_evidence_from_chunk_payload(len(items), "search_data_room", query, chunk_payload))

        catalogue_result = runtime.use_tool(
            RESEARCH_AGENT,
            RESEARCH_TOOLS,
            "search_catalog",
            {"query": query, "limit": 3},
        )
        if catalogue_result.get("results"):
            notes.append(f"Catalogue had {len(catalogue_result['results'])} match(es) for '{query}'.")

        graph_result = runtime.use_tool(
            RESEARCH_AGENT,
            RESEARCH_TOOLS,
            "find_supporting_evidence",
            {"query": query, "limit": 3},
        )
        for node in graph_result.get("evidence", []):
            for provenance in node.get("provenance", [])[:1]:
                key = f"{provenance.get('chunk_id')}:{provenance.get('quote')}"
                if key in seen_chunks:
                    continue
                items.append(_evidence_from_provenance(len(items), "find_supporting_evidence", query, provenance))

    for entity in plan.entities[:2]:
        try:
            graph = runtime.use_tool(
                RESEARCH_AGENT,
                RESEARCH_TOOLS,
                "get_entity_relationships",
                {"entity_id_or_name": entity, "depth": 1},
            )
        except Exception as exc:
            notes.append(f"Entity relationship lookup failed for {entity}: {exc}")
            continue
        if graph.get("relationships"):
            notes.append(f"Graph relationships found for {entity}: {len(graph['relationships'])}.")

    runtime.record(
        RESEARCH_AGENT,
        "complete",
        "ok",
        f"Collected {len(items)} evidence item(s) across {len(executed_queries)} query/query-plan item(s).",
    )
    return EvidenceBundle(
        question=question,
        search_queries=executed_queries,
        coverage_summary=_compact_coverage(coverage),
        evidence=items[:18],
        research_notes=notes[:12],
    )


def _create_research_plan(question: str, runtime: _AgentRuntime) -> EvidenceQueryPlan:
    parameters = {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Three to five targeted evidence search queries.",
            },
            "entities": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Important companies, counterparties, concepts, or risks to inspect.",
            },
            "rationale": {"type": "string"},
        },
        "required": ["queries", "entities", "rationale"],
        "additionalProperties": False,
    }
    try:
        data = _call_structured_function(
            runtime,
            RESEARCH_AGENT,
            "submit_evidence_plan",
            "Submit targeted evidence searches for a diligence question.",
            parameters,
            system=(
                "You are an evidence research agent for commercial due diligence. "
                "Decompose broad requests into targeted document, catalogue, and graph searches. "
                "Do not answer the question."
            ),
            user=f"Question:\n{question}\n\nReturn focused searches for evidence collection.",
            max_tokens=700,
        )
        plan = EvidenceQueryPlan.model_validate(data)
        if plan.queries:
            runtime.record(RESEARCH_AGENT, "plan", "ok", f"Queries: {', '.join(plan.queries[:4])}")
            return plan
    except Exception as exc:
        runtime.record(RESEARCH_AGENT, "plan", "fallback", f"LLM planning failed: {exc}")

    fallback = EvidenceQueryPlan(
        queries=[
            question,
            "customer concentration contract renewal termination exposure",
            "management gaps commercial risks missing information",
            "market position competitors growth risks",
        ],
        entities=["Meridian Analytics", "Contract", "Risk"],
        rationale="Deterministic fallback plan for broad diligence questions.",
    )
    runtime.record(RESEARCH_AGENT, "plan", "fallback", "Used deterministic evidence search plan.")
    return fallback


def _run_contract_and_risk_agent(
    evidence: EvidenceBundle,
    runtime: _AgentRuntime,
) -> CandidateClaimSet:
    runtime.record(RISK_AGENT, "start", "ok", "Analyzing evidence bundle without raw tool access.")
    compact = _bounded_json(evidence.model_dump(mode="json"), runtime.budget.max_context_chars)
    parameters = {
        "type": "object",
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"},
                        "claim": {"type": "string"},
                        "claim_type": {
                            "type": "string",
                            "enum": ["observed_fact", "inferred_risk", "unanswered_question"],
                        },
                        "supporting_evidence_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "citations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "chunk_id": {"type": "string"},
                                    "quote": {"type": "string"},
                                },
                                "required": ["chunk_id", "quote"],
                                "additionalProperties": False,
                            },
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": [
                        "claim_id",
                        "claim",
                        "claim_type",
                        "supporting_evidence_ids",
                        "citations",
                        "rationale",
                    ],
                    "additionalProperties": False,
                },
            },
            "missing_information": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["claims", "missing_information"],
        "additionalProperties": False,
    }
    try:
        data = _call_structured_function(
            runtime,
            RISK_AGENT,
            "submit_candidate_claims",
            "Submit candidate diligence claims, risks, and unanswered questions.",
            parameters,
            system=(
                "You are a contract and risk diligence agent. "
                "Use only the supplied evidence bundle. Distinguish observed facts, inferred risks, "
                "and unanswered questions. Do not call tools. Every observed fact or inferred risk "
                "must include citations with exact quotes copied from evidence excerpts. Keep claims concise."
            ),
            user=(
                "Evidence bundle JSON:\n"
                f"{compact}\n\n"
                "Return 3-6 candidate claims covering concentration, termination or renewal exposure, "
                "liabilities, management gaps, market risks, and missing information where relevant."
            ),
            max_tokens=min(max(runtime.settings.answer_max_tokens, 4000), 7000),
        )
        claims = CandidateClaimSet.model_validate(data)
    except Exception as exc:
        runtime.record(RISK_AGENT, "fallback", "ok", f"Structured claim generation failed: {exc}")
        claims = _fallback_candidate_claims(evidence)
    normalized = []
    for index, claim in enumerate(claims.claims[:6], start=1):
        claim_id = claim.claim_id or f"C{index:03d}"
        normalized.append(
            claim.model_copy(
                update={
                    "claim_id": claim_id,
                    "citations": claim.citations[:2],
                    "supporting_evidence_ids": claim.supporting_evidence_ids[:4],
                }
            )
        )
    result = claims.model_copy(update={"claims": normalized})
    runtime.record(RISK_AGENT, "complete", "ok", f"Produced {len(result.claims)} candidate claim(s).")
    return result


def _run_citation_audit_agent(
    candidates: CandidateClaimSet,
    runtime: _AgentRuntime,
) -> AuditReport:
    runtime.record(AUDIT_AGENT, "start", "ok", "Mechanically verifying proposed citations.")
    mechanically_audited: list[AuditedClaim] = []
    for claim in candidates.claims:
        verifications = [
            _verify_with_tool(runtime, citation)
            for citation in claim.citations
            if citation.chunk_id and citation.quote
        ]
        all_verified = bool(verifications) and all(item.verified for item in verifications)
        if claim.claim_type == "unanswered_question":
            mechanically_audited.append(
                AuditedClaim(
                    claim_id=claim.claim_id,
                    claim=claim.claim,
                    claim_type=claim.claim_type,
                    status="pass",
                    reason="Unanswered question is allowed without a citation.",
                    supporting_evidence_ids=claim.supporting_evidence_ids,
                    citations=[],
                    verifications=[],
                )
            )
        elif all_verified:
            mechanically_audited.append(
                AuditedClaim(
                    claim_id=claim.claim_id,
                    claim=claim.claim,
                    claim_type=claim.claim_type,
                    status="pass",
                    reason="Mechanically verified; awaiting support audit.",
                    supporting_evidence_ids=claim.supporting_evidence_ids,
                    citations=claim.citations,
                    verifications=verifications,
                )
            )
        else:
            mechanically_audited.append(
                AuditedClaim(
                    claim_id=claim.claim_id,
                    claim=claim.claim,
                    claim_type=claim.claim_type,
                    status="reject",
                    reason="One or more citations failed exact quote verification.",
                    supporting_evidence_ids=claim.supporting_evidence_ids,
                    citations=[],
                    verifications=verifications,
                )
            )

    try:
        reviewed = _llm_support_audit(mechanically_audited, runtime)
    except Exception as exc:
        runtime.record(AUDIT_AGENT, "support_audit", "fallback", f"LLM support audit failed: {exc}")
        reviewed = mechanically_audited

    released: list[AuditedClaim] = []
    for claim in reviewed:
        if claim.claim_type != "unanswered_question" and not _all_quotes_verified(claim):
            released.append(claim.model_copy(update={"status": "reject", "citations": []}))
        else:
            released.append(claim)

    approved = sum(1 for claim in released if claim.status in {"pass", "revise"})
    rejected = sum(1 for claim in released if claim.status == "reject")
    runtime.record(AUDIT_AGENT, "release_gate", "ok", f"Approved {approved}; rejected {rejected}.")
    return AuditReport(audited_claims=released)


def _verify_with_tool(runtime: _AgentRuntime, citation: Citation) -> CitationVerification:
    result = runtime.use_tool(
        AUDIT_AGENT,
        AUDIT_TOOLS,
        "verify_citation",
        {"chunk_id": citation.chunk_id, "quote": citation.quote},
    )
    return CitationVerification(
        chunk_id=citation.chunk_id,
        quote=citation.quote,
        verified=bool(result.get("verified")),
        reason=str(result.get("reason") or "unknown"),
        source=result.get("source"),
    )


def _llm_support_audit(
    claims: list[AuditedClaim],
    runtime: _AgentRuntime,
) -> list[AuditedClaim]:
    auditable = [claim for claim in claims if claim.status == "pass" and claim.claim_type != "unanswered_question"]
    if not auditable:
        return claims
    parameters = {
        "type": "object",
        "properties": {
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"},
                        "status": {"type": "string", "enum": ["pass", "revise", "reject"]},
                        "reason": {"type": "string"},
                        "revised_claim": {"type": ["string", "null"]},
                    },
                    "required": ["claim_id", "status", "reason", "revised_claim"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["decisions"],
        "additionalProperties": False,
    }
    data = _call_structured_function(
        runtime,
        AUDIT_AGENT,
        "submit_citation_audit",
        "Submit support-level citation audit decisions.",
        parameters,
        system=(
            "You are a citation audit agent. Mechanical quote verification has already run. "
            "Your job is to reject or revise claims where the quote is real but too narrow, "
            "ambiguous, or does not support the full proposition. Do not approve unsupported inference."
        ),
        user=(
            "Auditable claims JSON:\n"
            f"{_bounded_json([claim.model_dump(mode='json') for claim in auditable], runtime.budget.max_context_chars)}\n\n"
            "Return pass, revise, or reject for each claim. If revised, write a narrower revised_claim "
            "that is fully supported by the verified quote."
        ),
        max_tokens=1400,
    )
    decisions = _AuditDecisionSet.model_validate(data)
    by_id = {decision.claim_id: decision for decision in decisions.decisions}
    reviewed = []
    for claim in claims:
        decision = by_id.get(claim.claim_id)
        if decision is None or claim.status == "reject":
            reviewed.append(claim)
            continue
        next_claim = decision.revised_claim if decision.status == "revise" and decision.revised_claim else claim.claim
        reviewed.append(
            claim.model_copy(
                update={
                    "claim": next_claim,
                    "status": decision.status,
                    "reason": decision.reason,
                }
            )
        )
    return reviewed


def _run_report_builder_agent(
    question: str,
    audit: AuditReport,
    runtime: _AgentRuntime,
    *,
    allow_export: bool,
) -> tuple[str, str | None]:
    approved = audit.approved_claims
    rejected = audit.rejected_claims
    runtime.record(REPORT_AGENT, "start", "ok", f"Building report from {len(approved)} approved claim(s).")
    if not approved:
        answer = (
            "No source-backed diligence report was released because the workflow did not produce "
            "any claims that passed citation verification. Review the rejected claims or broaden the data room."
        )
        return answer, None

    parameters = {
        "type": "object",
        "properties": {
            "markdown": {
                "type": "string",
                "description": "Client-ready diligence memo or slide-outline in Markdown.",
            }
        },
        "required": ["markdown"],
        "additionalProperties": False,
    }
    try:
        data = _call_structured_function(
            runtime,
            REPORT_AGENT,
            "submit_report",
            "Submit a client-ready diligence report from approved claims only.",
            parameters,
            system=(
                "You are a report builder agent. Use only approved audited claims. "
                "Preserve evidence identifiers, source labels, and quotes. Do not introduce new facts. "
                "Mention rejected or missing evidence separately as diligence gaps."
            ),
            user=(
                f"Question:\n{question}\n\n"
                "Approved claims JSON:\n"
                f"{_bounded_json([claim.model_dump(mode='json') for claim in approved], runtime.budget.max_context_chars)}\n\n"
                "Rejected or narrowed claims JSON:\n"
                f"{_bounded_json([claim.model_dump(mode='json') for claim in rejected[:6]], 8000)}\n\n"
                "Build the final response."
            ),
            max_tokens=2600,
        )
        draft = _ReportDraft.model_validate(data)
    except Exception as exc:
        runtime.record(REPORT_AGENT, "fallback", "ok", f"Structured report generation failed: {exc}")
        draft = _ReportDraft(markdown=_deterministic_report(question, approved, rejected))
    exported_path = None
    if _asks_for_export(question):
        if allow_export:
            export_result = runtime.use_tool(
                REPORT_AGENT,
                REPORT_TOOLS,
                "export_powerpoint_outline",
                {
                    "title": "Data Room Cited Diligence Report",
                    "outline_markdown": draft.markdown,
                    "filename": "multi_agent_diligence_report",
                },
            )
            exported_path = export_result.get("path")
            runtime.record(REPORT_AGENT, "export", "ok", f"Exported after approval: {exported_path}")
        else:
            runtime.record(
                REPORT_AGENT,
                "export",
                "blocked",
                "User asked for export, but approval flag was not provided.",
            )
            draft = draft.model_copy(
                update={
                    "markdown": (
                        f"{draft.markdown}\n\n"
                        "Export not run: write operations require explicit approval."
                    )
                }
            )
    runtime.record(REPORT_AGENT, "complete", "ok", "Final report built from approved claims only.")
    return draft.markdown, exported_path


def _call_structured_function(
    runtime: _AgentRuntime,
    agent: str,
    function_name: str,
    description: str,
    parameters: dict[str, Any],
    *,
    system: str,
    user: str,
    max_tokens: int,
) -> dict[str, Any]:
    client = OpenAI(
        api_key=runtime.settings.require_deepseek_api_key(),
        base_url=runtime.settings.llm_base_url,
    )
    tool_spec = {
        "type": "function",
        "function": {
            "name": function_name,
            "description": description,
            "parameters": parameters,
        },
    }
    last_error: Exception | None = None
    for attempt in range(runtime.budget.max_retries + 1):
        runtime.use_model(agent, f"{function_name}, attempt {attempt + 1}")
        with span(
            "agent.subagent.invoke",
            {
                "agent_name": agent,
                "model_id": runtime.settings.llm_model_id,
                "prompt_version": function_name,
                "llm.max_tokens": max_tokens,
            },
        ):
            response = client.chat.completions.create(
                model=runtime.settings.llm_model_id,
                temperature=0.0,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                tools=[tool_spec],
                tool_choice={"type": "function", "function": {"name": function_name}},
            )
        message = response.choices[0].message
        tool_calls = message.tool_calls or []
        try:
            if not tool_calls:
                raise RuntimeError(f"{agent} did not call {function_name}.")
            arguments = tool_calls[0].function.arguments
            if not arguments:
                raise RuntimeError(f"{agent} returned empty arguments for {function_name}.")
            data = json.loads(arguments)
            runtime.record(agent, "model_call", "ok", f"{function_name} returned structured output.")
            return data
        except (json.JSONDecodeError, RuntimeError, ValidationError) as exc:
            last_error = exc
            runtime.record(agent, "model_call", "retry", f"{function_name} parse failed: {exc}")
    raise RuntimeError(f"{function_name} failed after retries: {last_error}")


def _dispatch_tool(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    dispatch: dict[str, Callable[..., dict[str, Any]]] = {
        "list_documents": lambda: mcp_tools.list_documents(),
        "search_data_room": mcp_tools.search_data_room,
        "get_chunk": mcp_tools.get_chunk,
        "get_document_coverage": lambda: mcp_tools.get_document_coverage(),
        "search_catalog": mcp_tools.search_catalog,
        "find_supporting_evidence": mcp_tools.find_supporting_evidence,
        "get_entity_relationships": mcp_tools.get_entity_relationships,
        "verify_citation": mcp_tools.verify_citation,
        "export_powerpoint_outline": mcp_tools.export_powerpoint_outline,
    }
    if tool_name not in dispatch:
        raise ValueError(f"Unknown tool: {tool_name}")
    return dispatch[tool_name](**args)


def _fallback_candidate_claims(evidence: EvidenceBundle) -> CandidateClaimSet:
    claims: list[CandidateClaim] = []
    for item in evidence.evidence[:6]:
        if not item.chunk_id:
            continue
        quote = _short_exact_quote(item.quote_or_excerpt)
        if not quote:
            continue
        claims.append(
            CandidateClaim(
                claim_id=f"C{len(claims) + 1:03d}",
                claim=f"Source evidence states: {quote}",
                claim_type="observed_fact",
                supporting_evidence_ids=[item.evidence_id],
                citations=[Citation(chunk_id=item.chunk_id, quote=quote)],
                rationale=(
                    "Fallback claim produced from a single evidence item after structured "
                    "risk-agent output failed."
                ),
            )
        )
    missing_information = evidence.research_notes[:4]
    if not claims:
        missing_information.append("No fallback claims could be produced from chunk-backed evidence.")
    return CandidateClaimSet(claims=claims, missing_information=missing_information)


def _deterministic_report(
    question: str,
    approved: list[AuditedClaim],
    rejected: list[AuditedClaim],
) -> str:
    lines = [
        f"## Diligence Workflow Response",
        "",
        f"Question: {question}",
        "",
        "### Approved Source-Backed Claims",
    ]
    for claim in approved:
        lines.append(f"- [{claim.claim_id}] {claim.claim}")
        for citation in claim.citations:
            source = next(
                (verification.source for verification in claim.verifications if verification.chunk_id == citation.chunk_id),
                None,
            )
            source_label = source or citation.chunk_id
            lines.append(f"  - {source_label}: \"{citation.quote}\"")
    if rejected:
        lines.extend(["", "### Rejected Or Unreleased Claims"])
        for claim in rejected[:6]:
            lines.append(f"- [{claim.claim_id}] {claim.reason}")
    return "\n".join(lines)


def _evidence_from_chunk_payload(
    index: int,
    source_tool: str,
    query: str,
    chunk: dict[str, Any],
) -> EvidenceItem:
    text = str(chunk.get("text") or chunk.get("text_preview") or "")
    return EvidenceItem(
        evidence_id=f"E{index + 1:03d}",
        source_tool=source_tool,
        query=query,
        chunk_id=chunk.get("chunk_id"),
        doc=chunk.get("doc"),
        page_start=chunk.get("page_start") or chunk.get("page"),
        page_end=chunk.get("page_end") or chunk.get("page"),
        section_title=chunk.get("section_title"),
        source=chunk.get("source"),
        quote_or_excerpt=_best_excerpt(text, query),
        score=chunk.get("score"),
    )


def _evidence_from_provenance(
    index: int,
    source_tool: str,
    query: str,
    provenance: dict[str, Any],
) -> EvidenceItem:
    return EvidenceItem(
        evidence_id=f"E{index + 1:03d}",
        source_tool=source_tool,
        query=query,
        chunk_id=provenance.get("chunk_id"),
        doc=provenance.get("doc"),
        page_start=provenance.get("page_start"),
        page_end=provenance.get("page_end"),
        source=_source_from_provenance(provenance),
        quote_or_excerpt=str(provenance.get("quote") or ""),
    )


def _coverage_notes(coverage: dict[str, Any]) -> list[str]:
    notes = []
    for document in coverage.get("documents", []):
        for warning in document.get("warnings", []):
            notes.append(f"{document.get('filename')}: {warning}")
    if coverage.get("index_error"):
        notes.append(f"Index error: {coverage['index_error']}")
    return notes


def _compact_coverage(coverage: dict[str, Any]) -> dict[str, Any]:
    return {
        "pdf_count": coverage.get("pdf_count"),
        "indexed_document_count": coverage.get("indexed_document_count"),
        "total_chunks": coverage.get("total_chunks"),
        "embedding_shape": coverage.get("embedding_shape"),
        "documents": [
            {
                "filename": item.get("filename"),
                "indexed_chunks": item.get("indexed_chunks"),
                "indexed_pages": item.get("indexed_pages"),
                "warnings": item.get("warnings"),
            }
            for item in coverage.get("documents", [])
        ],
    }


def _all_quotes_verified(claim: AuditedClaim) -> bool:
    if claim.claim_type == "unanswered_question":
        return True
    return bool(claim.verifications) and all(item.verified for item in claim.verifications)


def _result(
    route: Route,
    answer: str,
    runtime: _AgentRuntime,
    *,
    approved_claims: list[AuditedClaim] | None = None,
    rejected_claims: list[AuditedClaim] | None = None,
    exported_path: str | None = None,
) -> MultiAgentResult:
    return MultiAgentResult(
        route=route,
        answer=answer,
        trace=runtime.trace,
        approved_claims=approved_claims or [],
        rejected_claims=rejected_claims or [],
        budget=runtime.budget,
        model_calls_used=runtime.model_calls,
        tool_calls_used=runtime.tool_calls,
        exported_path=exported_path,
    )


def _best_excerpt(text: str, query: str, limit: int = 1200) -> str:
    clean = text.strip()
    if len(clean) <= limit:
        return clean
    terms = set(re.findall(r"[a-z0-9]+", query.lower()))
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", clean) if item.strip()]
    scored = []
    for index, paragraph in enumerate(paragraphs):
        paragraph_terms = set(re.findall(r"[a-z0-9]+", paragraph.lower()))
        scored.append((len(terms & paragraph_terms), -index, paragraph))
    scored.sort(reverse=True)
    excerpt = scored[0][2] if scored else clean
    if len(excerpt) > limit:
        excerpt = excerpt[: limit - 3].rstrip() + "..."
    return excerpt


def _short_exact_quote(text: str, limit: int = 220) -> str:
    clean = text.strip()
    if not clean:
        return ""
    pieces = [
        piece.strip()
        for piece in re.split(r"(?<=[.!?])\s+|\n+", clean)
        if piece.strip()
    ]
    quote = pieces[0] if pieces else clean
    if len(quote) <= limit:
        return quote
    return quote[:limit].rstrip()


def _source_from_provenance(provenance: dict[str, Any]) -> str:
    doc = provenance.get("doc") or "Unknown document"
    page_start = provenance.get("page_start")
    page_end = provenance.get("page_end")
    if page_start and page_end and page_start != page_end:
        return f"{doc} pp.{page_start}-{page_end}"
    if page_start:
        return f"{doc} p.{page_start}"
    return doc


def _asks_for_export(question: str) -> bool:
    normalized = question.lower()
    return any(term in normalized for term in ["export", "save", "powerpoint", "ppt", "slide deck"])


def _bounded_json(payload: Any, limit: int) -> str:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if len(text) <= limit:
        return text
    return text[: limit - 80].rstrip() + "\n... [truncated for agent context budget]\n"


def _one_line(text: str, limit: int) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3].rstrip() + "..."


def _result_size(result: dict[str, Any]) -> str:
    return f"{len(json.dumps(result, ensure_ascii=False))} chars"
