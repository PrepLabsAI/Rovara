# Feature Specification: An Explicit Thinking Level for Every Approved Model

**Feature Branch**: `docs/053-thinking-level` (spec), then `feat/053-thinking-level`  
**Created**: 2026-10-01  
**Status**: Draft  
**Input**: SWE-bench pilot finding A3, and the Pi review's quick win "thinking level per model". Narrowed on
2026-10-01 to what spec 046's final campaign needs.

## Why

How hard a model thinks changes both its results and its cost, and today AgentX does not choose it consistently:

- **Bedrock models** run at `medium` (`packages/worker/src/task-model.ts:12`).
- **OpenRouter models** run at whatever Pi turns the requested level into. The pilot's GLM 5.3 sessions record
  `high`: GLM 5.3 produced 169,615 characters of thinking on one task. The cause was not a missing default. Pi's
  catalog marks `medium` unsupported for GLM 5.3 (its `thinkingLevelMap` allows only `low`, `high` and `max`), and
  Pi's session silently clamps an unsupported level up to the next supported one, so the requested `medium` ran as
  `high` (reviewed and verified against pi-ai's catalog and `clampThinkingLevel`).

So the pilot's Sonnet-versus-GLM comparison compared different settings, not just different models. The level used is
also not recorded anywhere a later comparison can read.

## Requirements

- **FR-001:** `ModelRefSchema` (`packages/contracts/src/models.ts:8`) gains an optional
  `thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`, so each approved model in a project
  definition, and the default, can carry one.
- **FR-002:** Coding tasks and eval runs resolve the level in this order:
  1. a batch file's per-model override (spec 052);
  2. the project's approved-model entry;
  3. today's default: `medium` for any model that supports reasoning, `off` otherwise, for **both** providers.

  OpenRouter no longer falls back to Pi's default. This removes today's provider-dependent behaviour.
- **FR-003:** An approved model's `thinkingLevel` (on an approved entry or the default) that the model does not
  support is refused when the project definition is saved, instead of being clamped by Pi to another level. The
  supported levels are the ones Pi's catalog gives the model (pi-ai `getSupportedThinkingLevels`), so a level other
  than `off` on a model that does not support reasoning is refused, and so is `off` on a model that always reasons.
  The message names the model and lists its supported levels, for example
  `GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high, max`. Where the catalog
  cannot tell at save time (a model it does not know), the definition is accepted and the refusal happens at first
  use. An unset level is not checked; the session records the level Pi actually used (FR-004).
- **FR-004:** The level actually used is recorded:
  - in task usage telemetry (`thinkingLevel`, beside provider and model);
  - in each eval run's `result.json`. That record exists since spec 045's run-setup fields; it now holds the
    resolved level, never "default".
- **FR-005:** The Slack `models` reply shows each approved model's level, for example "GLM 5.3 (thinking: medium)".
  Setting a level stays an admin action, through the project definition, as approving models is today.

## Out of scope

- A member asking for "think harder" on one task.
- Changing the level automatically mid-task.
- Pi 0.99 virtual-model routing.

These are for later.

## Decisions

- **D-1 (2026-10-01):** Per model now, set by an admin. Per-task requests later.
- **D-2:** Default `medium` for reasoning models on every provider. The pilot's GLM `high` came from Pi clamping an
  unsupported `medium`, not from a missing default, so the default alone does not make runs comparable: an admin's
  explicit level is checked against the model's supported levels at save time (FR-003), and the campaign sets an
  explicit supported level for each model. That is acceptable before launch, and it makes cost and results
  comparable.

## Success Criteria

- **SC-001:** Tests cover:
  - schema validation, including the save-time refusal of a level the model does not support (non-reasoning models
    included);
  - the resolution order: batch override, then project entry, then default;
  - both providers getting `medium` by default;
  - the level reaching the Pi session;
  - the level in usage telemetry and `result.json`;
  - the `models` reply.
- **SC-002:** No paid runs (pre-launch decision). The final campaign (spec 046) uses explicit levels for all six models.
- **SC-003:** Typecheck, lint and the full suite pass.
