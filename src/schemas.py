from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


Confidence = Literal["high", "medium", "low", "insufficient"]


class Chunk(BaseModel):
    chunk_id: str = Field(
        description="Stable identifier for this retrieved document chunk. Use this exact value in citations."
    )
    doc: str = Field(description="Source document filename for this chunk.")
    page: int = Field(description="One-based source page number where this chunk begins.")
    page_start: int | None = Field(
        default=None,
        description="One-based first source page included in this chunk.",
    )
    page_end: int | None = Field(
        default=None,
        description="One-based final source page included in this chunk.",
    )
    section_title: str | None = Field(
        default=None,
        description="Nearest detected heading or section title for this chunk.",
    )
    text: str = Field(description="Verbatim source text from the chunk.")
    context: str | None = Field(
        default=None,
        description=(
            "Optional retrieval-only context generated during ingestion. "
            "Use it to understand the chunk, but cite only facts supported by the verbatim text."
        ),
    )

    @property
    def text_for_embedding(self) -> str:
        if self.context:
            return f"{self.context}\n\n{self.text}"
        return self.text

    @property
    def id(self) -> str:
        return self.chunk_id

    @property
    def document(self) -> str:
        return self.doc

    @property
    def start_page(self) -> int:
        return self.page_start or self.page

    @property
    def end_page(self) -> int:
        return self.page_end or self.page

    @property
    def retrieval_text(self) -> str:
        return self.text

    @property
    def source_label(self) -> str:
        pages = (
            f"p.{self.start_page}"
            if self.start_page == self.end_page
            else f"pp.{self.start_page}-{self.end_page}"
        )
        if self.section_title:
            return f"{self.doc} {pages}, {self.section_title}"
        return f"{self.doc} {pages}"


class Citation(BaseModel):
    chunk_id: str = Field(
        description="The chunk_id of the source chunk that directly supports this citation."
    )
    quote: str = Field(
        description="Short exact quote from the source chunk supporting the answer claim."
    )


class Answer(BaseModel):
    answer: str = Field(description="Final answer to the user, grounded only in the provided chunks.")
    citations: list[Citation] = Field(
        default_factory=list,
        description="Citations that support the answer. Each citation must quote text from a cited chunk.",
    )
    confidence: Confidence = Field(
        description=(
            "Confidence in the answer: high, medium, low, or insufficient when the chunks do not answer."
        )
    )


class VerifiedAnswer(BaseModel):
    answer: str = Field(description="Verified final answer returned by the application.")
    citations: list[Citation] = Field(
        default_factory=list,
        description="Citations that were verified against retrieved source chunks."
    )
    confidence: Confidence = Field(description="Final confidence after citation verification.")
    unverified_citations: list[Citation] = Field(
        default_factory=list,
        description="Citations proposed by the LLM that could not be matched to the source chunks."
    )
    retried: bool = Field(
        default=False,
        description="Whether the answer generation was retried after citation verification failed."
    )
