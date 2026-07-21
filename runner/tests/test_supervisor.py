"""Supervision invariants, exercised deterministically via FakeAdapter."""

import threading
from typing import Any

from agentx_runner.adapters.fake import FakeAdapter
from agentx_runner.supervisor import supervise
from agentx_schemas import EngineEvent, TaskConstraints, TaskSpec, WorkspaceInfo

WS = WorkspaceInfo(repo_path="/tmp/unused", base_branch="main")

DONE = {
    "type": "done",
    "result": {"branch": "b", "summary": "s", "test_evidence": "t"},
}


def run_script(
    script: list[dict[str, Any]],
    *,
    timeout_sec: int = 30,
    max_tokens: int | None = None,
    cancel: threading.Event | None = None,
) -> list[EngineEvent]:
    task = TaskSpec(
        task_id="t1",
        mode="quick",
        instructions="x",
        engine="fake",
        engine_config={"script": script},
        constraints=TaskConstraints(timeout_sec=timeout_sec, max_tokens=max_tokens),
    )
    return list(supervise(FakeAdapter(), task, WS, cancel=cancel))


def test_happy_path_preserves_order_and_ends_with_done() -> None:
    events = run_script(
        [
            {"emit": {"type": "progress", "text": "working"}},
            {"emit": DONE},
        ]
    )
    assert [e.type for e in events] == ["progress", "done"]


def test_crash_becomes_failed_with_traceback_tail() -> None:
    events = run_script([{"crash": "boom"}])
    assert [e.type for e in events] == ["failed"]
    assert events[0].reason == "engine crashed"
    assert "boom" in events[0].log


def test_missing_terminal_event_becomes_failed() -> None:
    events = run_script([{"emit": {"type": "progress", "text": "hi"}}])
    assert [e.type for e in events] == ["progress", "failed"]
    assert "without a terminal event" in events[-1].reason


def test_timeout_enforced() -> None:
    events = run_script([{"sleep": 30}, {"emit": DONE}], timeout_sec=1)
    assert [e.type for e in events] == ["failed"]
    assert "timeout" in events[0].reason


def test_token_budget_enforced() -> None:
    events = run_script(
        [
            {"emit": {"type": "usage", "tokens": 60, "cost_usd": 0.01}},
            {"emit": {"type": "usage", "tokens": 60, "cost_usd": 0.01}},
            {"emit": DONE},
        ],
        max_tokens=100,
    )
    assert [e.type for e in events] == ["usage", "usage", "failed"]
    assert "token budget exceeded (120/100" in events[-1].reason


def test_under_budget_is_not_cut_off() -> None:
    events = run_script(
        [
            {"emit": {"type": "usage", "tokens": 60, "cost_usd": 0.01}},
            {"emit": DONE},
        ],
        max_tokens=100,
    )
    assert [e.type for e in events] == ["usage", "done"]


def test_external_cancel() -> None:
    cancel = threading.Event()
    cancel.set()  # pre-cancelled: supervision must bail before doing work
    events = run_script([{"sleep": 30}, {"emit": DONE}], cancel=cancel)
    assert [e.type for e in events] == ["failed"]
    assert events[0].reason == "cancelled"


def test_events_after_terminal_are_dropped() -> None:
    events = run_script(
        [
            {"emit": DONE},
            {"emit": {"type": "progress", "text": "zombie"}},
        ]
    )
    assert [e.type for e in events] == ["done"]


def test_stream_always_has_exactly_one_terminal() -> None:
    scripts: list[list[dict[str, Any]]] = [
        [{"emit": DONE}],
        [{"crash": "x"}],
        [],
        [{"emit": {"type": "failed", "reason": "engine says no"}}],
    ]
    for script in scripts:
        events = run_script(script)
        terminals = [e for e in events if e.type in ("done", "failed")]
        assert len(terminals) == 1, script
        assert events[-1] is terminals[0], script
