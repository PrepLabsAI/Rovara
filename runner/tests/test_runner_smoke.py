"""Package smoke tests — real runner tests arrive with Phase 1."""

import agentx_runner
from agentx_runner.cli import main


def test_package_imports() -> None:
    assert agentx_runner.__version__


def test_cli_stub_signals_unimplemented() -> None:
    assert main() == 2
