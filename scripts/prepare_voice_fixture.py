from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.voice_fixture import prepare


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Copy the approved synthetic voice fixture into a NEW directory.")
    parser.add_argument("--destination", type=Path, default=Path(".voice-demo"))
    args = parser.parse_args()
    prepare(args.destination.resolve())
    print("Prepared synthetic fixture. No services started; no external credentials used.")
