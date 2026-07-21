"""Unit tests for the provider layer that don't need a Docker daemon.

The actual in-sandbox conformance runs (Phase 2 exit criteria) are executed via
`agentx-sandbox-conformance`; these tests pin the pure logic around them.
"""

import json
from pathlib import Path

from agentx_control_plane.providers.base import Workspace
from agentx_control_plane.providers.detect import plan_devcontainer
from agentx_control_plane.providers.egress import PROXY_ALIAS, EgressPolicy
from agentx_control_plane.providers.local_docker import (
    CTL_MOUNT,
    LABEL_WORKSPACE,
    LocalDockerConfig,
    LocalDockerProvider,
    _parse_up_output,
)


def _ws(tmp_path: Path, **metadata: str) -> Workspace:
    return Workspace(
        workspace_id="wstest",
        repo_path=tmp_path / "repo",
        base_branch="main",
        provider="local-docker",
        metadata={"workdir": str(tmp_path), **metadata},
    )


class TestDetect:
    def test_repo_devcontainer_wins_and_jsonc_is_tolerated(self, tmp_path: Path) -> None:
        (tmp_path / ".devcontainer").mkdir()
        (tmp_path / ".devcontainer" / "devcontainer.json").write_text(
            '{\n  // comment\n  "image": "python:3.12",\n}\n'
        )
        plan = plan_devcontainer(tmp_path)
        assert plan.config["image"] == "python:3.12"
        assert not plan.inferred
        assert plan.notes == []

    def test_relative_dockerfile_rewritten_absolute(self, tmp_path: Path) -> None:
        dc = tmp_path / ".devcontainer"
        dc.mkdir()
        (dc / "Dockerfile").write_text("FROM python:3.12\n")
        (dc / "devcontainer.json").write_text('{"build": {"dockerfile": "Dockerfile"}}')
        plan = plan_devcontainer(tmp_path)
        assert plan.config["build"]["dockerfile"] == str((dc / "Dockerfile").resolve())

    def test_pyproject_infers_python_image(self, tmp_path: Path) -> None:
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        plan = plan_devcontainer(tmp_path)
        assert plan.inferred
        assert "devcontainers/python" in plan.config["image"]
        assert any("inferred setup" in note for note in plan.notes)

    def test_bare_py_files_infer_python(self, tmp_path: Path) -> None:
        (tmp_path / "thing.py").write_text("x = 1\n")
        plan = plan_devcontainer(tmp_path)
        assert plan.inferred
        assert "devcontainers/python" in plan.config["image"]


class TestEgress:
    def test_allowlist_conf_is_default_deny(self) -> None:
        conf = EgressPolicy().squid_conf()
        assert "http_access deny all" in conf
        assert ".pypi.org" in conf and ".api.openai.com" in conf and ".github.com" in conf
        # allow rule must precede the final deny
        assert conf.index("http_access allow allowed_dst") < conf.index("http_access deny all")

    def test_proxy_env_modes(self) -> None:
        assert EgressPolicy(mode="open").proxy_env() == {}
        env = EgressPolicy().proxy_env()
        assert env["HTTPS_PROXY"] == f"http://{PROXY_ALIAS}:3128"
        assert env["NO_PROXY"] == "localhost,127.0.0.1"


class TestMergeConfig:
    def test_limits_labels_network_mount_env(self, tmp_path: Path) -> None:
        provider = LocalDockerProvider(LocalDockerConfig(memory="2g", cpus=1.5))
        ws = _ws(tmp_path, network="agentx-net-wstest")
        merged = provider._merge_config(
            {"image": "python:3.12", "runArgs": ["--init"], "containerEnv": {"KEEP": "1"}}, ws
        )
        args = merged["runArgs"]
        assert "--init" in args  # repo's own args preserved
        assert args[args.index("--memory") + 1] == "2g"
        assert args[args.index("--cpus") + 1] == "1.5"
        assert args[args.index("--network") + 1] == "agentx-net-wstest"
        assert f"{LABEL_WORKSPACE}=wstest" in args
        assert any(f"target={CTL_MOUNT}" in m for m in merged["mounts"])
        assert merged["containerEnv"]["KEEP"] == "1"
        assert merged["containerEnv"]["HTTPS_PROXY"].startswith("http://")

    def test_open_egress_adds_no_proxy_env(self, tmp_path: Path) -> None:
        provider = LocalDockerProvider(LocalDockerConfig(egress=EgressPolicy(mode="open")))
        merged = provider._merge_config({"image": "python:3.12"}, _ws(tmp_path))
        assert "HTTPS_PROXY" not in merged.get("containerEnv", {})
        assert "--network" not in merged["runArgs"]


class TestUpOutput:
    def test_picks_last_outcome_json(self) -> None:
        stdout = "\n".join(
            [
                "some log line",
                json.dumps({"outcome": "success", "containerId": "abc123"}),
            ]
        )
        assert _parse_up_output(stdout)["containerId"] == "abc123"

    def test_no_json_gives_empty(self) -> None:
        assert _parse_up_output("nothing here") == {}
