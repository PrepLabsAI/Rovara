"""Engine adapters (ARCHITECTURE.md layer 4)."""

from agentx_runner.adapters.base import EngineAdapter
from agentx_runner.adapters.registry import UnknownEngineError, create_adapter

__all__ = ["EngineAdapter", "UnknownEngineError", "create_adapter"]
