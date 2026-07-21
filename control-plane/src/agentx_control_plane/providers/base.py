"""WorkspaceProvider — the seam between the control plane and RDE substrates.

ARCHITECTURE.md §9: the same interface fronts LocalDockerProvider (dev),
FargateProvider and CodeBuildSandboxProvider (prod, Phase 6). The contract:

- `provision(repo_source, ref)` builds a sandbox around a clone of the repo and
  returns a `Workspace`. `repo_path` is a control-plane-visible path to that
  clone: after `exec_runner` finishes, the result branch must exist there so the
  control plane can push it (the engine never holds push credentials).
- `exec_runner(ws, task)` runs the agentx-runner inside the sandbox and yields
  the runner's `EngineEvent` stream. Secrets (LLM keys) travel only through the
  exec environment — they must never be written into the workspace filesystem.
- `teardown(ws)` destroys the sandbox and all local state. It must be safe to
  call twice and after partial provisioning.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from agentx_schemas import EngineEvent, TaskSpec


class ProvisionError(RuntimeError):
    """Sandbox could not be provisioned (docker down, image build failed, ...)."""


@dataclass
class Workspace:
    workspace_id: str
    repo_path: Path
    """Control-plane-visible path to the clone (bind-mounted into the sandbox)."""
    base_branch: str
    provider: str
    notes: list[str] = field(default_factory=list)
    """Human-readable provisioning notes, e.g. 'no devcontainer — inferred python image'."""
    metadata: dict[str, str] = field(default_factory=dict)
    """Provider-private state (container ids, network names, workdir)."""


class WorkspaceProvider(ABC):
    @abstractmethod
    def provision(self, repo_source: str, ref: str) -> Workspace:
        """Clone `repo_source` at `ref` and stand up a sandbox around it."""

    @abstractmethod
    def exec_runner(self, ws: Workspace, task: TaskSpec) -> Iterator[EngineEvent]:
        """Run agentx-runner inside the sandbox; yield its event stream.

        Must always end with exactly one terminal event (the runner guarantees
        this for its own stream; the provider adds a `failed` terminal for
        sandbox-level faults: exec failure, hard-timeout kill, unparseable output).
        """

    @abstractmethod
    def teardown(self, ws: Workspace) -> None:
        """Destroy the sandbox. Idempotent; must tolerate partial provisioning."""
