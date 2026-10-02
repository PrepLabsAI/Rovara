# Pi Characterization Tests Implementation Plan (spec 050, phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin today's behaviour (Pi 0.85.1) at every place AgentX uses Pi, with offline tests that drive the real production setup, so the 0.99.2 upgrade (phase 2) cannot change behaviour unnoticed.

**Architecture:** Three new test files, one per area: worker sessions, orchestrator extensions and events, and the OpenRouter provider. One small production seam lets tests give the worker's default session adapter the scripted model. Every test runs the real Pi SDK, with `fauxModelRuntime()` (tests/support/faux-model.ts) for model turns and a fake `fetch` for OpenRouter. None calls a paid model or the network.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.85.1 (`fauxProvider`, `fauxAssistantMessage`, `fauxToolCall`).

**Spec:** `specs/050-pi-upgrade/spec.md`

## Global Constraints

- Tests pass on Pi 0.85.1 exactly as installed; `package.json` and the lockfile do not change in phase 1.
- The only production change is the worker seam in Task 1. Default behaviour is identical (`defaultPiSessionAdapter` keeps its name and behaviour).
- Characterization means **observe, then pin exact values**. Run the scenario, read what 0.85.1 actually produces, and assert those exact values: strings, exit codes, stop reasons, the key sets of event payloads, and counts. Use `toEqual` on sorted key lists, not `toMatchObject` subsets. A test that would pass on a changed shape is a defect.
- Every test starts with a one-line comment naming the production file it protects and, where relevant, the 0.99 change it guards (`// guards: user_bash fails closed (0.99)`).
- Offline only: `fauxModelRuntime()`, or a fake `fetch` for OpenRouter. No Bedrock, OpenRouter, Docker or AWS calls.
- Do not edit or weaken any existing test.
- `packages/orchestrator/*` belongs to Pratik's in-house tools. This plan adds tests only and changes no orchestrator source.
- Node 22. Tests read `@agentx/contracts` from dist, so run `npm run build` before running tests.
- Commit trailer: `Co-Authored-By: <your model> <noreply@anthropic.com>`.

## Review Focus

1. **Tests that bypass the seam.** A worker test that builds its own `createAgentSession`, like `realPi()` in `tests/integration/model-turn-failure.test.ts`, does not protect `pi-session.ts`. Task 1 tests must go through `createWorkspacePiSession(…, createDefaultPiSessionAdapter({ modelRuntime }))`.
2. **Subset assertions on event payloads.** Pi 0.99 changes event shapes. Only full sorted-key snapshots catch a renamed or removed field (Task 3).
3. **`user_bash` with no shell.** The test must prove that no process ran (a sentinel file is not created) as well as pinning the reply text and exit code 126 (Task 2).
4. **OpenRouter request body.** `TranscriptContext` changes what `streamSimple` receives. Pin the exact request JSON the fake `fetch` gets, including model, routing, reasoning, messages and tools (Task 4).
5. **Ordering with PR #230.** PR #230 also edits `pi-session.ts`. Task 1 starts from mainline *after* #230 merges (`createWorkerResources` exists), or is rebased onto it before review.

## File Structure

| File | Change | Protects |
|---|---|---|
| `packages/worker/src/pi-session.ts` | modify: add `createDefaultPiSessionAdapter({ modelRuntime? })`; `defaultPiSessionAdapter = createDefaultPiSessionAdapter()` | the seam itself |
| `tests/integration/pi-worker-characterization.test.ts` | create | `pi-session.ts`, `run-task.ts` and `swebench/agent.ts` event reads, `devcontainer.ts` tool mapping |
| `tests/integration/pi-orchestrator-characterization.test.ts` | create | `orchestrator.ts` boundary and notes, `action-gate.ts`, `turn-recorder.ts`, extension errors |
| `tests/integration/pi-openrouter-characterization.test.ts` | create | `model-runtime/src/index.ts` custom provider, `action-classifier.ts` `completeSimple` path |

No compile-time type-pin file: `npm run typecheck:all` already fails if a Pi type AgentX uses changes shape, and the baseline check catches new errors.

---

### Task 1: Worker seam and real worker sessions

**Files:** modify `packages/worker/src/pi-session.ts`; create `tests/integration/pi-worker-characterization.test.ts`.

**Interfaces:**
- Produces: `createDefaultPiSessionAdapter(options?: { modelRuntime?: (model: WorkspaceModelConfiguration) => Promise<{ runtime: ModelRuntime; model: WorkspaceModelConfiguration }> }): PiSessionAdapter`.
- When `modelRuntime` is absent, the behaviour is today's: `createModelRuntimeWithFallback(input.model, "worker")`, then the Bedrock execution-role provider registration. `export const defaultPiSessionAdapter = createDefaultPiSessionAdapter();`.

- [ ] **Step 1: Add the seam.** Move the runtime resolution in `createDefaultSession` behind the optional resolver, so its default path is today's code, line for line. Build and run `npx vitest run tests/integration/model-turn-failure.test.ts tests/contract/worker-pi-trust.test.ts` (the latter exists once #230 merges); both must pass unchanged.
- [ ] **Step 2: Write the tests.** A helper makes a temp root with `sessions/` and `agent/` folders and a `fauxModelRuntime()`, then calls `createWorkspacePiSession({ rootPath, model: FAUX_MODEL, … }, createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime, model: FAUX_MODEL }) }))`. Check `createWorkspacePiSession`'s input type for the exact fields. Scenarios, each pinning exact observed values:
  1. **Plain turn.** Faux replies with text. Pin: `sessionFile` exists on disk; `conversationId` is non-empty and stable; `getModel()` equals FAUX_MODEL's provider and model ID; the sorted keys of `getSessionStats()` and of `.tokens`; and the counts (`userMessages`, `assistantMessages`, `toolCalls`, `totalMessages`).
  2. **The custom `bash` tool replaces the built-in.** Pass `bashOperations` whose `exec` records the command and returns exit 0. Faux calls `bash` with `{ command: "echo pinned" }`. Pin: the recorded command, its working directory, and the tool result text the next model turn receives (read it from the faux response factory's context).
  3. **Devcontainer file tools.** Pass `devcontainerPaths` (`containerFolder: "/workspaces/repo"`, `hostFolder: <tmp>/repo`). Faux calls `read` on `/workspaces/repo/a.txt`. Pin: the host file's content is returned. Then faux calls `edit`; pin the host file's new content.
  4. **Context files reach the model.** Write an `AGENTS.md` into a prepared repository the way `loadRepositoryContextFiles` expects (see `packages/worker/src/repository-context.ts`). The faux factory captures `context.systemPrompt`. Pin: it contains that file's content and the workspace note heading.
  5. **Resume.** After turn 1, reopen with `openRegisteredWorkspacePiSession` on the same session file. Run turn 2. Pin: the session file has the expected number of message entries (count them), and both user prompts appear exactly once, in order, in the context turn 2 sends the model.
  6. **Steer then abort.** Faux scripts 3 tool calls in a row. On the first `tool_execution_end`, call `steer("pinned steer")`; on the second, call `abort()`. Pin: the steer text appears once in the next model context; the last `message_end` payload has `stopReason` `"aborted"`; and the prompt promise resolves or rejects as observed, with the exact error text.
  7. **`message_end` payloads.** For faux turns ending in stop, toolUse, error (`errorMessage: "pinned failure"`) and aborted, pin the sorted keys of the event and of `event.message`, plus `role`, `stopReason` and `errorMessage`. These are the fields `run-task.ts` and `swebench/agent.ts` read through casts.
- [ ] **Step 3: Run.** `npx vitest run tests/integration/pi-worker-characterization.test.ts`. All pass on 0.85.1. Also check each test is real: break the value it pins (temporarily, locally) and confirm it fails; note this in the report.
- [ ] **Step 4: Commit.** `test(worker): characterize the worker's Pi session on 0.85.1 (spec 050)`.

### Task 2: Orchestrator boundary, notes, gate and extension errors

**Files:** create `tests/integration/pi-orchestrator-characterization.test.ts`. Read first: `tests/integration/extension-errors.test.ts`, `action-gate-turn.test.ts`, `turn-recording.test.ts` and `openrouter-runtime.test.ts`, which already build real orchestrator runtimes with `createPiSessionRuntime`. Reuse their setup.

- [ ] **Step 1: Write the tests** (real `createPiSessionRuntime` or the higher-level orchestrator factory those tests use, with the faux model):
  1. **`user_bash` boundary** (guards: user_bash fails closed, 0.99). Pi emits `user_bash` from its extension runner (`dist/core/extensions/runner.js` ~767). Find the public path that emits it, the same one interactive mode uses before `executeBash`, and drive it with a command that would create a sentinel file (`touch <tmp>/ran`). Pin: the exact output text "Shell execution is disabled in the orchestrator. Delegate the work to AgentX.", `exitCode` 126, `cancelled` false, `truncated` false, and **that the sentinel file does not exist**. If no public path exists in 0.85.1, use the narrowest internal one, and write in the test comment why.
  2. **Hidden turn note.** With the note extension configured (`before_agent_start`), the faux factory captures the context. Pin: the note text reaches the model; the message's `customType` and `display: false`; and how it is persisted in the session file (entry type and fields).
  3. **Handoff `tool_call` block.** With the stop signal aborted, faux calls a connector tool. Pin: the tool's `execute` is not called; the tool result is an error with the exact handoff reason text; and the turn's final `stopReason`.
  4. **Action gate block.** Using the gate setup from `action-gate-turn.test.ts`, pin the exact `{ block, reason }` the model sees as the tool result for a gated action, and the gate's record.
  5. **Extension that throws** (guards: extension error semantics, 0.99). Add an inline extension whose `tool_call` handler throws "pinned extension failure". Pin: whether the tool still ran (observe 0.85.1); what `onExtensionError` received (sorted keys and values); and that the turn completed or failed as observed.
- [ ] **Step 2: Run, and check each test really fails when its pinned value is broken** (as in Task 1 Step 3).
- [ ] **Step 3: Commit.** `test(orchestrator): characterize Pi extension behaviour on 0.85.1 (spec 050)`.

### Task 3: Event shapes the recorder, gate and worker read

**Files:** add a `describe` to `tests/integration/pi-orchestrator-characterization.test.ts` for orchestrator events and to `pi-worker-characterization.test.ts` for worker events. No new file.

- [ ] **Step 1: One faux turn with a tool call, recording every event.** Subscribe to every event Pi emits (worker: `session.subscribe`; orchestrator: the recorder's extension events). Pin, as sorted key lists, the payloads of: `tool_execution_start`, `tool_execution_end`, `message_end`, `agent_end` (and each entry of `agent_end.messages`), and the `tool_call` event plus its `ctx` argument. Also pin the order of event types for that turn as an array.
- [ ] **Step 2: Cross-check.** For each field that `turn-recorder.ts` (`toolStarted`, `toolEnded`, `agentEnded`), `action-gate.ts`, `run-task.ts` and `swebench/agent.ts` read, assert it is present in the pinned shape. List them in a comment, one line per reader, with file:line.
- [ ] **Step 3: Run and commit.** `test: pin the Pi event shapes AgentX reads (spec 050)`.

### Task 4: OpenRouter custom provider contract

**Files:** create `tests/integration/pi-openrouter-characterization.test.ts`. Read `tests/integration/openrouter-runtime.test.ts` first and reuse its fake `fetch` with SSE chunks.

- [ ] **Step 1: Write the tests.**
  1. **Request body** (guards: TranscriptContext, 0.99). For a turn with a system prompt, one user message and one tool, the fake `fetch` captures the request. Pin: the URL; the headers AgentX sets (names only for secrets); and the JSON body with model, provider routing, reasoning, messages (roles and content shape) and tools (names, parameter schema). Use `toEqual` on the parsed body, with volatile fields (IDs, timestamps) replaced by placeholders.
  2. **Stream to messages.** A scripted SSE stream with text, a tool call and usage. Pin: the assistant message Pi records (content blocks, `stopReason`) and the usage numbers that reach `getSessionStats` and AgentX's `onUsage`.
  3. **Classifier path.** `completeSimple` through the same provider, as `action-classifier.ts` calls it. Pin: the request body (including the reasoning setting) and the parsed result.
  4. **Error and abort.** HTTP 402 and a mid-stream abort. Pin: the `stopReason` and `errorMessage` strings AgentX surfaces.
- [ ] **Step 2: Run, and check the tests really fail when broken. Commit** `test(model-runtime): characterize the OpenRouter provider on 0.85.1 (spec 050)`.

### Task 5: Verify and open the PR

- [ ] `npm run build && npm run typecheck:all && npm run lint && npm test`, all green. A known-flaky test (for example the `slack-consumer-handoff` heartbeat) is rerun alone and noted.
- [ ] After Abhishek confirms: push, and open a PR against `mainline` titled `test: characterize every Pi seam on 0.85.1 before the 0.99 upgrade (spec 050 phase 1)`, with Pratik as reviewer. The PR lists every test and the file it protects.
