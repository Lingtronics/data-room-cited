from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import Settings
from src.index_builder import build_index


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    parser = argparse.ArgumentParser(description="Build a local vector index from PDFs in data/.")
    parser.add_argument(
        "--contextualize",
        action="store_true",
        default=None,
        help="Use DeepSeek to write retrieval context for each chunk before embedding.",
    )
    parser.add_argument(
        "--no-contextualize",
        action="store_false",
        dest="contextualize",
        help="Skip DeepSeek retrieval context generation even if enabled in .env.",
    )
    args = parser.parse_args()

    settings = Settings.from_env()
    result = build_index(
        settings,
        contextualize=args.contextualize,
        progress=print,
    )
    print(f"indexed {result.chunk_count} chunks into {settings.index_dir}")


if __name__ == "__main__":
    main()
