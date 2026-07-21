"""Round-trip and validation tests for the wire schemas."""

import json

import pytest
from agentx_schemas import (
    SCHEMA_VERSION,
    ApprovalRequestEvent,
    DoneEvent,
    EngineEvent,
    FailedEvent,
    ProgressEvent,
    SpecEvent,
    TaskConstraints,
    TaskResult,
    TaskSpec,
    UsageEvent,
    dump_event,
    is_terminal,
    parse_event,
)
from pydantic import ValidationError

RESULT = TaskResult(
    branch="agentx/task-42",
    summary="Fixed the average() bug",
    test_evidence="$ pytest -q\n2 passed",
)

ALL_EVENTS: list[EngineEvent] = [
    ProgressEvent(text="Cloning repo"),
    SpecEvent(markdown="## Plan\n1. Fix it"),
    ApprovalRequestEvent(request_id="apr-1", action="Run database migration"),
    UsageEvent(tokens=1234, cost_usd=0.05),
    DoneEvent(result=RESULT),
    FailedEvent(reason="tests failed", log="E   assert 1 == 2"),
]


@pytest.mark.parametrize("event", ALL_EVENTS, ids=lambda e: e.type)
def test_event_round_trip(event: EngineEvent) -> None:
    line = dump_event(event)
    assert "\n" not in line  # one event per JSONL line
    assert parse_event(line) == event


def test_unknown_event_type_rejected() -> None:
    with pytest.raises(ValidationError):
        parse_event(json.dumps({"type": "telemetry", "data": 1}))


def test_extra_fields_rejected() -> None:
    with pytest.raises(ValidationError):
        parse_event(json.dumps({"type": "progress", "text": "hi", "color": "red"}))


def test_terminal_classification() -> None:
    terminal = {e.type for e in ALL_EVENTS if is_terminal(e)}
    assert terminal == {"done", "failed"}


def test_task_spec_round_trip_and_defaults() -> None:
    spec = TaskSpec(
        task_id="task-42",
        mode="quick",
        instructions="Fix the failing test",
        constraints=TaskConstraints(timeout_sec=1800),
    )
    assert spec.schema_version == SCHEMA_VERSION
    assert spec.engine == "openhands"
    assert spec.engine_config == {}
    assert spec.approved_spec is None

    restored = TaskSpec.model_validate_json(spec.model_dump_json())
    assert restored == spec


def test_task_spec_rejects_bad_mode_and_extras() -> None:
    base = {
        "task_id": "t",
        "mode": "quick",
        "instructions": "x",
        "constraints": {"timeout_sec": 60},
    }
    with pytest.raises(ValidationError):
        TaskSpec.model_validate({**base, "mode": "yolo"})
    with pytest.raises(ValidationError):
        TaskSpec.model_validate({**base, "surprise": True})


def test_constraints_bounds() -> None:
    with pytest.raises(ValidationError):
        TaskConstraints(timeout_sec=0)
    with pytest.raises(ValidationError):
        TaskConstraints(timeout_sec=60, max_tokens=0)


def test_done_event_wire_shape() -> None:
    """The wire format is part of the contract — pin the exact JSON shape."""
    payload = json.loads(dump_event(DoneEvent(result=RESULT)))
    assert payload == {
        "type": "done",
        "result": {
            "branch": "agentx/task-42",
            "summary": "Fixed the average() bug",
            "test_evidence": "$ pytest -q\n2 passed",
        },
    }
