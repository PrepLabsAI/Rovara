"""OpenHands Agent SDK adapter (verified against openhands-sdk 1.36.1).

Optional dependency: install with `uv sync --extra openhands`.

Conventions this adapter owns (ARCHITECTURE.md §4 — per-engine tuning lives here):
- Implementation runs happen on a branch `agentx/<task_id>`; the adapter creates
  it, the engine is told never to branch/commit/push, and the adapter commits.
- The engine reports its deliverables by writing `.agentx/result.json`
  (implementation) or `.agentx/spec.md` (planning); the adapter reads and then
  removes `.agentx/` before committing.
- Planning runs (mode=spec without approved_spec) modify nothing: they emit a
  `spec` event and finish with a `done` whose result points at the base branch.
"""

import contextlib
import json
import os
import queue
import shutil
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from agentx_schemas import (
    DoneEvent,
    EngineEvent,
    FailedEvent,
    ProgressEvent,
    SpecEvent,
    TaskResult,
    TaskSpec,
    UsageEvent,
    WorkspaceInfo,
)

from agentx_runner.adapters.base import EngineAdapter

AGENTX_DIR = ".agentx"
RESULT_FILE = f"{AGENTX_DIR}/result.json"
SPEC_FILE = f"{AGENTX_DIR}/spec.md"

_IMPLEMENT_RULES = f"""
# Rules
- Work only inside this repository (the current directory).
- You are already on the correct git branch. Do NOT create branches, do NOT commit, do NOT push.
- Run the project's tests to verify your change. If tests fail, iterate until they pass.
- When you are completely done, write a file `{RESULT_FILE}` containing exactly this JSON:
  {{"summary": "<one-paragraph summary of what you changed and why>",
    "test_evidence": "<the exact test command you ran and its final output>"}}
"""

_PLANNING_RULES = f"""
# Rules
- This is a PLANNING run: do NOT modify any project files. You may read files and run
  the project's tests to understand the current state.
- Write your implementation plan to `{SPEC_FILE}` as markdown. It must cover: the proposed
  approach, the files you would change, the test plan, and — explicitly — any assumptions
  you are making or questions the requester must answer. If the task is ambiguous, calling
  that out is the most important part of the plan.
- `{SPEC_FILE}` is the only file you may create.
"""


class OpenHandsAdapter(EngineAdapter):
    def __init__(self) -> None:
        self._cancelled = threading.Event()
        self._conversation: Any = None

    def cancel(self) -> None:
        self._cancelled.set()
        conversation = self._conversation
        if conversation is not None:
            with contextlib.suppress(Exception):  # best-effort cancel
                conversation.pause()  # thread-safe; takes effect between agent steps

    def run(self, task: TaskSpec, workspace: WorkspaceInfo) -> Iterator[EngineEvent]:
        os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")  # stderr hygiene
        from openhands.sdk import LLM, Agent, Conversation, Tool
        from openhands.sdk.event import ActionEvent, AgentErrorEvent, MessageEvent
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.terminal import TerminalTool

        repo = Path(workspace.repo_path)
        planning = task.mode == "spec" and task.approved_spec is None
        branch = f"agentx/{task.task_id}"

        model = task.constraints.model or os.getenv("LLM_MODEL")
        if not model:
            yield FailedEvent(reason="no model configured (set constraints.model or LLM_MODEL)")
            return

        if not planning:
            _git(repo, "checkout", "-b", branch)

        yield ProgressEvent(
            text=f"Starting OpenHands ({model}) on {'plan' if planning else branch}"
        )

        llm = LLM(model=model, api_key=os.getenv("LLM_API_KEY"), usage_id="agent")
        agent = Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name, params={"terminal_type": "subprocess"}),
                Tool(name=FileEditorTool.name),
            ],
        )

        mapped_events: queue.Queue[EngineEvent] = queue.Queue()
        last_agent_message: list[str] = []

        def on_event(event: Any) -> None:
            if isinstance(event, ActionEvent):
                text = event.summary or f"Using {event.tool_name}"
                mapped_events.put(ProgressEvent(text=str(text)))
            elif isinstance(event, AgentErrorEvent):
                mapped_events.put(ProgressEvent(text=f"Engine error: {event.error}"))
            elif isinstance(event, MessageEvent) and event.source == "agent":
                text = _message_text(event)
                if text:
                    last_agent_message.append(text)
                    mapped_events.put(ProgressEvent(text=text[:500]))

        # Typed as Any: the SDK's decorator-wrapped methods confuse strict mypy
        # (send_message/run surface as Never-argument callables).
        conversation: Any = Conversation(
            agent=agent,
            workspace=str(repo),
            callbacks=[on_event],
            visualizer=None,
            max_iteration_per_run=200,
        )
        self._conversation = conversation

        run_error: list[str] = []

        def run_conversation() -> None:
            try:
                conversation.send_message(_build_prompt(task, planning))
                conversation.run()
            except Exception as exc:  # converted to failed below
                run_error.append(f"{type(exc).__name__}: {exc}")

        thread = threading.Thread(target=run_conversation, name="openhands-run", daemon=True)
        thread.start()

        reported_tokens = 0
        reported_cost = 0.0
        try:
            while thread.is_alive() or not mapped_events.empty():
                with contextlib.suppress(queue.Empty):
                    yield mapped_events.get(timeout=0.25)
                delta = _usage_delta(llm, reported_tokens, reported_cost)
                if delta is not None:
                    reported_tokens += delta.tokens
                    reported_cost += delta.cost_usd
                    yield delta
            thread.join()
        finally:
            with contextlib.suppress(Exception):  # cleanup must not mask the outcome
                conversation.close()

        if self._cancelled.is_set():
            return
        if run_error:
            yield FailedEvent(reason="engine crashed", log=run_error[0])
            return

        status = str(getattr(conversation.state, "execution_status", "unknown"))
        if "finished" not in status.lower():
            yield FailedEvent(reason=f"engine did not finish (status: {status})")
            return

        if planning:
            yield from self._finish_planning(repo, workspace, last_agent_message)
        else:
            yield from self._finish_implementation(repo, branch, last_agent_message)

    def _finish_planning(
        self, repo: Path, workspace: WorkspaceInfo, last_agent_message: list[str]
    ) -> Iterator[EngineEvent]:
        spec_path = repo / SPEC_FILE
        spec_md = spec_path.read_text() if spec_path.is_file() else ""
        if not spec_md and last_agent_message:
            spec_md = last_agent_message[-1]
        _remove_agentx_dir(repo)
        if not spec_md.strip():
            yield FailedEvent(reason="planning run produced no spec")
            return
        yield SpecEvent(markdown=spec_md)
        yield DoneEvent(
            result=TaskResult(
                branch=workspace.base_branch,
                summary="planning run — spec produced, awaiting approval",
                test_evidence="n/a (planning run)",
            )
        )

    def _finish_implementation(
        self, repo: Path, branch: str, last_agent_message: list[str]
    ) -> Iterator[EngineEvent]:
        summary, test_evidence = _read_result_file(repo)
        if not summary:
            summary = last_agent_message[-1][:2000] if last_agent_message else "changes committed"
        _remove_agentx_dir(repo)

        porcelain = _git_out(repo, "status", "--porcelain")
        if not porcelain.strip():
            yield FailedEvent(reason="engine finished but produced no changes")
            return
        _git(repo, "add", "-A")
        _git(repo, "commit", "-m", f"AgentX: {summary.splitlines()[0][:120]}")
        yield DoneEvent(
            result=TaskResult(branch=branch, summary=summary, test_evidence=test_evidence)
        )


def _build_prompt(task: TaskSpec, planning: bool) -> str:
    parts = [
        "You are AgentX, an autonomous coding agent working in a git repository "
        "(the current working directory).",
        f"# Task\n{task.instructions}",
    ]
    if task.approved_spec is not None:
        parts.append(
            "# Approved implementation plan\n"
            f"{task.approved_spec}\n\n"
            "Follow this plan. Deviate only if the code contradicts it, and record any "
            "deviation in your summary."
        )
    parts.append(_PLANNING_RULES if planning else _IMPLEMENT_RULES)
    return "\n\n".join(parts)


def _message_text(event: Any) -> str:
    try:
        chunks = [getattr(item, "text", "") for item in event.llm_message.content]
        return "\n".join(chunk for chunk in chunks if chunk).strip()
    except Exception:
        return ""


def _usage_delta(llm: Any, reported_tokens: int, reported_cost: float) -> UsageEvent | None:
    try:
        usage = llm.metrics.accumulated_token_usage
        total = int(usage.prompt_tokens or 0) + int(usage.completion_tokens or 0)
        cost = float(llm.metrics.accumulated_cost or 0.0)
    except Exception:
        return None
    if total <= reported_tokens:
        return None
    return UsageEvent(tokens=total - reported_tokens, cost_usd=max(cost - reported_cost, 0.0))


def _read_result_file(repo: Path) -> tuple[str, str]:
    path = repo / RESULT_FILE
    if not path.is_file():
        return "", ""
    try:
        data = json.loads(path.read_text())
        return str(data.get("summary", "")), str(data.get("test_evidence", ""))
    except (json.JSONDecodeError, OSError):
        return "", ""


def _remove_agentx_dir(repo: Path) -> None:
    target = repo / AGENTX_DIR
    if target.is_dir():
        shutil.rmtree(target)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _git_out(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout
