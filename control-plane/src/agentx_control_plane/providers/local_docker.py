"""LocalDockerProvider — devcontainer-CLI sandboxes on a single Docker host.

Provision flow (PLAN.md Phase 2):
  clone repo → detect/infer devcontainer config → merge in AgentX runArgs
  (resource limits, labels, egress network) → `devcontainer up` with an
  override-config kept *outside* the repo (the clone must stay pristine —
  the adapter commits `git add -A`) → build agentx wheels host-side and
  pip-install them into a venv inside the container.

Exec flow:
  task.json is written to a control dir bind-mounted at /agentx/ctl; the runner
  is started with `docker exec`, secrets travel only via `-e` (Docker API, not
  argv, never the filesystem), stdout JSONL is parsed into EngineEvents, and a
  provider-level hard deadline `docker kill`s the container if the runner's own
  supervision fails to (runaway backstop).

Everything Docker-side carries the `agentx.workspace` label so the reaper can
find and destroy leaked sandboxes after a control-plane crash.
"""

import contextlib
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

from agentx_schemas import EngineEvent, FailedEvent, ProgressEvent, TaskSpec, parse_event

from agentx_control_plane.providers.base import ProvisionError, Workspace, WorkspaceProvider
from agentx_control_plane.providers.detect import plan_devcontainer
from agentx_control_plane.providers.egress import PROXY_ALIAS, EgressPolicy

LABEL_WORKSPACE = "agentx.workspace"
LABEL_CREATED_AT = "agentx.created-at"

CTL_MOUNT = "/agentx/ctl"
VENV_DIR = "/opt/agentx/venv"
RUNNER_PY = f"{VENV_DIR}/bin/python"

_SQUID_IMAGE = "ubuntu/squid:latest"
_UP_TIMEOUT_SEC = 1800  # first image pull can be slow
_SETUP_TIMEOUT_SEC = 900

_DEFAULT_FORWARD_ENV = (
    "LLM_API_KEY",
    "LLM_MODEL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
)


def _default_agentx_root() -> Path:
    # providers/ → agentx_control_plane/ → src/ → control-plane/ → repo root
    return Path(__file__).resolve().parents[4]


@dataclass
class LocalDockerConfig:
    workspaces_root: Path = field(default_factory=lambda: Path.home() / ".agentx" / "workspaces")
    agentx_root: Path = field(default_factory=_default_agentx_root)
    egress: EgressPolicy = field(default_factory=EgressPolicy)
    memory: str = "4g"
    cpus: float = 2.0
    pids_limit: int = 512
    hard_timeout_grace_sec: int = 120
    hard_timeout_sec: int | None = None  # overrides task timeout + grace when set
    runner_extras: tuple[str, ...] = ()  # e.g. ("openhands",) for real-engine runs
    forward_env: tuple[str, ...] = _DEFAULT_FORWARD_ENV
    devcontainer_cli: str = "devcontainer"


class LocalDockerProvider(WorkspaceProvider):
    name = "local-docker"

    def __init__(self, config: LocalDockerConfig | None = None) -> None:
        self.config = config or LocalDockerConfig()

    # -- provision -----------------------------------------------------------

    def provision(self, repo_source: str, ref: str) -> Workspace:
        self._check_prereqs()
        ws_id = uuid.uuid4().hex[:12]
        workdir = self.config.workspaces_root / ws_id
        ws = Workspace(
            workspace_id=ws_id,
            repo_path=workdir / "repo",
            base_branch=ref,
            provider=self.name,
            metadata={"workdir": str(workdir)},
        )
        try:
            return self._provision_inner(ws, workdir, repo_source, ref)
        except BaseException:
            self.teardown(ws)
            raise

    def _provision_inner(
        self, ws: Workspace, workdir: Path, repo_source: str, ref: str
    ) -> Workspace:
        ctl = workdir / "ctl"
        ctl.mkdir(parents=True)
        repo = ws.repo_path

        _run(["git", "clone", "--quiet", repo_source, str(repo)])
        _run(["git", "-C", str(repo), "checkout", "--quiet", ref])
        _run(["git", "-C", str(repo), "config", "user.email", "agentx@local"])
        _run(["git", "-C", str(repo), "config", "user.name", "AgentX"])

        plan = plan_devcontainer(repo)
        ws.notes.extend(plan.notes)

        if self.config.egress.mode == "allowlist":
            self._start_egress(ws, ctl)

        self._build_install_artifacts(ctl)

        merged = self._merge_config(plan.config, ws)
        override = ctl / "devcontainer.json"
        override.write_text(json.dumps(merged, indent=2))

        up = _run(
            [
                self.config.devcontainer_cli,
                "up",
                "--workspace-folder",
                str(repo),
                "--override-config",
                str(override),
            ],
            timeout=_UP_TIMEOUT_SEC,
        )
        outcome = _parse_up_output(up.stdout)
        if outcome.get("outcome") != "success":
            raise ProvisionError(f"devcontainer up failed: {up.stdout[-800:]} {up.stderr[-800:]}")
        ws.metadata["container_id"] = str(outcome["containerId"])
        ws.metadata["remote_workspace_folder"] = str(
            outcome.get("remoteWorkspaceFolder") or f"/workspaces/{repo.name}"
        )

        self._install_runner(ws)
        return ws

    def _check_prereqs(self) -> None:
        for tool, hint in (
            ("docker", "install/start Docker Desktop"),
            (self.config.devcontainer_cli, "npm install -g @devcontainers/cli"),
            ("uv", "https://docs.astral.sh/uv/"),
        ):
            if shutil.which(tool) is None:
                raise ProvisionError(f"{tool!r} not found on PATH ({hint})")
        probe = subprocess.run(["docker", "info"], capture_output=True, text=True)
        if probe.returncode != 0:
            raise ProvisionError(f"docker daemon unreachable: {probe.stderr[-300:]}")

    def _start_egress(self, ws: Workspace, ctl: Path) -> None:
        net = f"agentx-net-{ws.workspace_id}"
        proxy = f"agentx-proxy-{ws.workspace_id}"
        labels = _label_args(ws.workspace_id)
        (ctl / "squid.conf").write_text(self.config.egress.squid_conf())
        _run(["docker", "network", "create", "--internal", *labels, net])
        ws.metadata["network"] = net
        _run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                proxy,
                *labels,
                "-v",
                f"{ctl / 'squid.conf'}:/etc/squid/squid.conf:ro",
                # bypass the image entrypoint (it tails log files we redirect):
                # run squid in the foreground against our config directly
                "--entrypoint",
                "squid",
                _SQUID_IMAGE,
                "-f",
                "/etc/squid/squid.conf",
                "-NYCd",
                "1",
            ],
            timeout=600,  # may pull the image
        )
        ws.metadata["proxy_container"] = proxy
        time.sleep(2)  # squid parses config on startup; fail fast if it died
        state = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", proxy],
            capture_output=True,
            text=True,
        )
        if state.stdout.strip() != "true":
            logs = subprocess.run(["docker", "logs", proxy], capture_output=True, text=True)
            raise ProvisionError(f"egress proxy failed to start: {logs.stderr[-500:]}")
        _run(["docker", "network", "connect", "--alias", PROXY_ALIAS, net, proxy])
        ws.notes.append(
            f"egress: default-deny allowlist via {PROXY_ALIAS} "
            f"({len(self.config.egress.allowed_domains)} domains)"
        )

    def _build_install_artifacts(self, ctl: Path) -> None:
        """Wheels for our packages + an exact-pin requirements export from uv.lock.

        The pins matter: pip's resolver cannot solve openhands-sdk's dependency
        tree from scratch (lmnr conflict), and pinning also makes the sandbox
        runner env deterministic and identical to the host-validated lock.
        """
        wheels_dir = ctl / "wheels"
        wheels_dir.mkdir(parents=True, exist_ok=True)
        for package in ("agentx-schemas", "agentx-runner"):
            _run(
                ["uv", "build", "--wheel", "--package", package, "--out-dir", str(wheels_dir)],
                cwd=self.config.agentx_root,
                timeout=300,
            )
        export_cmd = [
            "uv",
            "export",
            "--package",
            "agentx-runner",
            "--no-emit-workspace",
            "--no-dev",
            "--no-hashes",
            "--format",
            "requirements-txt",
            "-o",
            str(ctl / "requirements.txt"),
        ]
        for extra in self.config.runner_extras:
            export_cmd += ["--extra", extra]
        _run(export_cmd, cwd=self.config.agentx_root, timeout=120)
        # The sandbox is always linux, but pip crashes *evaluating* the
        # `platform_release >= 'X'` markers of darwin-only pins against Docker's
        # non-PEP-440 kernel string ("6.10.14-linuxkit") — strip those lines.
        requirements = ctl / "requirements.txt"
        requirements.write_text(
            "".join(
                line
                for line in requirements.read_text().splitlines(keepends=True)
                if "platform_release" not in line
            )
        )

    def _merge_config(self, config: dict[str, Any], ws: Workspace) -> dict[str, Any]:
        merged = dict(config)
        run_args = list(merged.get("runArgs") or [])
        run_args += [
            "--memory",
            self.config.memory,
            "--cpus",
            str(self.config.cpus),
            "--pids-limit",
            str(self.config.pids_limit),
        ]
        for label in _label_args(ws.workspace_id):
            if label != "--label":
                run_args += ["--label", label]
        if "network" in ws.metadata:
            run_args += ["--network", ws.metadata["network"]]
        merged["runArgs"] = run_args

        workdir = Path(ws.metadata["workdir"])
        mounts = list(merged.get("mounts") or [])
        mounts.append(f"source={workdir / 'ctl'},target={CTL_MOUNT},type=bind")
        merged["mounts"] = mounts

        env = dict(merged.get("containerEnv") or {})
        env.update(self.config.egress.proxy_env())  # lifecycle cmds + engine subprocesses
        if env:
            merged["containerEnv"] = env
        return merged

    def _install_runner(self, ws: Workspace) -> None:
        remote_folder = ws.metadata["remote_workspace_folder"]
        script = " && ".join(
            [
                f"git config --global --add safe.directory {remote_folder}",
                f"python3 -m venv {VENV_DIR}",
                # exact pins from the host uv.lock — no resolution in the sandbox
                f"{VENV_DIR}/bin/pip install --quiet -r {CTL_MOUNT}/requirements.txt",
                f"{VENV_DIR}/bin/pip install --quiet --no-deps {CTL_MOUNT}/wheels/*.whl",
            ]
        )
        proxy_env = self.config.egress.proxy_env()
        cmd = ["docker", "exec", "-u", "root"]
        for key, value in proxy_env.items():
            cmd += ["-e", f"{key}={value}"]
        cmd += [ws.metadata["container_id"], "bash", "-lc", script]
        try:
            _run(cmd, timeout=_SETUP_TIMEOUT_SEC)
        except subprocess.CalledProcessError as exc:
            raise ProvisionError(f"runner install failed in sandbox: {exc.stderr[-800:]}") from exc

    # -- exec ----------------------------------------------------------------

    def exec_runner(self, ws: Workspace, task: TaskSpec) -> Iterator[EngineEvent]:
        for note in ws.notes:
            yield ProgressEvent(text=f"[sandbox] {note}")

        ctl = Path(ws.metadata["workdir"]) / "ctl"
        (ctl / "task.json").write_text(task.model_dump_json())

        env = dict(self.config.egress.proxy_env())
        for name in self.config.forward_env:
            value = os.environ.get(name)
            if value:
                env[name] = value

        cmd = ["docker", "exec", "-u", "root"]
        for key, value in env.items():
            cmd += ["-e", f"{key}={value}"]  # Docker API env — never argv inside, never disk
        cmd += [
            ws.metadata["container_id"],
            RUNNER_PY,
            "-m",
            "agentx_runner.cli",
            "--task",
            f"{CTL_MOUNT}/task.json",
            "--repo",
            ws.metadata["remote_workspace_folder"],
            "--base-branch",
            ws.base_branch,
        ]

        deadline = time.monotonic() + (
            self.config.hard_timeout_sec
            if self.config.hard_timeout_sec is not None
            else task.constraints.timeout_sec + self.config.hard_timeout_grace_sec
        )
        yield from self._stream(ws, cmd, deadline)

    def _stream(self, ws: Workspace, cmd: list[str], deadline: float) -> Iterator[EngineEvent]:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
        )
        assert proc.stdout is not None and proc.stderr is not None
        lines: queue.Queue[str | None] = queue.Queue()
        stderr_buf: list[str] = []
        threading.Thread(target=_pump, args=(proc.stdout, lines), daemon=True).start()
        threading.Thread(target=_drain, args=(proc.stderr, stderr_buf), daemon=True).start()

        noise: list[str] = []
        terminal_seen = False
        while True:
            if time.monotonic() > deadline:
                _kill_container(ws)
                proc.kill()
                if not terminal_seen:
                    yield FailedEvent(
                        reason="sandbox hard timeout — container killed by provider",
                        log="".join(stderr_buf)[-2000:],
                    )
                return
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                continue
            if line is None:
                break
            if not line.strip():
                continue
            try:
                event = parse_event(line)
            except ValueError:
                noise.append(line)  # docker/devcontainer chatter — not runner protocol
                continue
            if terminal_seen:
                continue
            yield event
            if event.type in ("done", "failed"):
                terminal_seen = True

        proc.wait()
        if not terminal_seen:
            tail = ("".join(stderr_buf) + "\n".join(noise))[-2000:]
            yield FailedEvent(
                reason=f"runner produced no terminal event (exit {proc.returncode})", log=tail
            )

    # -- teardown ------------------------------------------------------------

    def teardown(self, ws: Workspace) -> None:
        container = ws.metadata.get("container_id")
        if container:
            _run_quiet(["docker", "rm", "-f", container])
        else:
            # devcontainer up may have created a container we never got the id of
            for cid in _find_labeled("container", ws.workspace_id):
                _run_quiet(["docker", "rm", "-f", cid])
        proxy = ws.metadata.get("proxy_container")
        if proxy:
            _run_quiet(["docker", "rm", "-f", proxy])
        net = ws.metadata.get("network")
        if net:
            _run_quiet(["docker", "network", "rm", net])
        workdir = ws.metadata.get("workdir")
        if workdir and Path(workdir).is_dir():
            shutil.rmtree(workdir, ignore_errors=True)


def _label_args(workspace_id: str) -> list[str]:
    return [
        "--label",
        f"{LABEL_WORKSPACE}={workspace_id}",
        "--label",
        f"{LABEL_CREATED_AT}={int(time.time())}",
    ]


def _find_labeled(kind: str, workspace_id: str) -> list[str]:
    cmd = (
        ["docker", "ps", "-aq"] if kind == "container" else ["docker", "network", "ls", "-q"]
    ) + ["--filter", f"label={LABEL_WORKSPACE}={workspace_id}"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    return [line for line in out.stdout.splitlines() if line.strip()]


def _kill_container(ws: Workspace) -> None:
    container = ws.metadata.get("container_id")
    if container:
        _run_quiet(["docker", "kill", container])


def _parse_up_output(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        with contextlib.suppress(json.JSONDecodeError):
            data = json.loads(line)
            if isinstance(data, dict) and "outcome" in data:
                return data
    return {}


def _pump(stream: IO[str], out: queue.Queue[str | None]) -> None:
    for line in stream:
        out.put(line)
    out.put(None)


def _drain(stream: IO[str], buf: list[str]) -> None:
    for line in stream:
        buf.append(line)
        if len(buf) > 500:
            del buf[:100]


def _run(
    cmd: list[str], *, cwd: Path | None = None, timeout: int = 120
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=True, timeout=timeout)


def _run_quiet(cmd: list[str]) -> None:
    with contextlib.suppress(Exception):
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
