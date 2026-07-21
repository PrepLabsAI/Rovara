"""The engine seam: one adapter per coding-agent harness (ARCHITECTURE.md §4)."""

from abc import ABC, abstractmethod
from collections.abc import Iterator

from agentx_schemas import EngineEvent, TaskSpec, WorkspaceInfo


class EngineAdapter(ABC):
    """Translates one engine invocation into the normalized event stream.

    Contract:
    - `run` is a generator: yield events as work progresses and finish by
      yielding exactly one terminal event (`done` or `failed`). Raising an
      exception or returning without a terminal event is tolerated — the
      supervisor converts both into a `failed` event — but is a bug.
    - The deliverable of a successful run is a **local branch** in the
      workspace repo; the adapter never pushes and never sees credentials.
    - `cancel` is called from another thread (timeout/budget/SIGTERM). It must
      be safe to call at any time and should make `run` wind down promptly.
    """

    @abstractmethod
    def run(self, task: TaskSpec, workspace: WorkspaceInfo) -> Iterator[EngineEvent]: ...

    def cancel(self) -> None:  # noqa: B027 - deliberately optional override
        """Best-effort stop; default is a no-op for adapters that poll nothing."""
