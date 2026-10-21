# Ruling M1.4-AGENT-SEAM: how Rovara drives e2e 0.20.0's agent

Task 4.0. Status: ruled, by reading `e2e@0.20.0` (the vendored `upstream/e2e-0.20.0.tgz`, installed at `node_modules/e2e`), the AI SDK `ai@7.0.127` source (downloaded to read only, not installed), and `@ai-sdk/provider@4.0.21` (installed). No model call and no AWS call was made.

Paths below are relative to `node_modules/e2e/dist` unless they start with `ai:` (the `ai@7.0.127` package, `src/`) or `provider:` (`node_modules/@ai-sdk/provider/dist/index.d.ts`).

## Decisions

| Question | Ruling |
|---|---|
| (a) Request and result shape | The act loop calls `doGenerate` of an AI SDK **v4** language model with `prompt`, `tools`, `toolChoice` and nothing else that matters. It does **not** send `maxOutputTokens` or `temperature` (the plan assumed `maxOutputTokens`). The worker sets both. The result is a `LanguageModelV4GenerateResult`. |
| (b) Pin the toolset, no pixels | **Not possible through config.** Use the fallback: a custom executor built with `createToolLoopExecutor`, whose tools are the closed set `tap, type, press, select, scroll, navigate` (plus the loop's own `complete_step`). The channel schema and the worker refuse any other tool name. `vision` is not an `act` option, so "`vision: false`" in the plan means: no file parts anywhere, enforced by the channel schema. |
| (c) Where actions and stop codes are recorded | Report: one `engine` event per action with redacted prose in `detail` (no node ids). The always-kept ledger comes from our own executor, which holds the observation. `testId` is only in the observation text line, not in the executor's node tree. Stop code: step `status` plus `error.code`. |
| (d) Custom `cache.store` for replay | Mechanically yes (read-only store). **Not from the ledger as specified**: it lacks what a replay needs. Replay should serve e2e's own `ActionTrace`, captured by a write-only store during the verified round. This amends "candidate rounds keep `cache: off`". Needs controller sign-off before Task 4.3 and Task 4.6. |

Two further findings that bind later tasks (details in "Findings that need a decision" below): the `ai` package is **not installed** and the loop cannot run without it, and the loop retries in ways the "no retries" rule must account for.

## (a) The exact `doGenerate` options and result

### Who calls `doGenerate`

- `agent.act` dispatches to the agents entry's executor. The built-in one is `createBuiltInAgent` (`agent/default-agent.js:42-93`), which is `createToolLoopExecutor` (`agent/tool-loop.js:79-100`) plus the grammar toolset.
- `runStep` loads `ai` with `import('ai')` (`agent/tool-loop.js:90`, `agent/ai-sdk.js:42-56`) and builds `new ai.ToolLoopAgent({...})` in `buildLoop` (`agent/tool-loop.js:241-262`) with exactly: `model` (the model wrapped in a stall guard), `instructions`, `tools`, `toolChoice`, `providerOptions` (only when the model's provider is OpenAI or Azure Responses, so never for ours), `maxRetries: 5` (`agent/model/sdk.js:30`), `headers` (`internal/client-identity.js`: user-agent, http-referer, x-title), `stopWhen` and `prepareStep`.
- `ToolLoopAgent` goes through `generateText`, which calls `stepModel.doGenerate({ ...stepCallSettings, tools, toolChoice, responseFormat, prompt, providerOptions, abortSignal, headers })` (`ai: src/generate-text/generate-text.ts:1040-1056`). `stepCallSettings` is `maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, stopSequences, seed, reasoning` from the agent settings (`ai: src/prompt/prepare-language-model-call-options.ts`). The act loop sets none of them, so all are `undefined`. `responseFormat` is `undefined` (no structured output on the act path). Only the judgment path (`assert`, `waitFor`, `extract`) sets `maxOutputTokens: 8192` and a schema (`agent/invocation.js:20,203`, `agent/model/sdk.js:67-82`). Rovara never calls those, and the channel schema refuses their shape.

### The wrapper in front of our model

`withStallGuard` (`agent/model/stall.js:17-51`) wraps the model with `ai.wrapLanguageModel`, so the model that `ai` sees is a wrapper object. It forwards `{ ...params, abortSignal }` where `abortSignal` is the caller's signal merged with a 120 s stall signal (`stall.js:9`). A stalled request becomes a **retryable** `APICallError`.

### Options that reach our `doGenerate` (LanguageModelV4CallOptions, `provider:1448`)

| Field | What the act loop sends | Channel handling |
|---|---|---|
| `prompt` | `LanguageModelV4Prompt` (`provider:1093`): `system` message (string, from `instructions`; `agent/tool-loop.js:243-246`, `hints.instructions` returns the plain string for a non-Anthropic provider, `agent/model/provider-hints.js:27`), then `user` (text parts), `assistant` (text and `tool-call` parts with parsed `input`), `tool` (`tool-result` parts, `output` of type `text` or `error-text` for our string tools) messages | Subset in `E2EModelChannelCallSchema`. No file, reasoning, custom or approval parts, no `providerOptions`. |
| `tools` | Function tools only (`ai: src/prompt/prepare-tools.ts:52-62`): `{ type: 'function', name, description?, inputSchema (JSON Schema), strict? }`. On the last two turns only `complete_step` is active (`tool-loop.js:496-513`). | Names restricted to `E2E_AGENT_TOOL_NAMES`, unique, `inputSchema` bounded JSON. |
| `toolChoice` | `{type:'required'}` normally, `{type:'auto'}` after a model refuses forced choice (`tool-loop.js:337-361`), `{type:'tool', toolName:'complete_step'}` on the final turns (`tool-loop.js:511`). | Same three, no `none`. |
| `maxOutputTokens`, `temperature`, `topP`, `topK`, penalties, `seed`, `stopSequences`, `reasoning`, `responseFormat` | Not sent (undefined). | `maxOutputTokens` optional, 1 to 1024. The others are refused as unknown keys. The **worker** sets output cap 1024 and temperature 0 from the route. |
| `providerOptions` | Not sent for `provider: "agentx-e2e"` (the hints are keyed on the provider name; `provider-hints.js:49-58`). | Refused. |
| `headers`, `abortSignal` | Sent. | Never put on the wire. The in-executor shim uses `abortSignal` to cancel the socket request; the worker applies its own 30 s timeout. |

### The result we return (`LanguageModelV4GenerateResult`, `provider:727`)

- `content`: `Array<{type:'text', text} | {type:'tool-call', toolCallId, toolName, input: string /* JSON text */}>` (`provider:508,545`). We return only those two kinds. Reasoning, file, source, `tool-result` and provider-executed content are never produced (the response schema refuses them).
- `finishReason`: `{ unified: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other', raw: string | undefined }` (`provider:635`).
- `usage`: `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }` (`provider:675`). `ai` converts it to the numbers that `trackModelCalls` records (`agent/primitives.js:701-721`).
- `warnings: []` is required. `response`, `request`, `providerMetadata` are optional.
- The model object itself must pass `isModelInstance` (`config/agent.js:257-265`): `specificationVersion`, `provider`, `modelId` strings and a `doGenerate` function. Rovara's frozen wrapper in `packages/verifier/src/application-runtime-bootstrap.ts:288-307` already has `provider: "agentx-e2e"`, `modelId: routeId`, `specificationVersion: "v4"`. `ai`'s `wrapLanguageModel` also reads `model.supportedUrls` (`ai: src/middleware/wrap-language-model.ts:79`); it is only used for file URLs, which never occur, but the wrapper should expose `supportedUrls: {}` (Task 4.3).

### What the channel therefore is

`E2EModelChannelRequestSchema` is `{ schemaVersion, runId, caseId, stepIndex, callIndex, call: { prompt, tools?, toolChoice?, maxOutputTokens? } }`, at most 256 KiB, strict. `E2EModelChannelResponseSchema` carries either the `ok` content (text and tool-call only, `usage` with `outputTokens` at most 1024) or a typed `error` code, at most 32 KiB, with the worker's `receiptId` (null only for a request refused before it was accepted).

## (b) Pinning the toolset, pixel tools and `vision`

### Why config cannot do it

- The built-in toolset is derived, not configured. `createGrammarTools` (`agent/primitives.js:221-459`) offers one tool per verb in `context.target.verbs`, which comes from the **engine's declaration** (`engine/session.js:156-195`, `declaredVerbs`), not from agent config. The agents entry takes `system` and `tools`, and both only **add** (`default-agent.js:51-54`; `docs/reference/config.mdx`, "agents").
- The `screenshot` tool and the five point tools (`tap_at`, `hover_at`, `type_at`, `press_at`, `select_at`) are offered whenever `!context.pixelsTainted` (`agent/primitives.js:439-446`), and `pixelsTainted` is true only after a secret fill in the attempt (`run/secrecy.js:23-24`). That is incidental protection and we cannot rely on it: a session restored from cookies, or an agent step that runs before any `Secret` fill, still gets the pixel tools.
- The built-in prompt takes a screenshot on its own when the page lists no interactive node (`default-agent.js:56-65`).
- `vision` is **not an `act` option.** `act` throws `UNSUPPORTED_CAPABILITY` for `vision` and `schema` (`docs/reference/agent.mdx`, end of "agent.act"); `vision` belongs to `assert`, `waitFor` and `extract`, and to custom executors only as `vision?: true` for `assert` (`agent/executor.d.ts:485-486`). So the plan's "`vision: false`" cannot be passed to `act`. The equivalent guarantee is: no tool that attaches pixels, a prompt that never carries a file part, and a channel that refuses file parts (tested in `tests/contract/e2e-model-channel.test.ts`).
- Wrapping the engine to hide verbs would not remove `screenshot`, and it would change what Rovara's own deterministic steps can do.

### Choice: custom executor

Use `createToolLoopExecutor` from `e2e/agent` (public export, `agent/public.js`) as the fallback the plan named. `createGrammarTools` is **not** a public export (`agent/public.js` exports only `createToolLoopExecutor`, `defineTool`, `getToolContext`, `AgentError`, `isAgentError`, and the package `exports` map admits no deep import), so the executor defines its own six tools over `ctx.actions`, as `docs/executors.mdx` shows:

- `tap({target})` calls `ctx.actions.tap({id})`; `type({target, value})` calls `ctx.actions.type`; `press({target, key})` calls `ctx.actions.press`; `select({target, value})` calls `ctx.actions.select`; `scroll({direction, target?})` calls `ctx.actions.scroll`; `navigate({url})` calls `ctx.actions.navigate` (e2e already refuses non-http schemes, and the run network is internal).
- Each tool returns the new observation text (`ctx.observe().text`), bounded; each runs inside the loop's `guard`.
- The prompt (`buildPrompt`) is the goal plus a **tree-only** observation. It never calls `observe({ pixels: true })`.
- No `type_secret`, no `upload`, no project tools, no `observe`, no `back`.
- `maxSteps = maxActions` and `maxModelCalls = maxActions + 4` are set on the agents entry (limits 1 to 100, `config/agent.js:100-101`) and may be lowered per call through `ActOptions`; `maxInputTokens: 32000` is set on the entry (`docs/reference/config.mdx`, "AgentOptions"). The loop's `maxTurns` is `budgets.maxModelCalls` (`tool-loop.js:153`), and the wind-down and forced-verdict turns come from the loop unchanged (`tool-loop.js:28,40,496`).
- Defence in depth: the worker proxy validates every request with the closed schema, so even a bug in the executor cannot show the model a screenshot tool or a file part.

The cost: Rovara owns the system prompt, the tool descriptions and the screen text, which the built-in agent tunes (`ScreenPresenter` diffing, `compactScreenHistory`) and which are not public. Start with full `ctx.observe().text` after each action. If the 32000-token input bound bites on large pages, `prepareMessages` can elide superseded screens. That is a Task 4.3 measure, not a reason to take the built-in agent.

## (c) Where actions and stop codes are recorded

### In the e2e report (`run/steps.d.ts`)

- **Actions:** each committed action is one `StepRecord.events[]` entry with `kind: 'engine'`, `name: <action>` and `detail` = `describeAction(...).summary` (`agent/action-dispatcher.js:489-494`, `agent/actions.js:112-190`; `run/steps.d.ts:19-57` `StepEvent`). The prose is redacted and at most 300 characters, for example `tap button "Download orders"`, `type "orders.csv" into textbox "File name"`, `navigate to "/orders"`. **It has no node id and no separate testId field** (`targetLabel` falls back to the test id only when there is no name, text or placeholder).
- **Counts:** `StepRecord.metrics` has `modelCalls` and `actionSteps` (`run/steps.d.ts:59`); the broker cross-checks `actionSteps` against the ledger's action count and `modelCalls` against the receipts.
- **Model use:** `StepRecord.model` has `provider`, `model`, `calls`, `inputTokens`, `outputTokens` (`run/steps.d.ts:74`).
- **Last turns:** `StepRecord.turns[]` keeps at most 12 turns, each with `calls` such as `tap({"target":"n19"})` clipped to 200 characters (`tool-loop.js:50-52`). This is the only place node ids appear in the report, and it is clipped. Do not build the ledger from it.
- **Stop code:** `StepRecord.status` (`passed | failed | blocked | timed-out | cancelled`) and `StepRecord.error.code` (an `AgentErrorCode`). Runtime stops are `STEP_BUDGET_EXHAUSTED`, `STEP_TIMEOUT`, `CANCELLED`, `STEP_NO_CONCLUSION`, `CONTEXT_OVERFLOW`, `MODEL_PROVIDER_FAILED`, `MODEL_OUTPUT_INVALID` (`docs/reference/agent.mdx`). `E2E_AGENT_STOP_CODES` in the contract is exactly that closed list.
- **Cache write:** `StepRecord.cache.write` and `StepRecord.cache.entry` say what happened to the recording (relevant to (d)).

### The ledger (the always-kept record)

The ledger is written by **our executor**, not parsed from the report, because only the executor knows the node it chose and the observation it chose it from:

- `node.role` and `node.name` come from `ExecutorNode` in `ctx.observe({ tree: true }).tree` (`agent/executor.d.ts:93-111`).
- **`testId` is not in `ExecutorNode`**: `projectTree` drops it (`agent/observation.js:297-315`). It is present in the observation `text`, one line per node as `#id role "name" ... testid="..."` (`agent/observation.js:347-348`). The executor extracts it from the line of the target id and records `null` when absent. The line is built from the same redacted observation the model saw.
- `snapshotSha256` is the SHA-256 of that observation text. `valueDigest` is the SHA-256 of the typed value, key, option label or scroll direction. `valueLiteral` is kept only when the value is text of the approved goal (checked by `verifyE2EAgentActionLedgerGoals`).
- `outcome` comes from the tool result (`ok`) or the failure lead (`action-failed`), or `policy-denied` for a `POLICY_DENIED` error.
- `stopCode` is the step's `error.code` (null when the loop concluded). `receiptIds` are the worker receipt ids the shim got back from the channel; the broker still re-derives them from the worker's own receipt store.

## (d) Can a custom `cache.store` serve replay from Rovara's ledger, read-only?

**The mechanism exists.** `CacheConfig.store` (`types.d.ts:1038`) replaces the file store with any `CacheStore` (`cache/store.d.ts:31-47`): `writable`, `read(keyHash)`, `write(keyHash, ActionTrace)`, optional `delete`. A store with `writable: false` and a `write` that returns `undefined` is read-only. With `mode: 'read-only'` the runner replays hits and writes nothing (`cache/context.js:124-150`). Replay is eligible on the first attempt only (`cache/context.js:148`), which matches `retries: 0`. A custom store is exempt from the CI read-only default (`docs/cache.mdx`, "Modes").

**It cannot be fed from the ledger as specified.** A cache entry is a `TraceEntry { schemaVersion: 'trace-1', createdAt, payload: ActionTrace }` (`cache/trace.d.ts:277-360`). `ActionTrace.actions` needs a `TraceTargetDescriptor` per action (`role, name, text, testId, placeholder, selector, inputPurpose, within, position`), verbatim typed `value`s, press keys, scroll directions and counts, plus `startPath`, `endPath`, `endAnchors` and `goneAnchors`. The replay's end check requires at least one recorded change (`docs/cache.mdx`, "How the end check reads the screen"). Our ledger has role, name, testId and digests only: no end route or anchors (so every replay would end in `end-mismatch` and hand over to a model that is not mounted), and typed values are digests, which cannot be typed again. Adding those fields to the ledger would break its "digests, not values" rule.

**Ruling (recommended, for Task 4.6 and a change to Task 4.3):** serve e2e's own `ActionTrace`, captured during the verified round, and keep the ledger as the redacted audit view.

1. In candidate rounds that contain an `agent` step, set `cache: { mode: 'read-write', store: captureStore }` instead of `cache: 'off'`. `captureStore.read` always returns `{status:'miss'}` (so a candidate round never replays: the model always navigates), `write` keeps the `ActionTrace`, and `delete` is a no-op. The runner only writes after a **later deterministic verification step passed** in the attempt (`cache/context.js` `settleStagedTraces`, `docs/cache.mdx` "When a recording is written"), which is the "verified round" condition we want. A failing or unverified round writes nothing.
2. The executor hands the captured trace (at most `MAX_CACHE_WIRE_BYTES` = 1 MiB, `cache/store.d.ts:18`) to the worker as operator-only evidence, after the same credential scan as transcripts. Typed values are stored verbatim in a trace (`docs/cache.mdx`, "What a recording holds"), so it is as sensitive as a transcript and never appears on the task page.
3. The replay round (Task 4.6) mounts **no model channel**, runs with `cache: { mode: 'read-only', store: replayStore }`, an agents entry with an executor that has no model (the agent fixture is built lazily, so a model-less custom executor does not fail with `MODEL_UNAVAILABLE` until a step actually needs one: `run/fixtures.js:81-95`), and the same project id, test id, target, agent name and context, app identity and instruction, because the `keyHash` is derived from them (`cache/identity.js`, `cache/trace.js:101-110` `KEY_CONTEXT_FIELDS`). `replayStore.read(keyHash)` returns the stored entry for that hash. `step.cache.mode` of `self-finalized` means reproduced without a model. Anything else is `reproduced: false` with the e2e reason, informational only.
4. A step whose typed value was read off the screen is recorded as a gap (`agent/action-dispatcher.js:496-519`, `docs/cache.mdx` "Limits and gaps") and replay hands off to a model, which is absent: `reproduced: false`. That is the correct, honest outcome.

If the controller does not accept the `cache: off` amendment, the alternative is a Rovara replay executor that walks the ledger and calls `ctx.actions` after finding each node by role, name and testId. It can only replay `tap` and the values that are text of the goal. It cannot replay a model-chosen typed value. It is weaker, but needs no change to the candidate-round cache setting.

## Findings that need a decision

1. **`ai` is not installed.** `createToolLoopExecutor` and the built-in agent both `import('ai')` at run time (`agent/ai-sdk.js:49`, optional peer `ai ^7.0.0` in `e2e/package.json`). `node_modules/ai` is absent and `package-lock.json` has only `@ai-sdk/provider@4.0.21`. The `ai` module must sit where e2e resolves it from (next to `node_modules/e2e`, in the same tree that qualification installs). Recommendation: pin `ai@7.0.127` (published 2026-10-01, so older than two weeks; its `@ai-sdk/provider` dependency is exactly `4.0.21`, the version e2e 0.20.0 pins, so there is no second copy; other dependencies `@ai-sdk/gateway@4.0.103` and `@ai-sdk/provider-utils@5.0.53`; Node >=22). Later 7.0.x versions depend on `@ai-sdk/provider@4.0.31`, which would add a duplicate. This is a new dependency beyond what D1 allowed (`@aws-sdk/client-bedrock-runtime`). `package-lock.json` is a one-task-at-a-time file; whichever task takes the lock (4.1 for the SDK, 4.3 or 4.5 for the runtime install) must also add `ai`, and the owner should confirm it.
2. **Hidden retries.** The loop and `ai` can send more provider requests than there are agent turns. (i) `ai` retries a thrown `APICallError` with `isRetryable === true` up to `maxRetries: 5` (`ai: src/util/retry-with-exponential-backoff.ts:80-88`), and the stall guard raises exactly that error after 120 s. (ii) The loop re-sends after a context overflow once (`tool-loop.js:377-401`), after a forced-tool-call mismatch (`correctForcedTurn`), after a rejected forced `tool_choice` (`freeToolChoiceRetry`, `tool-loop.js:337-361`), and after a text-only reply (`continueAfterTextReply`, `tool-loop.js:269`). The "no retries" rule therefore needs three things from Tasks 4.1 and 4.3: the shim's `doGenerate` throws a **non-retryable** error for every channel failure (a plain `Error` or an `APICallError` with `isRetryable: false`), so `ai` never re-sends; the worker counts **every request it receives** against `maxModelCalls` and the group cap, whatever the loop meant it as, which is what the `+4` headroom is for; and a refusal or error response is never worded like a `tool_choice` rejection. The worker enforces the 30 s per-call timeout, so the 120 s stall guard never fires first.
3. **`maxOutputTokens` is not sent**, so the worker sets 1024 (and temperature 0) on the provider call itself. The channel accepts `maxOutputTokens` only up to 1024 for forward compatibility.
4. **A model that calls an unknown tool name** is refused at the response schema (fail closed, `invalid-output`), so the next prompt can never carry a hallucinated tool name. A request carrying one is refused as `channel-protocol`.
5. **An agent verdict is not a case verdict.** `agent.act` resolves on a `passed` verdict and throws `AgentError` on `failed` or `blocked` (`docs/reference/agent.mdx`). The driver must catch it, record the stop code and receipts, and map any `AgentError` to UNKNOWN (D3 applies only to a deterministic assertion mismatch after a step that completed). A `passed` verdict with zero committed actions can never satisfy a scenario: Task 4.4 requires at least one `ok` ledger action and still requires the deterministic assertions.

## What this binds

| Task | Consequence |
|---|---|
| 4.1 | Builds the worker side of `E2EModelChannelRequestSchema`/`ResponseSchema`; sets output cap, temperature and per-call timeout itself; counts every request; adds Bedrock Converse tool-use mapping for `toolChoice` `required`, `auto` and `tool`; writes `E2EModelReceiptSchema` receipts. Needs `ai` only for tests, not at runtime. |
| 4.3 | Executor built with `createToolLoopExecutor` and the closed toolset; the shim never retries and never throws a retryable error; tree-only prompt; ledger written by the executor; agents entry sets `maxSteps`, `maxModelCalls`, `maxInputTokens`; decides the cache setting per (d). |
| 4.4 | Cross-checks receipts and ledger against `metrics.modelCalls`, `metrics.actionSteps` and `StepRecord.model`; maps every `AgentError` to UNKNOWN; zero ok actions never passes. |
| 4.5 | Probes run against a scripted `LanguageModelV4` double, which needs `ai` installed in the qualification tree. |
| 4.6 | Replay per (d); `reproduced` is informational. |
