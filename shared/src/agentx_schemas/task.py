"""Task-side wire schemas: what the control plane hands to the runner, and what comes back.

These models are the contract between the control plane and `agentx-runner`
(ARCHITECTURE.md §4). Breaking changes require bumping SCHEMA_VERSION.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1

TaskMode = Literal["quick", "spec"]


class TaskConstraints(BaseModel):
    """Hard limits the runner enforces on an engine invocation."""

    model_config = ConfigDict(extra="forbid")

    timeout_sec: int = Field(gt=0, description="Wall-clock limit for the whole invocation")
    max_tokens: int | None = Field(default=None, gt=0, description="Token budget; None = no cap")
    model: str | None = Field(
        default=None, description="LLM identifier (LiteLLM-style); None = engine default"
    )


class TaskSpec(BaseModel):
    """One engine invocation: plan (spec mode, no approved_spec), implement, or fix round."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = SCHEMA_VERSION
    task_id: str = Field(description="Control-plane task ID; used for correlation and cancel")
    mode: TaskMode
    instructions: str = Field(description="User's request plus relevant thread context")
    approved_spec: str | None = Field(
        default=None,
        description="Spec mode only: the human-approved plan for the implementation run",
    )
    constraints: TaskConstraints
    engine: str = Field(default="openhands", description="Adapter to load in the runner")
    engine_config: dict[str, Any] = Field(
        default_factory=dict,
        description="Opaque per-engine passthrough; never interpreted by the control plane",
    )


class TaskResult(BaseModel):
    """The engine's deliverable. The engine's job ends at a local branch (ARCHITECTURE.md §4)."""

    model_config = ConfigDict(extra="forbid")

    branch: str = Field(description="Local branch containing the committed change")
    summary: str = Field(description="Human-readable change summary; becomes the PR description")
    test_evidence: str = Field(description="Test command(s) and output proving the change works")


class WorkspaceInfo(BaseModel):
    """Where the repo lives inside the sandbox, as provisioned by a WorkspaceProvider."""

    model_config = ConfigDict(extra="forbid")

    repo_path: str = Field(description="Absolute path of the cloned repo inside the sandbox")
    base_branch: str = Field(description="Branch the task branches from (usually the default)")
