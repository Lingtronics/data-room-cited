from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import Settings
from src.release_gate import evaluate_release_gate, release_gate_passed


DEFAULT_CASES = Path(__file__).resolve().parents[1] / "evals" / "release_gate_v1.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Data Room Cited release gate.")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument(
        "--fixture",
        action="store_true",
        help="Run against the built-in synthetic fixture. Useful for CI and public repos without private PDFs.",
    )
    parser.add_argument(
        "--skip-external-gates",
        action="store_true",
        help="Skip gates enforced by separate jobs, such as MCP TypeScript contract tests.",
    )
    parser.add_argument(
        "--mcp-contract-passed",
        action="store_true",
        help="Mark the MCP schema/contract gate as passed when this script is run after MCP contract tests.",
    )
    args = parser.parse_args()

    report = evaluate_release_gate(
        args.cases,
        Settings.from_env(),
        fixture=args.fixture,
        skip_external_gates=args.skip_external_gates,
        mcp_contract_passed=args.mcp_contract_passed,
    )
    print(json.dumps(report, indent=2))
    if not release_gate_passed(report):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
