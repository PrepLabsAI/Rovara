# Pi Upgrade Implementation Plan (spec 050, phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move AgentX from Pi 0.85.1 to Pi **1.0.0**, with every phase 1 characterization test passing and no behaviour change.

**Architecture:** Bump the pins, then fix each seam the compiler and the characterization tests point to. The tests are the gate. Their assertions do not change. The only test edits allowed are:
- the `modelView()` helpers, which phase 1 built for exactly this;
- the additive key-set changes listed in #239's description.

Each of those edits needs a one-line reason.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.0.0.

**Spec:** `specs/050-pi-upgrade/spec.md`

## Global Constraints

- **Target 1.0.0, not 0.99.2 (decided 2026-10-02).** 1.0.0 came out on 2026-10-01, a day after 0.99.2. Its changes are to Pi's own terminal UI, MCP OAuth and codemode, none of which AgentX's SDK use touches, and it includes 0.99's fixes. Pin it exactly (`save-exact`).
- **Packages:**
  - `packages/model-runtime`: `pi-ai`, `pi-coding-agent`
  - `packages/orchestrator`: `pi-coding-agent`
  - `packages/worker`: `pi-ai`, `pi-coding-agent`

  Add `@earendil-works/pi-agent-core` only if 1.0.0 needs it as a direct dependency.
- **Characterization tests are the gate:**
  - `tests/integration/pi-worker-characterization.test.ts`
  - `tests/integration/pi-orchestrator-characterization.test.ts`
  - `tests/integration/pi-openrouter-characterization.test.ts`
  - `tests/contract/worker-pi-trust.test.ts`
  - the spec 053 thinking-level tests

  No assertion in them may be weakened.
- **Allowed test edits, each with a one-line reason in the diff:**
  1. The `modelView()` helpers read the system prompt and tools from the leading system message (pi-ai's `getCurrentSystemPrompt` / `getCurrentTools`).
  2. Sorted key-set pins that gain purely additive fields, from the list in #239's description: `turn_end` boundary fields, `ctx.executeTool`, new session entry types.
  3. Spec 053's level tests, if Pi 1.0.0's catalog changes a model's supported levels. Update to the catalog's new truth and say so.
- **Off stays off.** Pi 1.0's MCP client (`.pi/mcp.json`), codemode and `tool_search` must stay off in the worker and orchestrator. Add tests.
- No paid runs (pre-launch decision). After release, one smoke run (spec FR-005): SEC-bench `gpac.cve-2023-5586` on Sonnet 4.6, which cost $0.14 on 0.85.1.
- Node 22 (scratchpad PATH). `npm run build` before tests.

## Review Focus

1. **`user_bash` fails closed.** The orchestrator's boundary must still answer exit 126 with no shell. The phase 1 test with the sentinel file proves it.
2. **Custom providers receive `TranscriptContext`.** `model-runtime`'s OpenRouter `streamSimple` must produce the exact same request JSON. The phase 1 OpenRouter test pins the body.
3. **The worker's trust and skills settings (#230) still hold:** an untrusted SettingsManager, `noSkills`, `resolveProjectTrust: false`. Pi 1.0's resource loader may have changed option names.
4. **The thinking-level clamp.** If 1.0.0's catalog changes GLM 5.3's supported levels, the 053 tests and docs must follow.

---

### Task 1: Bump, compile, fix the seams

- [ ] Pin the five dependencies at `1.0.0` in the three `package.json` files. Run `npm install`, commit the lockfile, then run `npm run build`. Record every compile error in the report.
- [ ] Fix each compile error at its seam, reading Pi 1.0.0's changelog sections for 0.86 to 1.0.0 (`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`) for the intended replacement. Known areas:
  - `user_bash` result handling;
  - `TranscriptContext` in `model-runtime`'s custom `streamSimple`;
  - the `ExtensionEvent` and `TurnEndEvent` shapes in `turn-recorder.ts` and `action-gate.ts`;
  - `finishTurn`;
  - resource-loader options.
- [ ] Run the five gate test files and record which fail and why.
- [ ] Commit: `chore(deps): Pi 1.0.0 (spec 050 phase 2)`. The build is green; tests may still fail at this point.

### Task 2: Make the gate pass

- [ ] Update the `modelView()` helpers (allowed edit 1).
- [ ] For each remaining failing assertion, fix **production code** so behaviour matches 0.85.1. Only if a failure is a purely additive key-set change (allowed edit 2) or a catalog change (allowed edit 3) does the test change, with a one-line reason.
- [ ] Add tests: in a worker folder and in the orchestrator, `.pi/mcp.json`, codemode and `tool_search` are not active. Use the real session, and assert the offered tool set and that no MCP server starts.
- [ ] Full `npm test` is green (the known heartbeat flake is rerun alone), `typecheck:all` matches the baseline, and lint is clean.
- [ ] Commit: `fix: keep AgentX's behaviour on Pi 1.0.0 (spec 050 phase 2)`.

### Task 3: Docs and PR

- [ ] Spec 050: status, the 1.0.0 decision, and the list of every test edit with its reason.
- [ ] `docs/`: anything that names the Pi version.
- [ ] Open a PR against `mainline` listing:
  - the seams changed;
  - each allowed test edit;
  - the release note: no behaviour change, pipeline-released;
  - the post-release smoke run to make.
