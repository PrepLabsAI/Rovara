"""CLI behavior: JSONL on stdout, exit codes, terminal-event guarantee."""

import json
from pathlib import Path

import pytest
from agentx_runner.cli import main
from agentx_schemas import TaskSpec, parse_event


def write_task(tmp_path: Path, **overrides: object) -> Path:
    spec = {
        "task_id": "t1",
        "mode": "quick",
        "instructions": "x",
        "engine": "fake",
        "engine_config": {
            "script": [
                {"emit": {"type": "progress", "text": "hello"}},
                {
                    "emit": {
                        "type": "done",
                        "result": {"branch": "b", "summary": "s", "test_evidence": "t"},
                    }
                },
            ]
        },
        "constraints": {"timeout_sec": 30},
    }
    spec.update(overrides)
    TaskSpec.model_validate(spec)  # keep the fixture honest
    path = tmp_path / "task.json"
    path.write_text(json.dumps(spec))
    return path


def run_cli(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, list[str]]:
    code = main(list(argv))
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.strip()]
    for line in lines:
        parse_event(line)  # every stdout line must be a valid event
    return code, lines


def test_success_run(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    task = write_task(tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    code, lines = run_cli(capsys, "--task", str(task), "--repo", str(repo))
    assert code == 0
    assert [json.loads(line)["type"] for line in lines] == ["progress", "done"]


def test_failed_run_exit_code(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    task = write_task(tmp_path, engine_config={"script": [{"crash": "boom"}]})
    repo = tmp_path / "repo"
    repo.mkdir()
    code, lines = run_cli(capsys, "--task", str(task), "--repo", str(repo))
    assert code == 1
    assert json.loads(lines[-1])["type"] == "failed"


def test_unknown_engine_is_runner_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    task = write_task(tmp_path, engine="does-not-exist")
    repo = tmp_path / "repo"
    repo.mkdir()
    code, lines = run_cli(capsys, "--task", str(task), "--repo", str(repo))
    assert code == 2
    event = json.loads(lines[-1])
    assert event["type"] == "failed"
    assert "unknown engine" in event["reason"]


def test_missing_repo_is_runner_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    task = write_task(tmp_path)
    code, lines = run_cli(capsys, "--task", str(task), "--repo", str(tmp_path / "nope"))
    assert code == 2
    assert json.loads(lines[-1])["type"] == "failed"
