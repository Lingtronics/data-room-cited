from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
import os

sys.path.append(str(Path(__file__).resolve().parents[1]))

from src.config import LLM_BASE_URL, LLM_MODEL_ID


def main() -> None:
    load_dotenv()
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise SystemExit("DEEPSEEK_API_KEY is not set. Add it to .env first.")
    response = OpenAI(api_key=api_key, base_url=LLM_BASE_URL).chat.completions.create(
        model=LLM_MODEL_ID,
        max_tokens=10,
        messages=[{"role": "user", "content": "hi"}],
    )
    print(response.choices[0].message.content)


if __name__ == "__main__":
    main()
