from __future__ import annotations

import re
from pathlib import Path

import streamlit as st

from src.config import Settings
from src.diligence_agents import answer_with_diligence_supervisor
from src.index_builder import build_index
from src.index_store import load_index
from src.rag import answer_from_index


st.set_page_config(page_title="Data Room Cited", layout="wide")

settings = Settings.from_env()
settings.data_dir.mkdir(parents=True, exist_ok=True)

st.title("Data Room Cited")

if not settings.deepseek_api_key:
    st.warning("Add DEEPSEEK_API_KEY to .env before asking questions.")


def _safe_pdf_name(filename: str) -> str:
    name = Path(filename).name
    safe_name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(" .")
    if not safe_name.lower().endswith(".pdf"):
        raise ValueError(f"{name} is not a PDF file.")
    if not safe_name:
        raise ValueError("PDF filename is empty after sanitizing.")
    return safe_name


def _pdf_files() -> list[Path]:
    return sorted(settings.data_dir.glob("*.pdf"))


def _rebuild_index() -> str:
    progress_slot = st.sidebar.empty()

    def show_progress(message: str) -> None:
        progress_slot.caption(message)

    result = build_index(settings, contextualize=True, progress=show_progress)
    progress_slot.empty()
    message = (
        f"Indexed {result.chunk_count} chunks. "
        f"Generated context for {result.contextualized_count} chunks."
    )
    if result.context_failure_count:
        message += f" {result.context_failure_count} context calls fell back to vanilla embeddings."
    return message


def _save_uploaded_pdfs(uploaded_files) -> list[str]:
    saved_names: list[str] = []
    for uploaded_file in uploaded_files:
        safe_name = _safe_pdf_name(uploaded_file.name)
        destination = settings.data_dir / safe_name
        destination.write_bytes(uploaded_file.getvalue())
        saved_names.append(safe_name)
    return saved_names


def _index_status() -> str:
    try:
        chunks, embeddings = load_index(settings.index_dir)
    except FileNotFoundError:
        return "Index not built"
    except Exception as exc:
        return f"Index unavailable: {exc}"
    return f"{len(chunks)} chunks / {embeddings.shape[0]} vectors"


def _build_sidebar() -> None:
    st.sidebar.header("Reference PDFs")
    if not settings.deepseek_api_key:
        st.sidebar.warning("DEEPSEEK_API_KEY is required to rebuild with generated context.")

    notice = st.session_state.pop("sidebar_notice", None)
    if notice:
        st.sidebar.success(notice)

    uploaded_files = st.sidebar.file_uploader(
        "Add PDFs",
        type=["pdf"],
        accept_multiple_files=True,
    )
    can_rebuild = bool(settings.deepseek_api_key)
    if st.sidebar.button(
        "Add / update PDFs",
        disabled=not uploaded_files or not can_rebuild,
        type="primary",
    ):
        try:
            saved_names = _save_uploaded_pdfs(uploaded_files)
            with st.sidebar:
                with st.spinner("Rebuilding index..."):
                    result_message = _rebuild_index()
            st.sidebar.success(f"Saved {len(saved_names)} PDF(s). {result_message}")
        except Exception as exc:
            st.sidebar.error(str(exc))

    pdf_files = _pdf_files()
    st.sidebar.caption(f"{len(pdf_files)} PDF(s) in data/")
    st.sidebar.caption(_index_status())

    if st.sidebar.button(
        "Rebuild index",
        disabled=not pdf_files or not can_rebuild,
    ):
        try:
            with st.sidebar:
                with st.spinner("Rebuilding index..."):
                    result_message = _rebuild_index()
            st.sidebar.success(result_message)
        except Exception as exc:
            st.sidebar.error(str(exc))

    st.sidebar.divider()
    for pdf_path in pdf_files:
        name_col, remove_col = st.sidebar.columns([0.68, 0.32])
        name_col.caption(pdf_path.name)
        if remove_col.button("Remove", key=f"remove:{pdf_path.name}", disabled=not can_rebuild):
            try:
                pdf_path.unlink()
                with st.sidebar:
                    with st.spinner("Rebuilding index..."):
                        result_message = _rebuild_index()
                st.session_state["sidebar_notice"] = f"Removed {pdf_path.name}. {result_message}"
                st.rerun()
            except Exception as exc:
                st.sidebar.error(str(exc))

    st.sidebar.divider()
    st.sidebar.header("Workflow")
    st.session_state["use_diligence_workflow"] = st.sidebar.checkbox(
        "Use diligence workflow for broad requests",
        value=st.session_state.get("use_diligence_workflow", True),
    )
    st.session_state["show_agent_trace"] = st.sidebar.checkbox(
        "Show agent trace",
        value=st.session_state.get("show_agent_trace", True),
    )


_build_sidebar()

question = st.text_input("Question", placeholder="What are the key risks in the Meridian data room?")

if st.button("Ask", type="primary", disabled=not question or not settings.deepseek_api_key):
    with st.spinner("Reading the data room..."):
        try:
            if st.session_state.get("use_diligence_workflow", True):
                result = answer_with_diligence_supervisor(question, settings)
                answer = result.answer
            else:
                result = None
                answer = answer_from_index(question, settings)
        except Exception as exc:
            st.error(str(exc))
        else:
            st.markdown(answer)
            if result is not None:
                st.caption(
                    f"Route: {result.route} | "
                    f"model calls: {result.model_calls_used} | "
                    f"tool calls: {result.tool_calls_used}"
                )
                if st.session_state.get("show_agent_trace", True) and result.trace:
                    with st.expander("Agent trace"):
                        for event in result.trace:
                            st.text(
                                f"{event.elapsed_seconds:>5.2f}s | {event.agent} | "
                                f"{event.action} | {event.status} | {event.detail}"
                            )
