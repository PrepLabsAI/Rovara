"""A scriptable adapter for deterministic tests of supervision and the conformance harness.

The script lives in `task.engine_config["script"]`: a list of steps, each a
single-key dict:

    {"emit": {...EngineEvent JSON...}}      yield this event
    {"sleep": 1.5}                          sleep (interruptible by cancel)
    {"crash": "message"}                    raise RuntimeError(message)
    {"write_file": {"path": "a.py", "content": "..."}}   write into the workspace
    {"commit": {"branch": "b", "message": "m"}}          git checkout -b + commit -A
"""

import json
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from agentx_schemas import EngineEvent, TaskSpec, WorkspaceInfo, parse_event

from agentx_runner.adapters.base import EngineAdapter


class FakeAdapter(EngineAdapter):
    def __init__(self) -> None:
        self._cancelled = threading.Event()

    def cancel(self) -> None:
        self._cancelled.set()

    def run(self, task: TaskSpec, workspace: WorkspaceInfo) -> Iterator[EngineEvent]:
        script: list[dict[str, Any]] = task.engine_config.get("script", [])
        repo = Path(workspace.repo_path)
        for step in script:
            if self._cancelled.is_set():
                return
            if "emit" in step:
                yield parse_event(json.dumps(step["emit"]))
            elif "sleep" in step:
                deadline = time.monotonic() + float(step["sleep"])
                while time.monotonic() < deadline:
                    if self._cancelled.wait(timeout=0.02):
                        return
            elif "crash" in step:
                raise RuntimeError(str(step["crash"]))
            elif "write_file" in step:
                target = repo / step["write_file"]["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(step["write_file"]["content"])
            elif "commit" in step:
                branch = step["commit"]["branch"]
                message = step["commit"]["message"]
                _git(repo, "checkout", "-b", branch)
                _git(repo, "add", "-A")
                _git(repo, "commit", "-m", message)
            else:
                raise ValueError(f"unknown fake script step: {step}")


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
