from src.rag import is_broad_question


def test_broad_diligence_questions_route_to_agent_workflow() -> None:
    assert is_broad_question(
        "Assess customer concentration, contractual renewal exposure and evidence gaps."
    )


def test_simple_factual_question_stays_deterministic() -> None:
    assert not is_broad_question("Who is covering the CTO role?")
