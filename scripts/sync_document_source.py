from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import Settings
from src.document_sources import default_access_context, source_from_settings, sync_document_source
from src.index_builder import build_index


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync PDFs from the configured document source.")
    parser.add_argument(
        "--rebuild-index",
        action="store_true",
        help="Rebuild the local RAG index after syncing source documents.",
    )
    parser.add_argument(
        "--contextualize",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Override contextual retrieval during the optional rebuild.",
    )
    args = parser.parse_args()

    settings = Settings.from_env()
    source = source_from_settings(settings)
    result = sync_document_source(
        source,
        destination_dir=settings.data_dir,
        manifest_path=settings.source_manifest_path,
        context=default_access_context(settings),
    )
    output = {"sync": result.model_dump(mode="json")}
    if args.rebuild_index:
        build_result = build_index(settings, contextualize=args.contextualize)
        output["index"] = {
            "chunk_count": build_result.chunk_count,
            "embedding_shape": build_result.embedding_shape,
            "catalogue_asset_count": build_result.catalogue_asset_count,
            "graph_node_count": build_result.graph_node_count,
            "graph_edge_count": build_result.graph_edge_count,
        }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
