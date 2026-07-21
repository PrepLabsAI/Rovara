"""Engine name → adapter factory. Adapters are imported lazily so optional
engine dependencies (e.g. the OpenHands SDK) are only required when selected."""

from agentx_runner.adapters.base import EngineAdapter


class UnknownEngineError(ValueError):
    pass


def create_adapter(engine: str) -> EngineAdapter:
    if engine == "fake":
        from agentx_runner.adapters.fake import FakeAdapter

        return FakeAdapter()
    if engine == "openhands":
        from agentx_runner.adapters.openhands import OpenHandsAdapter

        return OpenHandsAdapter()
    raise UnknownEngineError(f"unknown engine: {engine!r} (known: fake, openhands)")
