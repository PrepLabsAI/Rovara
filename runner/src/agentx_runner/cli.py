"""`agentx-runner --task task.json --repo /path/to/repo [--base-branch main]`

Emits the normalized EngineEvent stream as JSONL on stdout (one event per line;
logs go to stderr) and always ends with exactly one terminal event — even for
runner-level errors like a bad task file or unknown engine, so the control
plane has a single code path.

Exit codes: 0 = done, 1 = failed, 2 = runner-level error (also emits `failed`).
"""

import argparse
import signal
import sys
import threading
from pathlib import Path
from types import FrameType

from agentx_schemas import EngineEvent, FailedEvent, TaskSpec, WorkspaceInfo, dump_event

from agentx_runner.adapters import create_adapter
from agentx_runner.supervisor import supervise


def _emit(event: EngineEvent) -> None:
    print(dump_event(event), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentx-runner")
    parser.add_argument("--task", required=True, help="Path to a TaskSpec JSON file")
    parser.add_argument("--repo", required=True, help="Path to the cloned repo (workspace)")
    parser.add_argument("--base-branch", default="main", help="Branch the task branches from")
    args = parser.parse_args(argv)

    try:
        task = TaskSpec.model_validate_json(Path(args.task).read_text())
        repo = Path(args.repo)
        if not repo.is_dir():
            raise FileNotFoundError(f"workspace repo not found: {repo}")
        workspace = WorkspaceInfo(repo_path=str(repo.resolve()), base_branch=args.base_branch)
        adapter = create_adapter(task.engine)
    except Exception as exc:
        _emit(FailedEvent(reason=f"runner error: {exc}"))
        return 2

    cancel = threading.Event()

    def handle_signal(signum: int, frame: FrameType | None) -> None:
        print(f"agentx-runner: received signal {signum}, cancelling", file=sys.stderr)
        cancel.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    exit_code = 1
    for event in supervise(adapter, task, workspace, cancel=cancel):
        _emit(event)
        if event.type == "done":
            exit_code = 0
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
