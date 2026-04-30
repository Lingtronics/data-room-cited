from __future__ import annotations

import json
import logging
import re
from typing import Protocol

from openai import OpenAI
from pydantic import BaseModel, Field

from src.config import Settings
from src.schemas import Answer, Citation, VerifiedAnswer


LOGGER = logging.getLogger(__name__)


class ChatMessage(BaseModel):
    role: str
    content: str


class RerankCandidate(BaseModel):
    id: str
    text: str
    source: str | None = None
    score: float | None = None
    metadata: dict[str, str | int | float | None] = Field(default_factory=dict)


ANSWER_TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "submit_answer",
        "description": "Submit the final grounded answer with source citations and confidence.",
        "parameters": {
            "type": "object",
            "properties": {
                "answer": {
                    "type": "string",
                    "description": "Final answer to the user, grounded only in the provided chunks.",
                },
                "citations": {
                    "type": "array",
                    "description": (
                        "Citations that support the answer. Each citation must quote text from a cited chunk."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "chunk_id": {
                                "type": "string",
                                "description": (
                                    "The chunk_id of the source chunk that directly supports this citation."
                                ),
                            },
                            "quote": {
                                "type": "string",
                                "description": (
                                    "Short exact quote from the source chunk supporting the answer claim."
                                ),
                            },
                        },
                        "required": ["chunk_id", "quote"],
                        "additionalProperties": False,
                    },
                },
                "confidence": {
                    "type": "string",
                    "enum": ["high", "medium", "low", "insufficient"],
                    "description": (
                        "Confidence in the answer: high, medium, low, or insufficient when the chunks do not answer."
                    ),
                },
            },
            "required": ["answer", "citations", "confidence"],
            "additionalProperties": False,
        },
    },
}


class ChatProvider(Protocol):
    def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        max_tokens: int = 700,
        temperature: float = 0.0,
    ) -> str:
        ...


class DeepSeekProvider:
    """OpenAI-compatible DeepSeek chat provider."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = OpenAI(
            api_key=settings.require_deepseek_api_key(),
            base_url=settings.llm_base_url,
        )

    def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        max_tokens: int = 700,
        temperature: float = 0.0,
    ) -> str:
        response = self.client.chat.completions.create(
            model=model or self.settings.llm_model_id,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[message.model_dump() for message in messages],
        )
        return response.choices[0].message.content or ""


def create_chat_provider(settings: Settings) -> ChatProvider:
    provider = settings.llm_provider.lower()
    if provider == "deepseek":
        return DeepSeekProvider(settings)
    raise ValueError(f"Unsupported LLM_PROVIDER: {settings.llm_provider}")


def call_llm_structured(
    system: str,
    user: str,
    max_tokens: int,
    temperature: float = 0.0,
    retry_on_invalid_json: bool = True,
) -> dict:
    settings = Settings.from_env()
    client = OpenAI(
        api_key=settings.require_deepseek_api_key(),
        base_url=settings.llm_base_url,
    )
    arguments = _call_submit_answer_tool(
        client,
        model=settings.llm_model_id,
        system=system,
        user=user,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    try:
        return json.loads(arguments)
    except json.JSONDecodeError as exc:
        if not retry_on_invalid_json:
            raise RuntimeError("DeepSeek submit_answer arguments were not valid JSON.") from exc
        LOGGER.warning("DeepSeek submit_answer arguments were invalid JSON; retrying once.")
        retry_user = (
            f"{user}\n\n"
            "Your previous submit_answer tool arguments were not valid JSON. "
            "Retry once with a valid submit_answer function call. "
            "Keep the answer concise enough to fit in the tool arguments, preserve the requested structure, "
            "and include only citations whose quotes are exact source substrings."
        )
        retry_arguments = _call_submit_answer_tool(
            client,
            model=settings.llm_model_id,
            system=system,
            user=retry_user,
            max_tokens=max(max_tokens, settings.answer_max_tokens),
            temperature=temperature,
        )
        try:
            return json.loads(retry_arguments)
        except json.JSONDecodeError as retry_exc:
            raise RuntimeError("DeepSeek submit_answer arguments were not valid JSON after one retry.") from retry_exc


def _call_submit_answer_tool(
    client: OpenAI,
    *,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> str:
    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        tools=[ANSWER_TOOL_SPEC],
        tool_choice={"type": "function", "function": {"name": "submit_answer"}},
    )
    message = response.choices[0].message
    tool_calls = message.tool_calls or []
    if not tool_calls:
        raise RuntimeError("DeepSeek response did not include the expected submit_answer function call.")

    tool_call = tool_calls[0]
    function = tool_call.function
    if function.name != "submit_answer":
        raise RuntimeError(
            f"DeepSeek response called unexpected function {function.name!r}; expected 'submit_answer'."
        )
    arguments = function.arguments
    if not arguments:
        raise RuntimeError("DeepSeek submit_answer function call did not include arguments.")
    return arguments


def contextualize_chunk(
    provider: ChatProvider,
    settings: Settings,
    *,
    document_name: str,
    chunk_text: str,
) -> str:
    messages = [
        ChatMessage(
            role="system",
            content=(
                "You write concise retrieval context for data-room document chunks. "
                "Preserve names, dates, amounts, obligations, risks, and cross-references. "
                "Do not add facts that are not in the chunk."
            ),
        ),
        ChatMessage(
            role="user",
            content=(
                f"Document: {document_name}\n\n"
                f"Chunk:\n{chunk_text}\n\n"
                "Write 2-4 compact sentences that explain what this chunk is about for retrieval."
            ),
        ),
    ]
    return provider.chat(messages, model=settings.context_model_id, max_tokens=220, temperature=0.0).strip()


def answer_question(
    provider: ChatProvider,
    settings: Settings,
    *,
    question: str,
    context_blocks: list[str],
    source_text_by_chunk_id: dict[str, str] | None = None,
    source_label_by_chunk_id: dict[str, str] | None = None,
) -> str:
    context = "\n\n".join(context_blocks)
    system = _answer_system_prompt()
    data = call_llm_structured(
        system=system,
        user=_answer_user_prompt(question, context),
        max_tokens=settings.answer_max_tokens,
        temperature=0.0,
    )
    answer = Answer.model_validate(data)
    if source_text_by_chunk_id is None:
        return _format_answer(answer, source_label_by_chunk_id)
    verified = _verify_answer(answer, source_text_by_chunk_id)
    if _should_retry_answer(verified):
        try:
            retry_data = call_llm_structured(
                system=system,
                user=_answer_retry_user_prompt(question, context, verified.unverified_citations),
                max_tokens=settings.answer_max_tokens,
                temperature=0.0,
            )
            retry_answer = Answer.model_validate(retry_data)
            verified = _verify_answer(retry_answer, source_text_by_chunk_id, retried=True)
        except Exception as exc:
            LOGGER.warning("Answer retry failed; returning first verified result. Error: %s", exc)
            verified = verified.model_copy(update={"retried": True})
    return _format_verified_answer(verified, source_label_by_chunk_id)


def _answer_system_prompt() -> str:
    return (
        "You answer questions about a data room using only the supplied context. "
        "Do not use outside knowledge, assumptions, or unstated background information. "
        "Return a structured submit_answer function call. "
        "Every factual claim in the answer must be supported by at least one citation. "
        "Citations must use chunk IDs from the context and quote exact source text. "
        "Keep the answer concise. Use the smallest non-duplicative set of citations needed, "
        "and keep each quote under 180 characters. "
        "If the context is insufficient, say what is missing and use confidence='insufficient'."
    )


def _answer_user_prompt(question: str, context: str) -> str:
    return f"Question:\n{question}\n\nContext:\n{context}\n\nCall submit_answer now."


def _answer_retry_user_prompt(
    question: str,
    context: str,
    unverified_citations: list[Citation],
) -> str:
    failures = _format_unverified_for_retry(unverified_citations)
    return (
        f"Question:\n{question}\n\n"
        f"Context:\n{context}\n\n"
        "Your previous answer included citations that failed verification. "
        "These chunk IDs and quotes were not exact matches against the retrieved source text:\n"
        f"{failures}\n\n"
        "Revise the answer once. Keep only citations whose quote is an exact substring of the cited chunk "
        "after whitespace normalization. If the context does not support the answer, use "
        "confidence='insufficient'. Call submit_answer now."
    )


def _format_unverified_for_retry(citations: list[Citation]) -> str:
    return "\n".join(
        f"- {citation.chunk_id}: \"{_brief_quote(citation.quote)}\"" for citation in citations
    )


def _brief_quote(quote: str, limit: int = 120) -> str:
    one_line = re.sub(r"\s+", " ", quote).strip()
    if len(one_line) <= limit:
        return one_line
    return f"{one_line[: limit - 3]}..."


def _should_retry_answer(answer: VerifiedAnswer) -> bool:
    return bool(answer.unverified_citations) and answer.confidence != "insufficient"


def _format_answer(
    answer: Answer,
    source_label_by_chunk_id: dict[str, str] | None = None,
) -> str:
    if not answer.citations:
        return f"{answer.answer}\n\nConfidence: {answer.confidence}"
    citations = "\n".join(_format_citation(citation, source_label_by_chunk_id) for citation in answer.citations)
    return f"{answer.answer}\n\nCitations:\n{citations}\n\nConfidence: {answer.confidence}"


def _verify_answer(
    answer: Answer,
    source_text_by_chunk_id: dict[str, str],
    *,
    retried: bool = False,
) -> VerifiedAnswer:
    verified: list[Citation] = []
    unverified: list[Citation] = []
    for citation in answer.citations:
        source_text = source_text_by_chunk_id.get(citation.chunk_id, "")
        if _quote_in_source(citation.quote, source_text):
            verified.append(citation)
        else:
            unverified.append(citation)

    confidence = answer.confidence
    if unverified and confidence == "high":
        confidence = "medium"
    elif unverified and confidence == "medium":
        confidence = "low"

    return VerifiedAnswer(
        answer=answer.answer,
        citations=verified,
        confidence=confidence,
        unverified_citations=unverified,
        retried=retried,
    )


def _quote_in_source(quote: str, source_text: str) -> bool:
    normalized_quote = _normalize_for_quote_match(quote)
    if not normalized_quote:
        return False
    return normalized_quote in _normalize_for_quote_match(source_text)


def _normalize_for_quote_match(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _format_verified_answer(
    answer: VerifiedAnswer,
    source_label_by_chunk_id: dict[str, str] | None = None,
) -> str:
    parts = [answer.answer]
    if answer.citations:
        citations = "\n".join(_format_citation(citation, source_label_by_chunk_id) for citation in answer.citations)
        parts.append(f"Citations:\n{citations}")
    if answer.unverified_citations:
        rejected = "\n".join(
            _format_citation(citation, source_label_by_chunk_id)
            for citation in answer.unverified_citations
        )
        parts.append(f"Rejected unverified citations:\n{rejected}")
    parts.append(f"Confidence: {answer.confidence}")
    return "\n\n".join(parts)


def _format_citation(
    citation: Citation,
    source_label_by_chunk_id: dict[str, str] | None,
) -> str:
    source = (source_label_by_chunk_id or {}).get(citation.chunk_id)
    if source:
        return f"- {source} (chunk {citation.chunk_id}): \"{citation.quote}\""
    return f"- Unknown source (chunk {citation.chunk_id}): \"{citation.quote}\""


def listwise_rerank(
    provider: ChatProvider,
    settings: Settings,
    *,
    query: str,
    candidates: list[RerankCandidate],
    top_k: int,
) -> list[RerankCandidate]:
    if not candidates:
        return []

    candidate_text = "\n\n".join(
        f"ID: {candidate.id}\nSource: {candidate.source or 'unknown'}\nText:\n{candidate.text[:1200]}"
        for candidate in candidates
    )
    messages = [
        ChatMessage(
            role="system",
            content=(
                "You are a listwise reranker. Rank passages by usefulness for answering the query. "
                "Return only JSON shaped as {\"ranked_ids\": [\"id1\", \"id2\"]}."
            ),
        ),
        ChatMessage(
            role="user",
            content=f"Query:\n{query}\n\nCandidates:\n{candidate_text}\n\nReturn the top {top_k} IDs.",
        ),
    ]
    raw = provider.chat(messages, model=settings.rerank_model_id, max_tokens=250, temperature=0.0)
    ranked_ids = _extract_ranked_ids(raw)
    by_id = {candidate.id: candidate for candidate in candidates}
    ranked = [by_id[item_id] for item_id in ranked_ids if item_id in by_id]
    remaining = [candidate for candidate in candidates if candidate.id not in ranked_ids]
    return (ranked + remaining)[:top_k]


def _extract_ranked_ids(text: str) -> list[str]:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    ranked_ids = data.get("ranked_ids", [])
    return [str(item) for item in ranked_ids if isinstance(item, str | int)]
