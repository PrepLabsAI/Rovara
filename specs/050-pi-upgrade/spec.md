# Feature Specification: Upgrade Pi from 0.85.1 to 0.99.2 Without Changing Behaviour

**Feature Branch**: `test/050-pi-characterization` (phase 1), then `feat/050-pi-upgrade` (phase 2)  
**Created**: 2026-10-01  
**Status**: Draft; phase 1 (characterization tests) planned in `plan-characterization.md`  
**Input**: Pi flexibility review (2026-10-01): the agent verification work (spec 047) and the Pi quick wins
(spec 049) should be built on Pi 0.99, which adds `agent_before_settle`, cache warming, virtual models and context
edits

## Why

AgentX pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at 0.85.1. Pi 0.99.2 (2026-09-30) adds
features specs 047 and 049 need. The main one is `agent_before_settle`, which can hold the agent back from
finishing until a check passes. Pi also made several breaking changes in three weeks, so the gap only grows.

## What must not change

Every behaviour users and operators see today: coding tasks, cancel, resume, the orchestrator's boundaries (no
shell, hidden turn notes, the action gate, handoff), turn records, the OpenRouter transport, usage and cost
numbers, and SWE-bench and SEC-bench runs.

## Known breaking changes that touch AgentX (Pi 0.99 changelog, surveyed 2026-10-01)

| Change | Where AgentX meets it |
|---|---|
| `user_bash` now fails closed | `packages/orchestrator/src/orchestrator.ts:164`, the boundary that answers exit 126; copy in `tests/eval/legacy-presentation.ts:74`. No test fires `user_bash` today. |
| Custom providers receive `TranscriptContext` | `packages/model-runtime/src/index.ts`, where OpenRouter is a custom provider with its own `streamSimple`, also used by the action classifier's `completeSimple` |
| `ExtensionEvent` union and `TurnEndEvent` shapes changed | `turn-recorder.ts`, `action-gate.ts`, `run-task.ts` and `swebench/agent.ts` read event fields through untyped casts, so a rename compiles and fails at run time |
| `session.agent.state.messages` assignment no longer rewrites history; `shouldStopAfterTurn` replaced by `finishTurn` | Not used directly. Indirect risk only, through resume and the stop path. |
| Extension error semantics (fail closed) | `onExtensionError` handling in the orchestrator |

## Requirements

- **FR-001 (phase 1):** Characterization tests pin today's behaviour at every Pi seam, offline: the scripted
  `fauxModelRuntime()` for model turns, a fake `fetch` for OpenRouter. They drive the **real** production setup:
  worker sessions through `pi-session.ts` itself, not a test-local adapter. They pass on 0.85.1 and merge before
  the upgrade.
- **FR-002 (phase 1):** The only production change in phase 1 is a seam that lets tests give the worker's default
  session adapter a model runtime. Default behaviour is unchanged.
- **FR-003 (phase 2):** The upgrade pins both packages at exactly 0.99.2 and passes every phase 1 test without
  editing its assertions. Where 0.99 deliberately changes something AgentX relies on (for example `user_bash` failing
  closed), AgentX adapts so the test still holds. If a test truly must change, the PR says why, line by line.
- **FR-004 (phase 2):** Before and after the upgrade, the same 8 baseline eval runs (2 SWE-bench Verified and 2
  SEC-bench tasks, each on Sonnet 4.6 and GLM 5.3) are compared. A task that resolved before and fails after blocks
  the release until it is explained.
- **FR-005 (phase 2):** Live checks on a test deployment before production: one Slack coding task end to end, a
  cancel, one OpenRouter model, one SWE-bench and one SEC-bench run. The previous release tag is ready for rollback.

## Out of Scope

Using any 0.99 feature (that is specs 047 and 049). Enabling 0.99's `.pi/mcp.json` MCP client, which stays off (it
can spawn commands and interpolate secrets). Changing the orchestrator's tool behaviour.

## Success Criteria

- **SC-001:** Phase 1 tests merged on 0.85.1, green in CI.
- **SC-002:** Phase 2 PR green with no characterization assertion weakened, and the baseline comparison attached.
- **SC-003:** Released through the pipeline, with live checks passed, and no rollback needed within a day.
