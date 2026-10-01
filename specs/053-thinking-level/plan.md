# Thinking Level per Model Implementation Plan (spec 053)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every approved model carries an explicit thinking level, which reaches coding tasks and eval runs and is recorded. Reasoning models default to `medium` on every provider.

**Architecture:** `ModelRefSchema` (the project's approved list) gains an optional `thinkingLevel`. A new `ModelSelectionSchema` (= `ModelIdentifierSchema` plus an optional `thinkingLevel`) carries the level where a model travels: the worker invocation's `model` (`packages/contracts/src/protocol.ts:29`) and the eval run's `model` (`packages/contracts/src/swebench.ts:137,144,169`). `ModelIdentifierSchema` itself stays unchanged, because it is strict and used everywhere. The broker copies the level from the approved entry when it picks a model. The worker resolves the final level in one function.

**Tech Stack:** TypeScript, zod, vitest.

**Spec:** `specs/053-thinking-level/spec.md`

## Global Constraints

- Levels: exactly `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (the `PiThinkingLevel` type in `packages/worker/src/pi-session.ts:33`). Export the zod enum from contracts, and make the worker type derive from it.
- Default when unset: `medium` if the model supports reasoning, otherwise `off`, for **every** provider. `task-model.ts:12`'s provider check goes. The "supports reasoning" test is the Pi model's `reasoning` flag, as `pi-session.ts` already uses.
- A non-`off` level on a non-reasoning model fails with the same message as `packages/model-runtime/src/index.ts:35`.
- **Compatibility:** an invocation or run config without `thinkingLevel` must keep working. Old workers parse new payloads strictly, so release order matters; see Task 2's note.
- No paid runs. Offline tests only, using the faux model where a session is needed.
- Node 22 (scratchpad PATH). Run `npm run build` before tests, because tests read `@agentx/contracts` from dist.

## Review Focus

1. **Strict-schema rollout.** `protocol.ts`'s invocation schema is strict. A worker built before this change rejects a payload with `model.thinkingLevel`. Confirm how worker images and the control plane release together (`scripts/release-production.ts`: the worker image is published before the control plane). Make sure the broker does not send the field to a worker that cannot parse it; the safe default is for the control plane to send it only after the worker image that accepts it is released. Pin this with a test or document it in the PR.
2. **OpenRouter default change.** OpenRouter reasoning models now get `medium` where they used to inherit Pi's default (`high`). A test pins it.
3. **Recording the resolved level.** `result.json` and telemetry record the level the session actually used (read back from the session, `getModel` or the thinking level), not the requested one.

---

### Task 1: Contracts

**Files:** `packages/contracts/src/models.ts`, `protocol.ts`, `swebench.ts`, `usage.ts`; tests in `tests/contract/` (new `thinking-level.test.ts`).

- [ ] Write failing tests:
  - `ThinkingLevelSchema` accepts the six levels and refuses others.
  - `ModelRefSchema` accepts an optional `thinkingLevel`.
  - `ProjectModelsSchema` still enforces uniqueness and the default-in-approved rule with levels present.
  - `ModelSelectionSchema` accepts an identifier with or without a level and refuses unknown keys.
  - The invocation's `model` and the eval schemas (`SwebenchStartRequestSchema.model`, `SwebenchRunSchema.model`, `SwebenchRunnerConfigSchema.model`) accept a level.
  - `TaskUsageTelemetrySchema` gains an optional `thinkingLevel`.
- [ ] Implement:
  - `export const ThinkingLevelSchema = z.enum(["off","minimal","low","medium","high","xhigh"])`;
  - `ModelRefSchema` gains `thinkingLevel: ThinkingLevelSchema.optional()`;
  - `export const ModelSelectionSchema = ModelIdentifierSchema.extend({ thinkingLevel: ThinkingLevelSchema.optional() }).strict()`;
  - swap it into the invocation `model` and the three eval `model` fields;
  - add `thinkingLevel` to the usage schema and to `createTaskUsageTelemetry`'s model input.
- [ ] Build, run the new test and the existing contract tests (`tests/contract/`), and commit: `feat(contracts): thinking level on approved models and model selections (spec 053)`.

### Task 2: The broker passes the level through

**Files:** `packages/broker/src/aws/broker.ts` (the `projectModel` resolver around `:4415`, and wherever a coding task's invocation `model` is built), `packages/broker/src/aws/swebench.ts:57,127`; tests next to the existing broker tests.

- [ ] Find where the broker picks a coding task's model (the project's current or requested approved model) and builds the invocation. Make it copy `thinkingLevel` from the approved `ModelRef` into the invocation's `model`. Do the same for the eval run's `model` in `startSwebenchRun`; `projectModel` returns the approved entry's level. The deployment default model (`deployment.defaultModel`) has no level.
- [ ] Tests:
  - an approved model with `thinkingLevel: "low"` → the invocation and the run record carry `"low"`;
  - an approved model without a level → no `thinkingLevel` field at all (not `undefined` serialised);
  - the deployment default → none.
- [ ] **Release-order note** (Review Focus 1): read `scripts/release-production.ts` and state in the commit message and PR how the worker image and control plane roll out. If old workers can receive new payloads, add a deployment setting or protocol-version check so the broker omits `thinkingLevel` until the worker supports it. Otherwise document why it is safe.
- [ ] Commit: `feat(broker): carry each approved model's thinking level to tasks and eval runs (spec 053)`.

### Task 3: The worker resolves and records the level

**Files:** `packages/worker/src/task-model.ts`, `pi-session.ts` (where `thinkingLevel` is set on `createAgentSession`), `run-task.ts` and `swebench/run.ts` (usage and `result.json`), `packages/worker/src/usage.ts`; tests: extend `tests/integration/pi-worker-characterization.test.ts` only if spec 050's PR has merged (otherwise a new `tests/integration/thinking-level.test.ts`), plus unit tests for `resolveTaskModel`.

- [ ] `resolveTaskModel(selected)` returns the selection's `thinkingLevel` when given, and otherwise no level. Remove the provider-based `medium`.
- [ ] In `pi-session.ts`, the default stays `input.model.thinkingLevel ?? (model.reasoning ? "medium" : "off")`. That gives `medium` for OpenRouter reasoning models too, because `task-model` no longer leaves them unset differently. A non-`off` level on a non-reasoning model throws the `CONFIG_INVALID` error, with the model-runtime message.
- [ ] Record the **resolved** level, read back from the session after creation, in task usage telemetry (`thinkingLevel`) and in eval `result.json` (`thinkingLevel`, which already exists, now never `"default"`).
- [ ] Tests, offline on the faux model through the real `createWorkspacePiSession`:
  - a level given → the session uses it (assert what the session reports);
  - none given and the faux model is reasoning → `medium`;
  - none given and non-reasoning → `off`;
  - a non-reasoning model with `high` → `CONFIG_INVALID`;
  - an OpenRouter selection without a level → `medium` (the behaviour change);
  - telemetry and `result.json` carry the resolved level.
- [ ] Commit: `feat(worker): resolve every model's thinking level explicitly and record it (spec 053)`.

### Task 4: Slack shows the level

**Files:** `packages/slack-service/src/model-command.ts` (`modelOptionsMessage`); its tests.

- [ ] `modelOptionsMessage` shows `GLM 5.3 (thinking: medium)` when the approved entry has a level, and the existing line when it does not. Pin both lines exactly in the existing model-command tests, and add a case.
- [ ] Commit: `feat(slack): show each approved model's thinking level in the models reply (spec 053)`.

### Task 5: Verify

- [ ] `npm run build && npm run typecheck:all && npm run lint && npm test`, all green.
- [ ] Update the spec's status to "Implemented; awaiting release". Push to the existing PR #244 branch (`docs/053-thinking-level`), and retitle the PR to say it now includes the implementation.
