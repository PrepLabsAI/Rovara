"""The rule judge: one case, one answer, pass or fail. No model is used to grade."""
from __future__ import annotations


def judge(case: dict, answer: str) -> bool:
    text = answer.lower()
    return all(s.lower() in text for s in case.get("must_contain", [])) and not any(s.lower() in text for s in case.get("must_not_contain", []))
