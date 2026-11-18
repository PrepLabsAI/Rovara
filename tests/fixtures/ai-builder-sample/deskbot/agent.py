"""The agent: find the policy notes for a question, ask the model with the system prompt, return its text."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Protocol

HERE = Path(__file__).resolve().parent


class ModelClient(Protocol):
    def generate_content(self, contents: list, system_instruction: str | None = ..., generation_config: dict | None = ...) -> str: ...


def load_system_prompt() -> str:
    return (HERE / "prompts" / "system.txt").read_text(encoding="utf-8").strip()


def load_data() -> dict:
    return json.loads((HERE / "data" / "policies.json").read_text(encoding="utf-8"))


def policy_notes(question: str, data: dict) -> str:
    """The notes for a question: policies whose keywords it mentions, and the record of any order it names."""
    lowered = question.lower()
    notes = [p["text"] for p in data["policies"] if any(k in lowered for k in p["keywords"])]
    for order_id in re.findall(r"\border\s+#?(\d+)", lowered):
        record = data["orders"].get(order_id)
        if record is not None:
            notes.append(f"Order {order_id}: status {record['status']}; contact: {record['contact']}")
    return "\n".join(f"- {note}" for note in notes) if notes else "(no notes found)"


class DeskAgent:
    def __init__(self, client: ModelClient, system_prompt: str | None = None, data: dict | None = None) -> None:
        self.client = client
        self.system_prompt = system_prompt if system_prompt is not None else load_system_prompt()
        self.data = data if data is not None else load_data()

    def build_contents(self, question: str) -> list:
        text = f"Policy notes:\n{policy_notes(question, self.data)}\n\nCustomer question: {question.strip()}"
        return [{"role": "user", "parts": [{"text": text}]}]

    def answer(self, question: str) -> str:
        return self.client.generate_content(self.build_contents(question), self.system_prompt, {"temperature": 0})
