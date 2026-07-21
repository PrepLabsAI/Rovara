"""Materialize a fixture into a fresh git repo, run the task through the runner
CLI (subprocess — same path the provisioner uses), and apply the oracle.

Statuses:
- PASS   — terminal `done` and the oracle accepted the produced branch
- FAIL   — runner failed, no branch, or the oracle rejected it
- REVIEW — spec_review oracle: the spec was captured for human/LLM judging
"""

import json
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentx_schemas import EngineEvent, TaskConstraints, TaskSpec, parse_event

ORACLE_DIR = "oracle"

# Never copied when materializing workspaces or oracle tests — fixture dirs
# accumulate these when run locally, and real repos contain junk too.
_IGNORED_NAMES = {"__pycache__", ".pytest_cache", ".git", ".mypy_cache", ".ruff_cache"}


@dataclass
class Fixture:
    name: str
    path: Path
    mode: str
    instructions: str
    oracle: dict[str, Any]


@dataclass
class FixtureOutcome:
    fixture: str
    status: str  # PASS | FAIL | REVIEW
    detail: str
    events: list[EngineEvent] = field(default_factory=list)
    spec_markdown: str | None = None


def load_fixture(path: Path) -> Fixture:
    manifest = json.loads((path / "task.json").read_text())
    return Fixture(
        name=manifest["name"],
        path=path,
        mode=manifest["mode"],
        instructions=manifest["instructions"],
        oracle=manifest["oracle"],
    )


def discover_fixtures(fixtures_dir: Path) -> list[Fixture]:
    return [
        load_fixture(child)
        for child in sorted(fixtures_dir.iterdir())
        if (child / "task.json").is_file()
    ]


def materialize_workspace(fixture: Fixture, dest: Path) -> None:
    """Copy fixture files (minus manifest and hidden oracle) into a fresh git repo on main."""
    for item in fixture.path.iterdir():
        if item.name in ("task.json", ORACLE_DIR) or item.name in _IGNORED_NAMES:
            continue
        if item.is_dir():
            shutil.copytree(
                item, dest / item.name, ignore=shutil.ignore_patterns(*_IGNORED_NAMES)
            )
        else:
            shutil.copy2(item, dest / item.name)
    _git(dest, "init", "-q", "-b", "main")
    _git(dest, "config", "user.email", "conformance@agentx.local")
    _git(dest, "config", "user.name", "AgentX Conformance")
    _git(dest, "add", "-A")
    _git(dest, "commit", "-q", "-m", "fixture baseline")


def run_fixture(
    fixture: Fixture,
    *,
    engine: str,
    model: str | None,
    timeout_sec: int,
    engine_config: dict[str, Any] | None = None,
) -> FixtureOutcome:
    with tempfile.TemporaryDirectory(prefix=f"agentx-conf-{fixture.name}-") as tmp:
        tmp_path = Path(tmp)
        repo = tmp_path / "repo"
        repo.mkdir()
        materialize_workspace(fixture, repo)

        task = TaskSpec(
            task_id=f"conformance-{fixture.name}",
            mode=fixture.mode,  # type: ignore[arg-type]
            instructions=fixture.instructions,
            engine=engine,
            engine_config=engine_config or {},
            constraints=TaskConstraints(timeout_sec=timeout_sec, model=model),
        )
        task_file = tmp_path / "task.json"
        task_file.write_text(task.model_dump_json())

        proc = subprocess.run(
            [
                sys.executable,
                "-m",
                "agentx_runner.cli",
                "--task",
                str(task_file),
                "--repo",
                str(repo),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec + 60,  # runner enforces its own timeout; this is a backstop
        )
        events = [parse_event(line) for line in proc.stdout.splitlines() if line.strip()]
        return _grade(fixture, repo, events, runner_stderr=proc.stderr)


def _grade(
    fixture: Fixture, repo: Path, events: list[EngineEvent], runner_stderr: str
) -> FixtureOutcome:
    terminal = events[-1] if events else None

    if fixture.oracle["type"] == "spec_review":
        specs = [e for e in events if e.type == "spec"]
        if not specs:
            return FixtureOutcome(fixture.name, "FAIL", "spec mode emitted no spec event", events)
        return FixtureOutcome(
            fixture.name,
            "REVIEW",
            f"spec captured ({len(specs[-1].markdown)} chars); judge against oracle.expect",
            events,
            spec_markdown=specs[-1].markdown,
        )

    if terminal is None or terminal.type != "done":
        reason = (
            terminal.reason if terminal is not None and terminal.type == "failed" else "no events"
        )
        return FixtureOutcome(
            fixture.name,
            "FAIL",
            f"runner did not finish: {reason} | stderr: {runner_stderr[-500:]}",
            events,
        )

    branch = terminal.result.branch
    try:
        _git(repo, "checkout", "-q", branch)
    except subprocess.CalledProcessError:
        return FixtureOutcome(
            fixture.name, "FAIL", f"result branch {branch!r} does not exist", events
        )

    if fixture.oracle["type"] == "pytest_hidden":
        hidden = fixture.path / fixture.oracle["tests_dir"]
        for item in hidden.iterdir():
            if item.name in _IGNORED_NAMES:
                continue
            if item.is_dir():
                shutil.copytree(
                    item, repo / item.name, ignore=shutil.ignore_patterns(*_IGNORED_NAMES)
                )
            else:
                shutil.copy2(item, repo / item.name)

    command = shlex.split(fixture.oracle["command"])
    if command[0] == "python":
        command[0] = sys.executable
    check = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=300)
    if check.returncode == 0:
        return FixtureOutcome(fixture.name, "PASS", f"oracle passed on {branch}", events)
    tail = (check.stdout + check.stderr)[-800:]
    return FixtureOutcome(fixture.name, "FAIL", f"oracle failed on {branch}: {tail}", events)


def run_suite(
    fixtures_dir: Path,
    *,
    engine: str,
    model: str | None,
    timeout_sec: int,
    engine_configs: dict[str, dict[str, Any]] | None = None,
    only: list[str] | None = None,
) -> list[FixtureOutcome]:
    outcomes = []
    for fixture in discover_fixtures(fixtures_dir):
        if only and fixture.name not in only:
            continue
        outcomes.append(
            run_fixture(
                fixture,
                engine=engine,
                model=model,
                timeout_sec=timeout_sec,
                engine_config=(engine_configs or {}).get(fixture.name),
            )
        )
    return outcomes


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
