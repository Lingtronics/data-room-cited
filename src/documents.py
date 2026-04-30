from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import pdfplumber

from src.schemas import Chunk


LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class TextBlock:
    page: int
    text: str
    section_title: str | None
    is_heading: bool = False

    @property
    def token_count(self) -> int:
        return _token_count(self.text)


def load_pdf_chunks(data_dir: Path, *, chunk_chars: int, chunk_overlap: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    target_tokens = max(120, chunk_chars // 4)
    overlap_tokens = max(0, chunk_overlap // 4)
    for pdf_path in sorted(data_dir.glob("*.pdf")):
        document_chunks = _load_one_pdf(
            pdf_path,
            target_tokens=target_tokens,
            overlap_tokens=overlap_tokens,
        )
        if not document_chunks:
            LOGGER.warning(
                "%s produced 0 chunks. If this is an image-only or scanned PDF, run OCR first.",
                pdf_path.name,
            )
        chunks.extend(document_chunks)
    return chunks


def _load_one_pdf(pdf_path: Path, *, target_tokens: int, overlap_tokens: int) -> list[Chunk]:
    blocks = _extract_blocks(pdf_path)
    document_chunks: list[Chunk] = []
    current: list[TextBlock] = []
    current_tokens = 0
    chunk_index = 0

    for block in blocks:
        should_flush = (
            current
            and not block.is_heading
            and current_tokens + block.token_count > target_tokens
        )
        if should_flush:
            document_chunks.append(_make_chunk(pdf_path, chunk_index, current))
            chunk_index += 1
            current = _overlap_blocks(current, overlap_tokens)
            current_tokens = sum(item.token_count for item in current)

        if block.is_heading and current and current_tokens >= target_tokens // 2:
            document_chunks.append(_make_chunk(pdf_path, chunk_index, current))
            chunk_index += 1
            current = []
            current_tokens = 0

        current.append(block)
        current_tokens += block.token_count

    if current:
        document_chunks.append(_make_chunk(pdf_path, chunk_index, current))
    return document_chunks


def _extract_blocks(pdf_path: Path) -> list[TextBlock]:
    blocks: list[TextBlock] = []
    current_section: str | None = None
    with pdfplumber.open(pdf_path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = (page.extract_text() or "").strip()
            if not text:
                continue
            for paragraph in _paragraphs(text):
                is_heading = _is_heading(paragraph)
                if is_heading:
                    current_section = paragraph
                blocks.append(
                    TextBlock(
                        page=page_number,
                        text=paragraph,
                        section_title=current_section,
                        is_heading=is_heading,
                    )
                )
    return blocks


def _paragraphs(text: str) -> list[str]:
    lines = [line.strip() for line in text.splitlines()]
    paragraphs: list[str] = []
    current: list[str] = []

    for line in lines:
        if not line:
            if current:
                paragraphs.append(_join_lines(current))
                current = []
            continue
        if current and _is_heading(line):
            paragraphs.append(_join_lines(current))
            current = []
        current.append(line)
        if _ends_paragraph(line):
            paragraphs.append(_join_lines(current))
            current = []

    if current:
        paragraphs.append(_join_lines(current))
    return [paragraph for paragraph in paragraphs if paragraph]


def _join_lines(lines: list[str]) -> str:
    return " ".join(lines).strip()


def _ends_paragraph(line: str) -> bool:
    if _is_heading(line):
        return True
    return line.endswith((".", "?", "!", ":", ";"))


def _is_heading(text: str) -> bool:
    stripped = text.strip()
    if not stripped or len(stripped) > 140:
        return False
    if _looks_like_table_row(stripped):
        return False
    if re.match(r"^(\d+(\.\d+)*[\).]|[A-Z][\).])\s+[A-Z]", stripped):
        return True
    if re.match(r"^(Section|Schedule|Appendix|Exhibit|Table)\s+[\w\d]", stripped, flags=re.I):
        return True
    words = re.findall(r"[A-Za-z][A-Za-z&/-]*", stripped)
    if 2 <= len(words) <= 12 and not stripped.endswith((".", ",", ";")):
        title_like = sum(1 for word in words if word[:1].isupper())
        return title_like / len(words) >= 0.65
    return False


def _looks_like_table_row(text: str) -> bool:
    if re.search(r"\bFY20\d{2}\b", text):
        return True
    if "\u0141" in text or "\u00a3" in text or "$" in text:
        return True
    numeric_cells = re.findall(r"\b\d+(?:\.\d+)?%?\b", text)
    return len(numeric_cells) >= 2


def _make_chunk(pdf_path: Path, chunk_index: int, blocks: list[TextBlock]) -> Chunk:
    text = "\n\n".join(block.text for block in blocks).strip()
    page_start = min(block.page for block in blocks)
    page_end = max(block.page for block in blocks)
    section_title = _section_title_for(blocks)
    return Chunk(
        chunk_id=f"{pdf_path.stem}-{chunk_index:04d}",
        doc=pdf_path.name,
        page=page_start,
        page_start=page_start,
        page_end=page_end,
        section_title=section_title,
        text=text,
    )


def _section_title_for(blocks: list[TextBlock]) -> str | None:
    for block in reversed(blocks):
        if block.section_title:
            return block.section_title
    return None


def _overlap_blocks(blocks: list[TextBlock], overlap_tokens: int) -> list[TextBlock]:
    if overlap_tokens <= 0:
        return []
    selected: list[TextBlock] = []
    total = 0
    for block in reversed(blocks):
        if block.is_heading and selected:
            selected.append(block)
            break
        selected.append(block)
        total += block.token_count
        if total >= overlap_tokens:
            break
    return list(reversed(selected))


def _token_count(text: str) -> int:
    return len(re.findall(r"\w+|[^\w\s]", text))
