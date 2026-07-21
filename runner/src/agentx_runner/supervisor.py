"""Supervision: wrap an adapter run with the guarantees the control plane relies on.

Invariants (ARCHITECTURE.md layer 4 — "the operational paranoia lives here"):
- The supervised stream always ends with exactly one terminal event
  (`done` or `failed`), no matter what the adapter does.
- Wall-clock timeout, token budget, and external cancellation are enforced
  here, not trusted to the engine.
- Nothing after a terminal event is forwarded.
"""

import queue
import threading
import time
import traceback
from collections.abc import Iterator

from agentx_schemas import EngineEvent, FailedEvent, TaskSpec, WorkspaceInfo, is_terminal

from agentx_runner.adapters.base import EngineAdapter

_LOG_TAIL_CHARS = 4000

# Worker → supervisor queue items: ("event", EngineEvent) | ("error", str) | ("end", None)
_Item = tuple[str, EngineEvent | str | None]


def supervise(
    adapter: EngineAdapter,
    task: TaskSpec,
    workspace: WorkspaceInfo,
    *,
    cancel: threading.Event | None = None,
) -> Iterator[EngineEvent]:
    """Run the adapter, enforcing constraints. Yields a normalized event stream."""
    items: queue.Queue[_Item] = queue.Queue()

    def worker() -> None:
        try:
            for event in adapter.run(task, workspace):
                items.put(("event", event))
        except Exception:
            items.put(("error", traceback.format_exc()))
        else:
            items.put(("end", None))

    thread = threading.Thread(target=worker, name="engine-adapter", daemon=True)
    thread.start()

    deadline = time.monotonic() + task.constraints.timeout_sec
    tokens_used = 0

    while True:
        if cancel is not None and cancel.is_set():
            adapter.cancel()
            yield FailedEvent(reason="cancelled")
            return

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            adapter.cancel()
            yield FailedEvent(reason=f"timeout after {task.constraints.timeout_sec}s")
            return

        try:
            kind, payload = items.get(timeout=min(remaining, 0.1))
        except queue.Empty:
            continue

        if kind == "error":
            log = payload if isinstance(payload, str) else ""
            yield FailedEvent(reason="engine crashed", log=log[-_LOG_TAIL_CHARS:])
            return

        if kind == "end":
            yield FailedEvent(reason="engine finished without a terminal event")
            return

        assert kind == "event" and payload is not None and not isinstance(payload, str)
        event: EngineEvent = payload

        if event.type == "usage":
            tokens_used += event.tokens
            max_tokens = task.constraints.max_tokens
            if max_tokens is not None and tokens_used > max_tokens:
                yield event
                adapter.cancel()
                yield FailedEvent(
                    reason=f"token budget exceeded ({tokens_used}/{max_tokens} tokens)"
                )
                return

        yield event
        if is_terminal(event):
            return
