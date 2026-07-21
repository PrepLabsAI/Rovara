"""`agentx-sandbox-conformance` — the Phase 1 conformance suite, but every
fixture runs inside a LocalDockerProvider-provisioned RDE instead of a host
subprocess. Same fixtures, same oracles, same grading; only the executor
differs. Passing here is the Phase 2 exit criterion.
"""

import argparse
import contextlib
import json
import sys
from collections.abc import Iterator
from pathlib import Path

from agentx_runner.conformance.harness import ExecResult, RunnerExecutor, run_suite
from agentx_schemas import TaskSpec

from agentx_control_plane.providers.egress import EgressPolicy
from agentx_control_plane.providers.local_docker import LocalDockerConfig, LocalDockerProvider


def sandbox_executor_factory(provider: LocalDockerProvider) -> RunnerExecutor:
    @contextlib.contextmanager
    def execute(task: TaskSpec, repo: Path) -> Iterator[ExecResult]:
        ws = provider.provision(str(repo), "main")
        try:
            events = list(provider.exec_runner(ws, task))
            yield ExecResult(events=events, log="", repo=ws.repo_path)
        finally:
            provider.teardown(ws)

    return execute


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentx-sandbox-conformance")
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--engine", default="openhands")
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout-sec", type=int, default=900)
    parser.add_argument("--engine-configs", default=None)
    parser.add_argument("--only", action="append")
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--egress", choices=["allowlist", "open"], default="allowlist")
    parser.add_argument(
        "--extras",
        action="append",
        default=None,
        help="Runner extras to install in the sandbox (e.g. openhands)",
    )
    parser.add_argument("--hard-timeout-sec", type=int, default=None)
    args = parser.parse_args(argv)

    config = LocalDockerConfig(
        egress=EgressPolicy(mode=args.egress),
        runner_extras=tuple(args.extras or ()),
        hard_timeout_sec=args.hard_timeout_sec,
    )
    provider = LocalDockerProvider(config)

    engine_configs = None
    if args.engine_configs:
        engine_configs = json.loads(Path(args.engine_configs).read_text())

    outcomes = run_suite(
        Path(args.fixtures),
        engine=args.engine,
        model=args.model,
        timeout_sec=args.timeout_sec,
        engine_configs=engine_configs,
        only=args.only,
        executor=sandbox_executor_factory(provider),
    )

    width = max((len(o.fixture) for o in outcomes), default=10)
    print(f"\n{'FIXTURE':<{width}}  STATUS  DETAIL")
    for o in outcomes:
        print(f"{o.fixture:<{width}}  {o.status:<6}  {o.detail[:120]}")

    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for o in outcomes:
            if o.spec_markdown is not None:
                (out / f"{o.fixture}.spec.md").write_text(o.spec_markdown)

    failed = [o for o in outcomes if o.status == "FAIL"]
    print(
        f"\n{len(outcomes)} fixtures in-sandbox: "
        f"{sum(o.status == 'PASS' for o in outcomes)} pass, "
        f"{len(failed)} fail, "
        f"{sum(o.status == 'REVIEW' for o in outcomes)} review"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
