from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import Settings
from src.agent import answer_with_tools
from src.diligence_agents import answer_with_diligence_supervisor, format_multi_agent_result
from src.rag import answer_from_index


def main() -> None:
    parser = argparse.ArgumentParser(description="Ask the data room through an agent workflow.")
    parser.add_argument("question")
    parser.add_argument(
        "--workflow",
        choices=["auto", "deterministic", "multi-agent", "legacy-tools"],
        default="auto",
        help="auto routes broad diligence requests to the multi-agent workflow.",
    )
    parser.add_argument("--max-tool-turns", type=int, default=None)
    parser.add_argument(
        "--approve-export",
        action="store_true",
        help="Allow the report builder to write a Markdown export when the question asks for one.",
    )
    parser.add_argument("--hide-trace", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    if args.workflow == "legacy-tools":
        print(answer_with_tools(args.question, settings, max_tool_turns=args.max_tool_turns))
        return
    if args.workflow == "deterministic":
        print(answer_from_index(args.question, settings))
        return
    result = answer_with_diligence_supervisor(
        args.question,
        settings,
        force_multi_agent=args.workflow == "multi-agent",
        allow_export=args.approve_export,
    )
    print(format_multi_agent_result(result, include_trace=not args.hide_trace))


if __name__ == "__main__":
    main()
