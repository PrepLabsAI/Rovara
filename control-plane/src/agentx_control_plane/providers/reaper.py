"""`agentx-reaper` — destroy leaked sandboxes (PLAN.md Phase 2).

Everything LocalDockerProvider creates carries the `agentx.workspace` and
`agentx.created-at` labels, so leaked state is discoverable even if the control
plane crashed mid-task and `teardown` never ran. The reaper removes containers
and networks older than `--max-age-sec` (or all of them with `--all`), plus
workspace directories on disk past the same age. Run it from cron/systemd; it
is safe to run concurrently with live tasks.
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

from agentx_control_plane.providers.local_docker import LABEL_CREATED_AT, LABEL_WORKSPACE

_DEFAULT_MAX_AGE_SEC = 4 * 3600


def _docker_lines(cmd: list[str]) -> list[str]:
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        print(f"reaper: {' '.join(cmd)} failed: {out.stderr.strip()}", file=sys.stderr)
        return []
    return [line for line in out.stdout.splitlines() if line.strip()]


def _created_at(kind: str, ident: str) -> int:
    if kind == "container":
        fmt = f'{{{{index .Config.Labels "{LABEL_CREATED_AT}"}}}}'
        cmd = ["docker", "inspect", "--format", fmt, ident]
    else:
        fmt = f'{{{{index .Labels "{LABEL_CREATED_AT}"}}}}'
        cmd = ["docker", "network", "inspect", "--format", fmt, ident]
    lines = _docker_lines(cmd)
    try:
        return int(lines[0])
    except (IndexError, ValueError):
        return 0  # unlabeled/unparseable → treat as infinitely old


def reap(max_age_sec: int, workspaces_root: Path, *, reap_all: bool = False) -> int:
    cutoff = time.time() - max_age_sec
    reaped = 0

    for cid in _docker_lines(["docker", "ps", "-aq", "--filter", f"label={LABEL_WORKSPACE}"]):
        if reap_all or _created_at("container", cid) < cutoff:
            print(f"reaper: removing container {cid}")
            subprocess.run(["docker", "rm", "-f", cid], capture_output=True)
            reaped += 1

    for net in _docker_lines(
        ["docker", "network", "ls", "-q", "--filter", f"label={LABEL_WORKSPACE}"]
    ):
        if reap_all or _created_at("network", net) < cutoff:
            print(f"reaper: removing network {net}")
            subprocess.run(["docker", "network", "rm", net], capture_output=True)
            reaped += 1

    if workspaces_root.is_dir():
        for workdir in workspaces_root.iterdir():
            if not workdir.is_dir():
                continue
            if reap_all or workdir.stat().st_mtime < cutoff:
                print(f"reaper: removing workdir {workdir}")
                shutil.rmtree(workdir, ignore_errors=True)
                reaped += 1

    return reaped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentx-reaper")
    parser.add_argument("--max-age-sec", type=int, default=_DEFAULT_MAX_AGE_SEC)
    parser.add_argument("--workspaces-root", default=str(Path.home() / ".agentx" / "workspaces"))
    parser.add_argument("--all", action="store_true", help="Reap regardless of age")
    args = parser.parse_args(argv)
    reaped = reap(args.max_age_sec, Path(args.workspaces_root), reap_all=args.all)
    print(f"reaper: {reaped} object(s) removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
