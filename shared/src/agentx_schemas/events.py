"""Engine events: the normalized JSONL stream from agentx-runner to the control plane.

One JSON object per line. The event set is deliberately small (ARCHITECTURE.md §4):
adding an event type is a protocol change that every adapter must handle, so
engine-specific richness gets flattened into `progress` rather than leaking upward.
"""

import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from agentx_schemas.task import TaskResult


class ProgressEvent(BaseModel):
    """Human-readable status; relayed (throttled) to the Slack thread."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["progress"] = "progress"
    text: str


class SpecEvent(BaseModel):
    """Spec-mode plan awaiting human approval. Markdown; rendered, never parsed."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["spec"] = "spec"
    markdown: str


class ApprovalRequestEvent(BaseModel):
    """Mid-run gate: the engine wants to perform a risky action and is blocked until a reply."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["approval_request"] = "approval_request"
    request_id: str
    action: str = Field(description="Human-readable description of the action needing approval")


class UsageEvent(BaseModel):
    """Token/cost accounting increment."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["usage"] = "usage"
    tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0)


class DoneEvent(BaseModel):
    """Terminal success: the deliverable is a local branch plus summary and test evidence."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["done"] = "done"
    result: TaskResult


class FailedEvent(BaseModel):
    """Terminal failure: reason plus log tail, posted to the thread verbatim."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["failed"] = "failed"
    reason: str
    log: str = ""


EngineEvent = Annotated[
    ProgressEvent | SpecEvent | ApprovalRequestEvent | UsageEvent | DoneEvent | FailedEvent,
    Field(discriminator="type"),
]

TERMINAL_EVENT_TYPES: frozenset[str] = frozenset({"done", "failed"})

_event_adapter: TypeAdapter[EngineEvent] = TypeAdapter(EngineEvent)


def is_terminal(event: EngineEvent) -> bool:
    """True if no further events may follow this one."""
    return event.type in TERMINAL_EVENT_TYPES


def dump_event(event: EngineEvent) -> str:
    """Serialize an event to one JSONL line (no trailing newline)."""
    return json.dumps(_event_adapter.dump_python(event, mode="json"), separators=(",", ":"))


def parse_event(line: str) -> EngineEvent:
    """Parse one JSONL line into a typed event. Raises pydantic.ValidationError on bad input."""
    return _event_adapter.validate_json(line)
