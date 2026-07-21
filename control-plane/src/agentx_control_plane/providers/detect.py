"""Devcontainer detection and the no-devcontainer fallback (PLAN.md Phase 2).

If the repo ships `.devcontainer/devcontainer.json` (or `.devcontainer.json`)
we use it. Otherwise we infer a base image from lockfiles/manifests and note the
inference so it can be surfaced in the event stream ("inferred setup").

The runner itself needs python3 (+venv). All inferred images are
mcr.microsoft.com/devcontainers/* variants that include python; repos whose own
devcontainer image lacks python fail at provision time with a clear error.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_CONFIG_LOCATIONS = (
    ".devcontainer/devcontainer.json",
    ".devcontainer.json",
)

# Checked in order; first hit wins. (marker file/glob, image, note)
_INFERENCE_RULES: tuple[tuple[str, str, str], ...] = (
    ("pyproject.toml", "mcr.microsoft.com/devcontainers/python:3.12", "python (pyproject.toml)"),
    ("uv.lock", "mcr.microsoft.com/devcontainers/python:3.12", "python (uv.lock)"),
    (
        "requirements.txt",
        "mcr.microsoft.com/devcontainers/python:3.12",
        "python (requirements.txt)",
    ),
    ("setup.py", "mcr.microsoft.com/devcontainers/python:3.12", "python (setup.py)"),
    (
        "package.json",
        "mcr.microsoft.com/devcontainers/typescript-node:22",
        "node (package.json)",
    ),
    ("go.mod", "mcr.microsoft.com/devcontainers/go:1.23", "go (go.mod)"),
    ("Cargo.toml", "mcr.microsoft.com/devcontainers/rust:1", "rust (Cargo.toml)"),
)

_DEFAULT_IMAGE = "mcr.microsoft.com/devcontainers/python:3.12"


@dataclass
class DevcontainerPlan:
    """What to feed `devcontainer up` for this repo."""

    config: dict[str, Any]
    inferred: bool
    notes: list[str] = field(default_factory=list)


def _strip_jsonc(text: str) -> str:
    """devcontainer.json allows comments and trailing commas (JSONC)."""
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return text


def load_repo_devcontainer(repo: Path) -> tuple[dict[str, Any], Path] | None:
    for rel in _CONFIG_LOCATIONS:
        path = repo / rel
        if path.is_file():
            config = json.loads(_strip_jsonc(path.read_text()))
            if not isinstance(config, dict):
                raise ValueError(f"{rel}: devcontainer config must be a JSON object")
            return config, path
    return None


def _infer_image(repo: Path) -> tuple[str, str]:
    for marker, image, note in _INFERENCE_RULES:
        if (repo / marker).is_file():
            return image, note
    if any(repo.rglob("*.py")):
        return _DEFAULT_IMAGE, "python (*.py files, no manifest)"
    return _DEFAULT_IMAGE, "unknown stack — defaulting to python image"


def plan_devcontainer(repo: Path) -> DevcontainerPlan:
    found = load_repo_devcontainer(repo)
    if found is not None:
        config, path = found
        # Relative dockerfile/context paths resolve against the config's own
        # directory; the merged override-config lives elsewhere, so rewrite them
        # to absolute host paths (the devcontainer CLI builds host-side).
        build = config.get("build")
        if isinstance(build, dict):
            for key in ("dockerfile", "context"):
                value = build.get(key)
                if isinstance(value, str) and not Path(value).is_absolute():
                    build[key] = str((path.parent / value).resolve())
        if "dockerFile" in config and not Path(str(config["dockerFile"])).is_absolute():
            config["dockerFile"] = str((path.parent / str(config["dockerFile"])).resolve())
        return DevcontainerPlan(config=config, inferred=False, notes=[])

    image, note = _infer_image(repo)
    return DevcontainerPlan(
        config={"image": image},
        inferred=True,
        notes=[f"no devcontainer config — inferred setup: {note}, image {image}"],
    )
