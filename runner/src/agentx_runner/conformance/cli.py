"""`agentx-conformance --fixtures fixtures/ --engine openhands --model <litellm-id>`

Prints a status matrix and exits non-zero if any fixture FAILs.
REVIEW outcomes (spec_review oracles) write the captured spec next to the report.
"""

import argparse
import json
import sys
from pathlib import Path

from agentx_runner.conformance.harness import run_suite


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentx-conformance")
    parser.add_argument("--fixtures", required=True, help="Directory of fixture projects")
    parser.add_argument("--engine", default="openhands")
    parser.add_argument("--model", default=None, help="LiteLLM model id (engine default if unset)")
    parser.add_argument("--timeout-sec", type=int, default=900)
    parser.add_argument(
        "--engine-configs",
        default=None,
        help="JSON file mapping fixture name -> engine_config (used by the fake engine)",
    )
    parser.add_argument("--only", action="append", help="Run only the named fixture(s)")
    parser.add_argument("--out-dir", default=None, help="Where to write captured specs/reports")
    args = parser.parse_args(argv)

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
                print(f"  spec written: {out / f'{o.fixture}.spec.md'}")

    failed = [o for o in outcomes if o.status == "FAIL"]
    print(
        f"\n{len(outcomes)} fixtures: "
        f"{sum(o.status == 'PASS' for o in outcomes)} pass, "
        f"{len(failed)} fail, "
        f"{sum(o.status == 'REVIEW' for o in outcomes)} review"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
