from __future__ import annotations

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import EMBEDDING_MODEL_ID
from src.embeddings import embed_texts


def main() -> None:
    vectors = embed_texts(["Meridian Analytics revenue summary", "Key contracts and risks"])
    print(f"model={EMBEDDING_MODEL_ID} shape={vectors.shape}")


if __name__ == "__main__":
    main()
