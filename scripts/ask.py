from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import Settings
from src.rag import answer_from_index


def main() -> None:
    parser = argparse.ArgumentParser(description="Ask the indexed data room a question.")
    parser.add_argument("question")
    args = parser.parse_args()
    print(answer_from_index(args.question, Settings.from_env()))


if __name__ == "__main__":
    main()
