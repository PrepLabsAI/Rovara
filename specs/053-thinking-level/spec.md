# Feature Specification: An Explicit Thinking Level for Every Approved Model

**Feature Branch**: `docs/053-thinking-level` (spec), then `feat/053-thinking-level`  
**Created**: 2026-10-01  
**Status**: Draft  
**Input**: SWE-bench pilot finding A3, and the Pi review's quick win "thinking level per model". Narrowed on
2026-10-01 to what spec 046's final campaign needs.

## Why

How hard a model thinks changes both its results and its cost, and today AgentX does not choose it consistently:

- **Bedrock models** run at `medium` (`packages/worker/src/task-model.ts:12`).
- **OpenRouter models** get no level, so Pi's default applies. That was `high` in the pilot transcripts: GLM 5.3
  produced 169,615 characters of thinking on one task.

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
- **FR-003:** A level other than `off` on a model that does not support reasoning is refused when the project
  definition is saved, with the message the OpenRouter runtime already uses
  (`packages/model-runtime/src/index.ts:35`). Where the catalog cannot tell at save time, the refusal happens at
  first use.
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
- **D-2:** Default `medium` for reasoning models on every provider. This is a deliberate behaviour change for
  OpenRouter, which stops inheriting Pi's `high`. That is acceptable before launch, and it makes cost and results
  comparable.

## Success Criteria

- **SC-001:** Tests cover:
  - schema validation, including the refusal for non-reasoning models;
  - the resolution order: batch override, then project entry, then default;
  - both providers getting `medium` by default;
  - the level reaching the Pi session;
  - the level in usage telemetry and `result.json`;
  - the `models` reply.
- **SC-002:** No paid runs (pre-launch decision). The final campaign (spec 046) uses explicit levels for all six models.
- **SC-003:** Typecheck, lint and the full suite pass.
