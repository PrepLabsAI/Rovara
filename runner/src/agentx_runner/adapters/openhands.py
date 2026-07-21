"""OpenHands Agent SDK adapter. Implementation in progress (PLAN.md Phase 1).

The OpenHands SDK is an optional dependency: install with
`uv sync --extra openhands` (see runner/pyproject.toml).
"""

from collections.abc import Iterator

from agentx_schemas import EngineEvent, TaskSpec, WorkspaceInfo

from agentx_runner.adapters.base import EngineAdapter


class OpenHandsAdapter(EngineAdapter):
    def run(self, task: TaskSpec, workspace: WorkspaceInfo) -> Iterator[EngineEvent]:
        raise NotImplementedError("OpenHandsAdapter is not implemented yet (Phase 1, in progress)")
