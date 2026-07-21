"""Package smoke tests."""

import agentx_runner
import pytest
from agentx_runner.cli import main


def test_package_imports() -> None:
    assert agentx_runner.__version__


def test_cli_requires_arguments() -> None:
    with pytest.raises(SystemExit) as excinfo:
        main([])
    assert excinfo.value.code == 2  # argparse usage error
