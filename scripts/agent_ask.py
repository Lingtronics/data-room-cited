from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.agent import answer_with_tools
from src.config import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Ask the data room through the tool-calling agent loop.")
    parser.add_argument("question")
    parser.add_argument("--max-tool-turns", type=int, default=None)
    args = parser.parse_args()
    print(
        answer_with_tools(
            args.question,
            Settings.from_env(),
            max_tool_turns=args.max_tool_turns,
        )
    )


if __name__ == "__main__":
    main()
