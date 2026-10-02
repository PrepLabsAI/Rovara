# Feature Specification: Upgrade Pi from 0.85.1 to 1.0.0 Without Changing Behaviour

**Feature Branch**: `test/050-pi-characterization` (phase 1), then `feat/050-pi-upgrade` (phase 2)  
**Created**: 2026-10-01  
**Status**: Phase 1 merged (#239). Phase 2 (`plan-upgrade.md`) implemented on `feat/050-pi-upgrade`: Pi 1.0.0, all
characterization tests green, reviewed; PR pending, then release and the FR-005 smoke run  
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
- **FR-003 (phase 2):** The upgrade pins both packages at exactly **1.0.0** (Ruling 1; it was 0.99.2 when this spec
  was written) and passes every phase 1 test without weakening its assertions. Where Pi deliberately changes something
  AgentX relies on (for example `user_bash` failing closed), AgentX adapts so the test still holds. If a test truly must
  change, the PR says why, line by line (see "Phase 2 test edits" below).
- **FR-004 (phase 2):** No paid regression runs before launch (decision 2026-10-01: Pi is heavily tested upstream,
  AgentX has no users yet, and model spend is saved for the final campaign in spec 046). The characterization tests
  and CI are the gate. The 0.85.1 runs already made are kept in `baseline.md` for reference only.
- **FR-005 (phase 2):** After release, one cheap pipeline smoke run (a SEC-bench or SWE-bench task on an inexpensive
  OpenRouter model, about $0.50) confirms the eval path works end to end before the final campaign depends on it. The
  previous release tag is noted for rollback.

## Out of Scope

Using any 0.99 or 1.0 feature (that is specs 047 and 049). Enabling Pi's `.pi/mcp.json` MCP client, codemode or
`tool_search`, which stay off (an MCP server can spawn commands and interpolate secrets); `pi-builtins-off.test.ts` pins it. Changing the orchestrator's tool behaviour.

## Success Criteria

- **SC-001:** Phase 1 tests merged on 0.85.1, green in CI.
- **SC-002:** Phase 2 PR green with no characterization assertion weakened. Besides the `modelView()` helpers, only the
  pins the Decisions below allow change, each with its reason.
- **SC-003:** Released through the pipeline, and the smoke run (FR-005) graded end to end.

## Decisions (phase 2)

- **Ruling 1 (2026-10-02): target Pi 1.0.0, not 0.99.2.** 1.0.0 came out a day after 0.99.2. Its changes are to Pi's
  terminal UI, MCP OAuth and codemode, none of which AgentX's SDK use touches, and it includes 0.99's fixes.
- **Ruling 2:** Tasks 1 and 2 (bump, then make the gate pass) went to one implementer, with one review after.
- **Ruling 3 (A): accept Pi's tagged system-prompt framing.** Since 0.86, Pi wraps prompt sections in tags (`<tools>`,
  `<rules>`, `<docs>`, `<project_context>`, `<cwd>`). The structure pins follow it, and new assertions check that
  AgentX's own content (the workspace note, each repository's context file, the orchestrator prompt and the hidden
  turn note) still reaches the model word for word. AgentX does not port 0.85.1's prompt builder.
- **Ruling 4 (B): accept the openai SDK 7 abort behaviour.** SDK 7 drops a read that resolves after an abort. The
  abort test now aborts after the first chunk is consumed, event-driven; its assertion is unchanged.
- **Ruling 5 (C): accept that `"strict": false` is no longer sent** on tool declarations (the API default, same
  meaning).
- **Ruling 6 (D): accept additive fields.** These are assistant `thinkingLevel`, the leading system-message session
  entry and its orchestrator events, the system message in Pi's own message list, and the `turn_end` boundary fields.
  Bash `structuredContent` was kept at first, then amended by Ruling E.
- **Ruling 7: fix in this PR.**
  - OpenRouter sends one leading, current prompt on resume. Compat sets `supportsMidConvoSystemMessages: false`.
    Otherwise GPT-5.x models would get the old prompt plus a mid-conversation delta on every resumed Slack turn.
  - Pi's prompt-cache warming is off for the worker and the orchestrator. It defaults to `"streaming"`, which means
    extra paid requests.
  - The worker's first-turn session entry roles are pinned.
  - The event size check led to Ruling E.
- **Ruling 8: defer** explicit paths for `PI_CODING_AGENT_DIR` / `getAgentDir`, and `totalMessages` reading 5 instead
  of 4 (see Follow-ups).
- **Ruling E: strip bash `structuredContent` from the worker's `tool_end` events.** This amends Ruling D for this one
  field. It holds up to 1 MiB, and only codemode reads it. A 2 MB bash output made a 1.17 MB event, past the
  broker's 400 KB DynamoDB item limit, and that poisons the event batch, so every later event of the task is lost.
  Without it, the event is as small as on 0.85.1.
- **Ruling F:** the broker-side per-event size backstop is a follow-up, not this PR.

Production seams changed in phase 2:
- **`packages/model-runtime/src/index.ts`:**
  - the custom `streamSimple` takes `TranscriptContext`;
  - OpenRouter compat sets `sendSessionAffinityHeaders: false` (no `x-session-id`) and
    `supportsMidConvoSystemMessages: false`.
- **`packages/worker/src/pi-session.ts`:**
  - `steer` drops Pi's queued-input disposition;
  - the handle hides `system` messages from its events and from `agent_end`, and from `totalMessages`;
  - it strips bash `structuredContent` from `tool_end`;
  - it sets `cacheWarming` off.
- **`packages/orchestrator/src/orchestrator.ts`:** sets `cacheWarming` off.

## Phase 2 test edits (each also has a one-line reason in the code)

**`modelView()` helpers (allowed edit 1)**
- Worker and orchestrator: read the prompt and tools from the leading system message (`getCurrentSystemPrompt` /
  `getCurrentTools`).

**Worker characterization test**
- *Ruling A:*
  - the `<project_context>`/`<cwd>` section text and the section boundaries are re-pinned;
  - new word-for-word checks for the workspace note and the AGENTS.md block.
- *Ruling D:*
  - the plain turn's session entries gain `["message","system"]`, with each entry's role pinned;
  - resume gains the system entry, and the four conversation messages are counted without it;
  - assistant key sets gain `thinkingLevel`.
- *Ruling E:* the bash `tool_end` pin is back to 0.85.1. A new 2 MB test checks three things: no
  `structuredContent`, the event's text equals the toolResult the model got in its next request, and the stored
  record is under 150 KB.
- *#245:* `getModel()` expects `thinkingLevel: "off"`.

**Orchestrator characterization test**
- *Ruling A:* new check that `orchestratorSystemPrompt("Delegate.")` reaches the model whole.
- *Ruling D:*
  - the turn note's session entries gain the system entry, so its parent is now `lines[4]`;
  - the extension event order gains the system message's `message_start`/`message_end`;
  - the `message_end` and `agent_end` key sets and roles start with the system message;
  - `branchAtToolCall` gains the system entry, and the member's message moves from [2] to [3];
  - assistant key sets gain `thinkingLevel`.
- *Allowed edit 2:* the `turn_end` keys gain Pi 0.87's boundary fields.

**OpenRouter characterization test**
- *Ruling A:* the developer prompt is `"…\n\n<cwd>\n<CWD>\n</cwd>"`.
- *Ruling C:* no `"strict": false`.
- *Ruling D:*
  - `session.messages` starts with the system message, and assistants carry `thinkingLevel`;
  - Pi's own `totalMessages` is 5, which no AgentX code reads.
- *Ruling B:* the abort test aborts on the third `pull()`, after the first chunk is consumed. The assertion is unchanged.
- *Ruling 7:* two new resume tests on `openai/gpt-5.5`, one with a changed cwd and one from a 0.85.1-style file.
  Each expects one leading prompt that holds the new cwd.

**New test files**
- `pi-builtins-off.test.ts`: the MCP client, codemode and tool_search stay off in the worker and the orchestrator.
  A control proves that the planted configuration turns them on when the built-ins load.
- `pi-cache-warming-off.test.ts`: no warm-up request during a long tool run, with a control.

**Other tests, adapted to the new types with no assertion weakened**
- `eval-command-actions` and `eval-reply-length` read the prompt from the transcript.
- `eval-harness`, `eval-reply-length` and `tests/eval/offline.ts` cast tool arguments to `JsonObject`.
- The stub adapters in `model-turn-failure` and `tool-loop-guard` drop the steer disposition.
- `action-classifier` compares against `normalizeContext(...)`.

## Follow-ups (not in phase 2)

- **Ruling F:** a broker per-event size cap in `appendEvents`/`appendEventChunk`, so one oversize event can never
  poison a batch. Also check the size of `agent_end.messages` on long runs: it holds the whole run, so many 50 KB
  tool results can pass 400 KB (this was already true on 0.85.1).
- **Explicit paths for `PI_CODING_AGENT_DIR` / `getAgentDir`.** Some Pi code (for example the MCP client's user-level
  `mcp.json`) reads the host's `~/.pi/agent` instead of AgentX's agent directory. This is unused today because the
  built-ins are off, and it was already the case on 0.85.1.
- **`totalMessages`.** Pi's raw session stats on the orchestrator count the system entry, so they read 5 where the
  worker handle reports 4. No AgentX code reads them.

