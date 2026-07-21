"""Package smoke tests — real control-plane tests arrive with Phase 3."""

import agentx_control_plane
from agentx_schemas import SCHEMA_VERSION


def test_package_imports_and_sees_schemas() -> None:
    assert agentx_control_plane.__version__
    assert SCHEMA_VERSION == 1
