# M1.4: AI Navigation (`agent` steps) Through a Governed Model Route: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved web scenario may contain an `agent` step `{ goal, maxActions }`. A model reads a redacted text snapshot of the candidate app and chooses navigation actions, for example finding an Export button whose label and test ID have changed. The model never decides a verdict: the deterministic assertions after the step (`csv`, `text`, `visible`) decide, exactly as in M1.2 and M1.3. Every model call goes through one governed route in the worker, with budgets, timeouts, redacted prompt and response logs, and no credentials. Every chosen action is recorded, so a verified round can be audited and replayed without the model. This ships to mainline and is proven live in TEST.

**Architecture:** M1.4 builds on the merged M1.3 application path (accounts registry, form login, kind-keyed bindings, mocks, capture, display v2, baseline round). Most of the plumbing is already in place: `E2EPolicy.modelRouteRevision`, the admission's `modelRoute { routeId, routeRevision }`, `E2ERunBinding.modelRouteRevision`, `modelReceiptIds`, `governedModelReceipts`, `agentOperationRefs`, the `agent-operation` evidence kinds, `application-runtime-bootstrap.ts`'s `host.modelFactory` (provider `agentx-e2e`, `specificationVersion: "v4"`) and the result adapter's agent and receipt checks. What is missing is listed below. M1.4 adds these pieces and changes nothing else:

- **Model route registry.** The broker holds versioned route definitions (provider, model, budgets, prompt protocol). Setup approval pins `{ routeId, routeRevision }` into `policy.modelRouteRevision`, using the same pattern as the M1.3 account registry.
- **A governed route in the worker** (`@agentx/model-runtime` plus a per-run proxy in the worker). It is the only code that holds provider access. It enforces budgets and timeouts, refuses any prompt that contains a run credential, writes receipts, and stores redacted transcripts.
- **A model channel that is a Unix socket, not a network service.** The socket is bind-mounted into the executor container only. The app container shares the run's `rvi` bridge, so a `model-proxy:8080` service on that bridge (as the M1 plan's sketch had it) would let candidate code spend the budget and talk to the model. The executor's network stays `--internal`. This replaces the M1 plan's sketch (see D9).
- **The agent step driver.** `web-runtime.ts`'s `case "agent"` runs e2e 0.20.0's `agent.act` through a custom executor built with `createToolLoopExecutor` and a closed toolset, with the route's budgets (M4-B: the built-in agent's toolset cannot be pinned through config, and `act` has no `vision` option; see the Ruling). The agent's download is captured, and its actions are written to an action ledger.
- **Fail-closed result mapping.** Any model or agent problem makes the case UNKNOWN. Receipts from the worker are cross-checked against the executor's report.
- **Audit replay.** An operator-triggered `purpose: "replay"` round re-runs the recorded actions with no model channel mounted. It is informational, like the M1.3 baseline round.
- **Three new qualification probes** run against a scripted model double, so qualification costs no model spend and is deterministic.

**Tech Stack:** unchanged from M1.3 (Node 22.23.2, TypeScript 5.9.3, Vitest 5.0.1, `e2e@0.20.0`, `@e2e-dev/web@0.14.0`, `playwright-core@1.63.0`, Docker on AL2023 arm64 `m6g.large`, CDK, GitHub Actions). Model provider: the installation's configured provider (`MODEL_PROVIDERS`: Bedrock through the worker instance role, or Anthropic, OpenAI or OpenRouter through the provider key's Secrets Manager ARN), reached through `@agentx/model-runtime` and pi-ai, the same layer as the coding agent. No new provider SDK.

**Spec:** `docs/specs/rovara-e2e-runtimes/roadmap.md` (M1.4 row); `m1-browser-api-plan.md` (the M1.4 section, which this plan replaces); `m1-3-plan.md`; `node_modules/e2e/docs/{agent-steps,cache,executors,models}.mdx` and `reference/{agent,config,security}.mdx` (the e2e 0.20.0 agent contract); the owner's working mode (memory `rovara-test-fast-process`).

## Scope

### In

| Item | Source | Why it is in M1.4 |
|---|---|---|
| Model route registry, with the route pinned at setup approval | M1 plan Task 4.1 ("the policy's `modelRouteRevision` selects the route") | The policy field exists, but nothing writes it. A route must be versioned and re-checked at dispatch, like accounts. |
| Governed route in the worker: budgets, timeouts, credential refusal, receipts, redacted transcripts | Must-have | It is the only path to a model. Do **not** port the `e2e-model-*` governance stack (M1 plan). |
| Executor model channel over a Unix socket, executor only | Must-have (sandbox) | Model egress happens only from the worker. The app can't reach the channel. |
| `agent` step driver over e2e `agent.act`, with download capture and an action ledger | Roadmap exit | This is the exit demo: a renamed Export button. |
| Capability gating: `agent` becomes executable only on a qualified profile with an approved route, on a worker that advertises the feature | `m1-browser-api-plan.md` Task 2.2 (`agent-steps-arrive-in-m1.4`) | It replaces the fixed M1.4 reason with real readiness reasons. |
| Fail-closed result mapping and receipt cross-check | Must-have | An outage, a budget hit or a wrong action gives UNKNOWN, never PASS. |
| Audit replay without the model | Must-have (determinism) | A verified round can be audited and re-run with no model spend. |
| Display: an "AI-navigated" badge, the element the agent acted on, the agent's stop reason | M1.3 display v2 | The owner must see that a model navigated and that a check decided. |
| Deploy check: route readiness and the worker feature | M1.3 Task 3.0 | Each M1.2 live retry came from drift that the check would have caught. |
| One provider for the whole installation for the e2e agent (Bedrock, Anthropic, OpenAI or OpenRouter), through model-runtime and pi-ai | Owner 2026-10-21 (amendment A1, Ruling M4-Q) | The AI navigation agent uses the installation's configured provider, not a Bedrock-only path. ChatGPT plans stay out. |

### Out (deferred further)

| Item | Deferred to | Why |
|---|---|---|
| `agent.assert`, `agent.extract`, `agent.waitFor` (model judgments) | Never as a gate | A model never decides a verdict. Only `agent.act` exists in Rovara. |
| Vision (screenshots sent to the model) | Not scheduled | Text snapshots are enough for the exit demo. Pixels widen what leaves the run. |
| `agent` steps on API targets, mobile or desktop | M2 and M3, per runtime | Each runtime adds its own descriptor and probes. |
| `Secret` params or `type_secret` in agent steps | Not scheduled | Login stays deterministic (M1.3 form login, before the agent step). The agent never handles a credential. |
| ChatGPT plans for e2e | Not scheduled | A ChatGPT sign-in is a personal token, not an installation credential. |
| Automatic replay after every verified round | D4 | It costs one runner round per verification. Replay is on demand in M1.4. |
| Mixed portable + application plans (Ruling BE) | Follow-up issue (as in M1.3) | Unchanged. |
| The e2e replay cache as a speed-up for candidate rounds | Not scheduled | Candidate rounds never replay. Replay is only an audit tool. A candidate round with an agent step uses a capture-only `cache.store` whose `read` always misses (M4-A), so e2e hands Rovara the `ActionTrace` of a verified step; see the Ruling (d). |

## Global Constraints

Everything in the M1 and M1.3 Global Constraints still applies (containers, labels, result semantics, deterministic assertions, mocks in-network only, credentials never leave the run, capture budget, parsed-form comparisons, mixed-fleet back-compat, owned files, TEST changes through scripts only). In addition:

- **The agent only navigates.** A Rovara scenario may use `agent.act` only. Its own verdict (`passed`, `failed` or `blocked`) is never a case verdict. A case is PASSED only when every deterministic assertion passes on evidence the collector re-derives itself. A scenario must have at least one deterministic assertion after its last `agent` step; one that has none is refused at APPROVE with `agent-step-needs-assertion`.
- **One route, pinned.** The route definition is `{ routeId, revision, scope: "standard" | "qualification", provider, modelId, region | null, inferenceProfileArn | null, secretArn | null, openRouter: { allowFallbacks: false, requireParameters: true, dataCollection: "deny", only } | null, budgets, promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: "low" | null, vision: false, payloadShape?: "minimal" }`, where `provider` is one of `MODEL_PROVIDERS` or the qualification-only `rovara-scripted`. `routeId` may contain single `/` separators. The `rovara-scripted` provider (route ids `rovara-scripted/...`, no region, no profile, no secret) exists only on qualification-scoped routes, and a receipt from it is never accepted for a non-qualification round. A Bedrock route pins its `region` and reads no secret; when `inferenceProfileArn` is set it is the identifier that is invoked (in the same region, and a system profile must be the profile of `modelId`), otherwise `modelId` is. A keyed route (Anthropic, OpenAI, OpenRouter) pins its `secretArn` (an ARN only, never a value) and has no region or profile; OpenRouter also pins its routing policy. The route's provider is the installation's worker provider at setup approval; the worker refuses a route whose provider or secret ARN differs from its own settings. **Which model (Task 4.10):** the model is the installation's choice (SSM `worker-e2e-agent-model`; `default` is Rovara's recommendation per provider) among the models the generated catalog table calls eligible (`packages/contracts/src/e2e-agent-models.generated.ts`: chat models of the adapter the e2e invoke uses, context window at least 33,024, no reasoning-content replay, no router alias or batch id; on Bedrock a system inference profile of the installation's geography or `global.`). On Bedrock the routing scope is the id's prefix, so it is pinned in the digest and a change forces re-approval; the approval names the scope in the owner-approved words. `payloadShape: "minimal"` (absent means standard; default digests do not move) is what one driving-test retry found to work, and is part of the digest. **No route is approvable without a passed on-account driving test for its exact digest** (all four providers); `model-route-not-tested` at dispatch otherwise. Sampling is the provider default (Haiku 5.5 rejects `temperature: 0`, so no temperature, top-p or top-k is ever sent); Claude thinking is off. Its digest is the `routeRevision`. The worker refuses any call whose effective model differs from the definition (a keyed provider's served model must be the pin or the pin with a date suffix; Bedrock reports none, so its pin is held by what is invoked). The coding-task fallback (`createModelRuntimeWithFallback` to the default Bedrock model) is **never** used for e2e: a route that can't serve its own model, or whose provider secret is missing, makes the case UNKNOWN.
- **Budgets (exact values; owner decision D2):**
  - per agent step: `maxActions` ≤ **8** (the contract allows 100; approval refuses more than 8 with `agent-step-over-budget`). This sets e2e `maxSteps = maxActions` and `maxModelCalls = maxActions + 4`.
  - per model call: timeout **30000 ms** (an AbortSignal on the provider call), output ≤ **1024** tokens, input ≤ **32000** tokens (this is below the existing `maxModelTokensPerCall: 64_000` in `application-evidence.ts:204`), prompt body ≤ **256 KiB**.
  - per agent step: deadline **90000 ms**, capped by the case timeout and the run deadline.
  - per group: ≤ **3** agent steps, ≤ **40** model calls, ≤ **400000** input tokens.
  - per project per UTC day (TEST): ≤ **2000000** input tokens and ≤ **400** calls. The counter lives in the broker table, and dispatch reserves budget for a group before it starts. Hitting any cap gives UNKNOWN `model-route-budget-exhausted`.
  - **No retries** of a model call. A provider error, throttle or timeout ends the step.
- **The model channel.** For each run the worker creates `<workspace>/model/model.sock` (mode 0600, owned by uid 1000) and mounts it into the executor container only, at `/run/rovara/model.sock`. The protocol is `rovara-e2e-model-channel/v1`: HTTP/1.1 over the socket, `POST /v1/generate` only, request ≤ 256 KiB, response ≤ 32 KiB, at most one call in flight. The app, build, seed and mock containers never get the mount. The executor keeps `--network <rvi>` (internal), and no container gets any provider host, key or `AWS_*` variable. A run whose admission has `modelRoute: null` gets no socket (the existing `(modelRoute === null) === (modelProxyRef === null)` check in `application-services.ts:497`).
- **No credentials to the model.** Before each provider call, the worker scans the prompt bytes for every seeded password, every account email and its local part, every `Set-Cookie` value the executor reported, and the patterns `AKIA[0-9A-Z]{16}`, `-----BEGIN`, `sk-` followed by 16 or more key characters and not preceded by a letter or digit, and `xox[abp]-`. (Amendment from Task 4.1: a bare `sk-` matches ordinary words such as `task-list` and `disk-usage`. The account email and its local part are replaced with a placeholder where they are page text the agent did not write, and refuse the call where the agent typed them. The provider key the route holds is added to the secret set.) Any match refuses the call (receipt outcome `refused-credential-match`), and the case is UNKNOWN with `model-prompt-credential-match`. The e2e runner already masks secure fields as `value=<secure>`. The scan is defence in depth.
- **Logging.** Each call writes one receipt `{ receiptId, runId, caseId, stepIndex, callIndex, routeId, routeRevision, provider, modelId, startedAt, servedModelId (null when the provider does not say), servedUpstream, inputTokens, outputTokens, latencyMs, promptSha256, responseSha256, outcome: "ok" | "provider-error" | "timeout" | "budget" | "refused-credential-match" | "refused-protocol" | "refused-busy" | "invalid-output" }`. Every request the worker receives gets a receipt, and the worker assigns `callIndex` (per step) and the identifiers from its own run state.
  - The relation to the e2e report (M4-F): every call the report counts has exactly one `ok` receipt, any other receipt has a non-`ok` outcome, and all of them count toward the step and group budgets (`checkE2EStepModelAccounting`).
  - The receipt is written by the worker, never by the executor.
  - The redacted prompt and response go to operator-only evidence as `agent-operation-source`, at most 1 MiB per group, inside the 8 MiB group cap. Over that, the bodies are omitted (`omitted: "budget"`) and the receipts still verify.
  - Transcripts never appear on the task page or in Slack.
  - Structured logs (`console.info` JSON) carry the receipt fields only, never prompt text.
- **The action ledger is always kept.** Per case: `agent-actions.json` `{ schemaVersion: "rovara-agent-actions/v1", steps: [{ stepIndex, goalDigest, verdict: "concluded" | "cut-short" | "failed", actions: [{ tool, node: { role, name ≤ 120, testId | null }, valueDigest | null, valueLiteral | null, url | null, snapshotSha256, outcome }], stopCode, receiptIds }] }`, at most 64 KiB (the structural caps keep it under), redacted. Typed values are recorded as keyed digests (HMAC-SHA256 under a per-run key), plus the literal when the literal appears in the approved goal. `url` is an app-relative path without query or fragment. Readers must obtain the ledger through `parseVerifiedE2EAgentActionLedger`, which checks it against the approved goals and returns the branded `VerifiedE2EAgentActionLedger`.
- **Pinned agent toolset.** The tools are `tap` (click), `type`, `press`, `select`, `scroll` and `navigate`, with navigation same-origin only (e2e already denies non-http schemes, and the network is internal). No pixel tools, no project tools, no `upload`, no `vision`. The Ruling records how: a custom executor with a closed toolset (the built-in agent cannot be pinned through config).
- **Deploy after every task (owner working mode).** Each task merges into the milestone branch and is deployed to TEST with `scripts/test-deploy.ts --check` before and after. Agent steps stay unavailable in TEST until the route is approved at setup (Task 4.9). So every intermediate deploy is dark and safe: `modelRouteRevision` stays null, and gating refuses.
- **Native journey per new shape.** Every new shape gets a case in `tests/e2e/m1-4-journeys.test.ts`, gated like `m1-web-journey.test.ts` and run in CI `linux-runtime`, with the scripted model double.
- **Owned files**, one task at a time: `broker.ts`, `developer-tasks.ts`, `packages/contracts/src/index.ts`, `package-lock.json`, `docker-application-host.ts`, `executor/run.ts`, `web-runtime.ts`, `application-result-adapter.ts`.
- **No production release** (D10). No AWS change outside `scripts/test-deploy.ts`, `scripts/test-qualify-runtime.ts`, `scripts/test-model-canary.ts` (the TEST model check, Task 4.10) or a guarded change set. The model checks are also reachable through the control plane (`POST /v1/admin/e2e/model-checks`, `GET /v1/admin/e2e/model-checks/<checkId>`) and `agentx project model-check discover|test`.

## Review Focus

1. **A model can't produce a PASS.** The test cases: an agent that says `passed` without acting; an agent that clicks the wrong button; a timeout; a budget hit; a provider error; invalid output; receipts that don't match the report. Each one is UNKNOWN or a deterministic FAILED, and never PASSED. Tests: Task 4.4 and the `agent-wrong-action` and `agent-model-outage` journeys.
2. **Containment.** The socket is mounted only into the executor. The executor's network is unchanged. The app can't reach the channel through a mount, a DNS name or the gateway. No provider credential, `AWS_*` variable or Bedrock endpoint appears in any container argument. Tests: Task 4.3 unit and Linux tests, and probe `web-agent-app-isolation-v1`.
3. **Credentials and redaction.** Seeded passwords, emails and cookies never reach a prompt, transcript, ledger, display row or Slack block. A planted credential on the page is refused at the worker, before the provider call. Test: Task 4.1 (a byte scan over every stored object), as in M1.3 Review Focus 4.
4. **The worker owns the receipts.** The executor can't forge, drop or add a receipt. The broker re-verifies receipt counts against the budgets, the receipt digests against the stored transcripts, and the route against the admission. Test: Task 4.4.
5. **The route is pinned.** No silent model fallback. A changed route definition is refused at dispatch with `model-route-changed-reapprove`. Tests: Tasks 4.2 and 4.1.
6. **Replay never gates.** A replay result can't satisfy or block publication, set `qualifiedRound` or `failedRound`, or trigger send-back, and the model channel is absent during replay. Test: Task 4.6.
7. **Raw vs parsed** (the FX3 lesson). The route definition, admission `modelRoute`, receipts and ledger are compared in parsed form.

---

## M1.4 tasks

**Order and parallelism** (at most 3 implementers at once, each in its own worktree, merged into the milestone branch in turn and deployed to TEST after each merge):

| Group | Tasks (in parallel) | Why they don't collide |
|---|---|---|
| **G1** | 4.0 (channel contract + e2e Ruling), 4.7 (fixtures), 4.8 (deploy check) | 4.0 owns the contracts barrel. 4.7 touches only `tests/fixtures` and `scripts/fixtures`. 4.8 touches only `scripts/`. |
| **G2** | 4.1 (governed route + worker proxy), 4.2 (route registry + gating) | 4.1 creates new files in `model-runtime` and `worker`. 4.2 owns `broker.ts`, `developer-tasks.ts` and the contracts plan files. |
| **G3** | 4.3 (executor channel + agent driver) | It owns `docker-application-host.ts`, `executor/run.ts` and `web-runtime.ts`, and needs 4.0 and 4.1. |
| **G4** | 4.4 (result mapping + receipts + display), 4.5 (qualification probes) | 4.4 owns `application-result-adapter.ts` and the broker evidence and notifier files. 4.5 owns `install-qualification.ts`, the probe assets and the catalog. |
| **G5** | 4.6 (audit replay) | It needs 4.4's ledger, and owns `broker.ts` again. |
| **G6** | 4.9 (ship: PR E, deploy, requalify, route approval, live demo) | |

### Task 4.0: Model channel contract and the e2e agent Ruling

**Files:**
- Create: `packages/contracts/src/e2e-model-channel.ts` (channel request and response, receipt, action ledger and route definition schemas); modify `packages/contracts/src/index.ts` (the barrel export, so later tasks never touch it)
- Create: `docs/specs/rovara-e2e-runtimes/m1-4-e2e-agent-seam.md` (Ruling record)
- Test: `tests/contract/e2e-model-channel.test.ts`

**Interfaces:**
- `E2EModelRouteDefinitionSchema`, `E2EModelChannelRequestSchema` (`{ schemaVersion: "rovara-e2e-model-channel/v1", runId, caseId, stepIndex, callIndex, call }`; `call` is the bounded subset of the AI SDK v4 `doGenerate` options that e2e 0.20.0 sends: prompt messages, tools, toolChoice, maxOutputTokens), `E2EModelChannelResponseSchema`, `E2EModelReceiptSchema`, `E2EAgentActionLedgerSchema`, with the bounds in Global Constraints.
- `e2eModelRouteRevision(definition) = "r" + n + "-" + sha256(canonicalJson(parsed))[0:12]`.
- Also exported for the later tasks: `e2eModelRouteInvokedIdentifier`, `e2eModelReceiptAdmissibleForRound`, `checkE2EStepModelAccounting` and `checkE2EGroupModelBudget` (the receipt relation and budget clamp), `parseVerifiedE2EAgentActionLedger` with `VerifiedE2EAgentActionLedger` and `isVerifiedE2EAgentActionLedger`, `crossCheckE2EAgentLedgerReceipts`, `reviewCapturedE2EAgentTrace` with `E2EAgentTraceBindingSchema`, and the keyed digests `e2eAgentValueDigest`, `e2eAgentValueKeyId` and `generateE2EAgentValueKey`.
- The Ruling answers, with file and line references into `node_modules/e2e/dist`:
  - (a) the exact `doGenerate` options and result shape the built-in agent uses;
  - (b) how to pin the toolset and disable pixel tools and `vision`;
  - (c) where the report records `act` actions (node ids, roles, names) and stop codes;
  - (d) whether a custom `cache.store` can serve replay from Rovara's ledger, read-only.

  If (b) can't be pinned through config, the fallback is a custom `executor` (`createToolLoopExecutor`) with the closed toolset. The Ruling records the choice.

- [ ] **Step 1: Write the failing tests.** The schemas reject a request over 256 KiB, an unknown `call` key, a receipt with `outputTokens > 1024`, and a ledger entry with a raw value that doesn't appear in the goal. `e2eModelRouteRevision` is stable under key reordering (parsed form).
- [ ] **Step 2: Run** `npx vitest run tests/contract/e2e-model-channel.test.ts` and expect FAIL. **Implement. Run again** and expect PASS.
- [ ] **Step 3: Write the Ruling** (doc only). **Commit** `feat(contracts): governed e2e model channel, receipt and action ledger schemas`. Deploy: none (contracts only); run `--check` to confirm there is no drift.

### Task 4.1: Governed e2e model route and the worker proxy

**Files:**
- Create: `packages/model-runtime/src/e2e-route.ts` (`createGovernedE2EModelRoute`), `packages/worker/src/e2e-model-proxy.ts` (the per-run socket server), `packages/worker/src/e2e-model-scripted.ts` (the scripted double, route `rovara-scripted/v1`)
- Modify: `packages/model-runtime/src/index.ts` (export)
- Test: `tests/unit/e2e-model-route.test.ts`, `tests/unit/e2e-model-proxy.test.ts`

**Interfaces:**
- `createGovernedE2EModelRoute(definition, { invoke, now }): { generate(call, signal): Promise<{ result, receipt }> }`
  - It enforces the per-call timeout, the token limits (a true upper bound from the prompt size is checked before the call), provider-default sampling and the pinned model.
  - It never calls `createModelRuntimeWithFallback`.
  - `invoke` is `createE2EProviderInvoke(definition)` (model-runtime, pi-ai API adapters, one attempt, no `temperature`, Claude thinking disabled, `cacheRetention: "none"`, explicit key, region and base URL); the proxy refuses to start on a redirecting environment (list in the M4-Q ruling).
- `startE2EModelProxy({ socketPath, runId, route, budgets, credentialSet, evidence, deadlineAt }): { close(): Promise<ReceiptSummary> }`
  - It accepts only `POST /v1/generate` for its own `runId`.
  - It reserves group budget, runs the credential scan, writes receipts and redacted transcripts, and serves one call at a time.
  - `close()` unlinks the socket and returns the receipt list. That list is the source the collector uses (`governedModelReceipts`).
- The scripted double answers from a script keyed by `goalDigest`. It picks the snapshot node whose accessible name matches a regex, or declares done without acting (for the negative tests). Its route is admissible only when the policy is a qualification policy or the CI harness sets `ROVARA_E2E_SCRIPTED_MODEL=1`. The registry refuses it for project setups.

- [ ] **Step 0 (spike, time-boxed to half a day):** show (a) the e2e loop's tool calls round-trip through the pi-ai invoke for each provider (fake fetch, or a loopback Bedrock endpoint), and (b) a Bedrock 429 reaches the endpoint exactly once. Record the outcome in the Task 4.0 Ruling (M4-Q).
- [ ] **Step 1: Write the failing tests.**
  - A call over a step or group call limit is refused with `budget`. At the default caps the step limit (`maxActions + 4` = 12 calls) and the 3-agent-step cap bind first, so at most 36 calls are served per group: the 13th call of a step and every call of a fourth step are refused, and the group cap of 40 is tested at a lowered value.
  - A call that takes 30001 ms is aborted, with outcome `timeout`.
  - A provider 429 is not retried (outcome `provider-error`).
  - A prompt containing the seeded password, the email local part or a planted `AKIA…` string is refused before `invoke` is called.
  - A response from a different `modelId` is `invalid-output`.
  - The day cap of 2000000 input tokens refuses with `model-route-budget-exhausted`.
  - The stored transcripts contain no seeded credential (byte scan).
  - Unlinking on `close()` happens even when the run is aborted.
  - The socket is mode 0600.
  - Calls for another `runId` are refused.
  - The environment guard refuses to start on each redirecting variable (one test per variable), the final payload has no sampling parameter and has Claude thinking disabled on each provider, a served model mismatch on a keyed provider is `invalid-output`, a missing provider secret gives `provider-error` with no fallback, and a test fails if the pinned pi version's catalog lacks the default e2e model for any provider.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(model-runtime): governed e2e model route with budgets, credential refusal and worker-owned receipts`. **Deploy** the worker image (dark: nothing starts the proxy yet), with `--check` before and after.

### Task 4.2: Model route registry, approval and capability gating

**Files:**
- Modify: `packages/contracts/src/e2e-application-execution-plan.ts` (replace `AGENT_STEPS_UNAVAILABLE_REASON` at `:44` and the gate at `:297` with readiness reasons), `packages/contracts/src/e2e.ts` (approval refusals), `packages/contracts/src/e2e-runtime-capabilities.ts`
- Modify: `packages/broker/src/aws/broker.ts` (setup approval writes the route; dispatch re-reads it and reserves budget), `packages/broker/src/aws/developer-tasks.ts` (APPROVE pins it), `packages/broker/src/e2e/feature-plan-planning-context.ts` (`:170` stops filtering out `agent` when the route is approved), `packages/broker/src/e2e/feature-plan-executable-kinds.ts` (`:15`), `packages/broker/src/e2e/application-admission.ts` (`modelRoute`)
- Modify: `packages/worker/src/main.ts` (feature string `task.workflowE2EAgentSteps.v1`)
- Test: `tests/contract/e2e-model-route-registry.test.ts` (new), `tests/contract/workflow-e2e-application-gating.test.ts`, `tests/unit/e2e-execution-plan.test.ts`

**Interfaces:**
- Storage goes in the existing broker table (no new table, no GSI):
  - `sk = E2E_MODEL_ROUTE#<routeId>#REV#<n>` holds the definition;
  - `sk = E2E_MODEL_ROUTE_LATEST#<routeId>` holds `{ revision, definitionDigest }`;
  - `sk = E2E_MODEL_BUDGET#<yyyy-mm-dd>` holds `{ inputTokens, calls }`, with conditional increments.
- Writer: setup approval (D5). Setup approval derives the route from the installation's `worker-model-provider` and (keyed) `worker-<provider>-secret-arn` (ARN only), using `DEFAULT_E2E_AGENT_MODELS`; the proposal reads "AI navigation: <provider label> `<model>`; at most 8 actions per step; checks decide". Dispatch re-derives the definition; any change (provider, model, ARN, OpenRouter policy) gives `model-route-changed-reapprove`. A provider without a configured secret leaves agent steps unavailable with `agent-route-not-approved`. Approval writes revision `n+1` only when the digest changes, and sets `policy.modelRouteRevision`.
- Readiness reasons replace the fixed M1.4 reason. An `agent` step is executable only when all three hold:
  - the READY descriptor's `supportedSteps` includes `agent` (Task 4.5); otherwise `agent-runtime-not-qualified`;
  - `policy.modelRouteRevision` is non-null and is the latest; otherwise `agent-route-not-approved`;
  - the target kind is `web`; otherwise `agent-steps-web-only`.
- APPROVE refusals: `agent-step-over-budget` (`maxActions` > 8), `agent-step-needs-assertion`, more than 3 agent steps in a group.
- Dispatch: a changed latest revision gives `model-route-changed-reapprove` (the FX4 re-approval route, with an AU-pattern sentence: "The AI navigation settings changed; approve the checks again"). A worker without `task.workflowE2EAgentSteps.v1` gets RUNTIME_UNAVAILABLE: "This worker can't run AI navigation steps yet; retry once it restarts". Budget reservation failure gives UNKNOWN `model-route-budget-exhausted` before the run starts.
- The planning context tells the planner to use deterministic steps where test IDs are known and stable, and an `agent` step only for UI the request changes, or where no test ID is approved. Each `agent` goal names the outcome ("Export the orders as a CSV file"), not a selector.

- [ ] **Step 1: Write the failing tests.**
  - With no route, an agent scenario stays unavailable with `agent-route-not-approved`.
  - With a route but a descriptor that lacks `agent`, it is unavailable with `agent-runtime-not-qualified`.
  - With both, the scenario selects one application group whose admission carries `modelRoute`.
  - `maxActions: 9` is refused; an agent step with no assertion after it is refused.
  - A stale revision at dispatch gives `model-route-changed-reapprove`.
  - A portable-only plan snapshot is unchanged.
  - The parsed approved intent equals `admission.intent`.
  - The planning-context string lists `agent` only when the route is approved.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.** Also run `npx vitest run tests/contract/workflow-e2e-*.test.ts`.
- [ ] **Step 3: Commit** `feat(e2e): versioned model route registry and capability-driven agent gating`. **Deploy** the control-plane code and the worker image, with `--check` before and after. Agent steps stay dark until the route is approved.

### Task 4.3: Executor model channel and the agent step driver

**Files:**
- Modify: `packages/verifier/src/host/docker-application-host.ts` (create `<workspace>/model`, mount the socket into the executor only), `packages/verifier/src/executor/host.ts` and `executor/entry.ts` (`modelFactory`: an `agentx-e2e` v4 model over the socket; the capture-only `cache.store` of M4-A), `packages/verifier/src/web-runtime.ts` (`:271` `case "agent"` → `agent.act`; the download trigger includes agent steps; the action ledger), `packages/verifier/src/executor/run.ts`, `packages/verifier/src/executor/redact.ts`
- Modify: `packages/worker/src/workflow-e2e-application-checks.ts` (start and close the proxy per group, pass `modelProxyRef` and the credential set)
- Test: `tests/unit/e2e-docker-application-host.test.ts`, `tests/unit/e2e-executor-agent.test.ts` (new), `tests/linux/e2e-agent.test.ts` (new), `tests/e2e/m1-4-journeys.test.ts` (cases `agent-renamed-export`, `agent-wrong-action`, `agent-model-outage`)

**Interfaces:**
- Executor argument additions: `-v <workspace>/model/model.sock:/run/rovara/model.sock`, and nothing else. App, build, seed and mock arguments are unchanged (asserted).
- `case "agent"` runs `agent.act(step.goal, { maxSteps: step.maxActions, maxModelCalls: step.maxActions + 4, timeout: min(90000, remaining) })` through the Ruling's custom executor with the closed toolset (there is no `vision` option on `act`).
- When the scenario has a `csv` assertion and the agent step is the last step that can trigger a download, the step runs inside `waitForDownload`:
  - the first download is the evidence;
  - a second one is UNKNOWN `ambiguous-download`;
  - none is UNKNOWN `agent-no-download`.
- The ledger is written after each action, so a crash still leaves the actions recorded up to that point. It carries `runId`, `caseId` and `valueKeyId`, and its typed-value digests are HMACs under the per-run key (`e2eAgentValueDigest`).
- Capture store (M4-A): a round with an agent step runs with `cache: { mode: "read-write", store: captureStore }` instead of `cache: "off"`. `captureStore.read` always returns a miss (so a candidate round never replays), `write` keeps the `ActionTrace`, and `delete` does nothing. After each agent step the worker runs `reviewCapturedE2EAgentTrace` (credential scan, match against the verified ledger). A kept trace's binding goes into the PASS evidence; a discarded trace only loses the replay input and never fails the round.

- [ ] **Step 1: Write the failing tests.**
  - unit: the executor arguments contain the socket mount and no `AWS_`, `AGENTX_`, `TOKEN`, `SECRET`, `bedrock` or `amazonaws`. The app and mock arguments contain no `model` mount. A `modelRoute: null` run has no mount.
  - unit: the ledger records the node's role, name and testId for each action, and digests a typed value that doesn't appear in the goal.
  - unit: the capture store's `read` always misses, its `write` keeps the trace, and a credential-scan hit discards the trace and leaves the round's verdict unchanged.
  - Linux (scripted double; the M1.4 fixture with `export-csv` renamed to `download-orders` and the label "Download orders"): the goal "Export the orders as a CSV file" downloads the CSV, and the `csv` assertion passes.
  - Linux: a double that declares done without acting gives UNKNOWN `agent-no-download`.
  - Linux: a double that clicks "Download invoices" (a decoy) gives a deterministic `csv` mismatch, which is FAILED (D3).
  - Linux: the proxy returning `provider-error` gives UNKNOWN `model-unavailable`.
  - Linux: from inside the app container, `/run/rovara/model.sock` is absent, and connections to `model-proxy:8080` and to the gateway on port 8080 time out.
  - journeys `agent-renamed-export` (PASS → publication checks non-empty), `agent-wrong-action` (UNKNOWN, publication blocked, retry offered), `agent-model-outage` (UNKNOWN).
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS** (Linux in CI `linux-runtime`; run the renamed-export Linux case 20 times before merge).
- [ ] **Step 3: Commit** `feat(e2e): agent steps navigate through the governed model channel; checks decide`. **Deploy** the worker and executor images, with `--check` before and after. The catalog is not yet changed, so this is still dark.

### Task 4.4: Fail-closed result mapping, receipt cross-check and display

**Files:**
- Modify: `packages/verifier/src/application-result-adapter.ts` (the agent rows at `:1331-1385`, the receipts at `:1518-1534`), `packages/verifier/src/application-collection.ts`, `packages/verifier/src/host/executor-readback.ts` (`governedModelReceipts` is no longer the fixed `[]` at `:195`), `packages/broker/src/e2e/application-evidence.ts` (`:236` accepts receipts when the route is non-null)
- Modify: `packages/broker/src/aws/workflow-e2e-notifier-projection.ts`, `packages/broker/src/e2e-presentation.ts`, `packages/broker/src/aws/developer-task-notifier.ts`
- Test: `tests/unit/e2e-application-collection.test.ts`, `tests/contract/workflow-e2e-agent-results.test.ts` (new), `tests/contract/workflow-e2e-notifier-projection.test.ts`

**Interfaces:**

| Agent outcome | Deterministic assertions | Case |
|---|---|---|
| act ended, evidence captured | all pass | PASSED |
| act ended, evidence captured | any mismatch | FAILED (send-back), D3 |
| e2e stop `STEP_BUDGET_EXHAUSTED` | any | UNKNOWN `agent-budget-exhausted` |
| `STEP_TIMEOUT` | any | UNKNOWN `agent-timeout` |
| `MODEL_UNAVAILABLE`, `MODEL_PROVIDER_FAILED`, or receipt outcome `provider-error` or `timeout` | any | UNKNOWN `model-unavailable` |
| `MODEL_OUTPUT_INVALID`, `STEP_NO_CONCLUSION` | any | UNKNOWN `agent-navigation-incomplete` |
| act `failed` or `blocked` with any other code | any | UNKNOWN `agent-navigation-incomplete` |
| no download, or more than one, for a `csv` case | n/a | UNKNOWN `agent-no-download` or `ambiguous-download` |
| receipt `refused-credential-match` | any | UNKNOWN `model-prompt-credential-match` |
| receipt `budget` (group or day) | any | UNKNOWN `model-route-budget-exhausted` |
| the receipt relation fails (`checkE2EStepModelAccounting`: ok receipts ≠ `metrics.modelCalls`, receipts beyond 8+4 that are not `budget` refusals, a missing or repeated receipt index or id, a receipt of another route, provider, model, run, case or step); a ledger receipt id that is not a worker receipt of that run, case and step (`crossCheckE2EAgentLedgerReceipts`); a ledger that is not a `VerifiedE2EAgentActionLedger`; a transcript digest ≠ receipt; actions > `maxActions`; ledger missing | any | UNKNOWN `model-receipts-mismatch` |
| `budget-refused` from the accounting checker (a `budget` receipt in the step) | any | UNKNOWN `model-route-budget-exhausted` |
| ledger step `verdict` other than `concluded` | any | UNKNOWN `agent-navigation-incomplete` |

- The act verdict `passed` alone never sets PASSED. An act `failed` never sets FAILED.
- Display v2 gains, per scenario, `agentNavigation?: { steps: [{ goal ≤ 120, actedOn: [{ role, name ≤ 60 }] ≤ 8, stop }], modelCalls, routeId }`. Readers built before M1.4 ignore it.
  - The page shows a badge, "AI-navigated: the model clicked 'Download orders'; the CSV check decided".
  - Slack adds one line per round: `AI navigation: 1 step, 3 model calls (checks decide)`.
  - Unknown reasons get plain sentences. For example, `agent-no-download` reads "The AI navigator didn't find a way to download the CSV; retry, or check the button exists".

- [ ] **Step 1: Write the failing tests:** one per table row, plus:
  - a forged extra receipt in the executor report is UNKNOWN;
  - a v1 reader falls back to "Open the task page";
  - no display row or Slack block contains a goal-external typed value or a credential.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): fail-closed agent results with worker-owned receipt verification`. **Deploy** the control-plane code, the worker and the executor, with `--check` before and after.

### Task 4.5: Qualification probes and descriptor capability

**Files:**
- Modify: `packages/verifier/src/install-qualification.ts`, `packages/broker/src/aws/e2e-feature-verifier-catalog.ts` (the web descriptor `supportedSteps` adds `agent`, and `modelChannel: "rovara-e2e-model-channel/v1"`)
- Create: probe assets under `packages/verifier/assets/application-runtime-v1/probes/`: `web-agent-scripted-v1`, `web-agent-wrong-action-v1`, `web-agent-app-isolation-v1`
- Test: `tests/unit/install-qualification-web.test.ts`, `tests/linux/e2e-agent-probes.test.ts`

**Interfaces** (14 required probes in all; requalify in Task 4.9):
- `web-agent-scripted-v1`: PASS. A scripted double finds the renamed button. Exactly one download, `csv` passes, receipts equal the report.
- `web-agent-wrong-action-v1`: EXPECTED_FAILURE = UNKNOWN `agent-no-download`. Any other cause rejects (Ruling X style).
- `web-agent-app-isolation-v1`: the app starts behind a guard that looks for `/run/rovara/model.sock` and connects to `model-proxy:8080` and to the gateway on port 8080, and starts only if every attempt fails. PASS proves isolation.
- The qualification policy uses route `rovara-scripted/v1` (no spend, no provider). The descriptor lists `agent` only when all three probes are accepted.

- [ ] **Step 1: Write the failing tests:**
  - the evaluator accepts the 14 expected outcomes;
  - it rejects `web-agent-wrong-action-v1` passing, and `web-agent-app-isolation-v1` starting while the socket is visible;
  - no pinned M1.3 probe digest moves.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): qualify agent navigation with scripted-model probes`. **Deploy** the worker, executor and control-plane code (`--check`). Requalification waits for 4.9, so the TEST catalog keeps `agent` absent until then.

### Task 4.6: Audit replay without the model

**Files:**
- Modify: `packages/broker/src/aws/broker.ts` (an operator-triggered `purpose: "replay"` round for a verified round), `packages/broker/src/aws/developer-tasks.ts` (replay is recorded apart from candidate rounds)
- Modify: `packages/verifier/src/application-scenarios.ts` and `application-templates.ts` (a replay config: `cache: { mode: "read-only", store: replayStore }`, `modelRoute: null`, an executor with no model), `packages/verifier/src/executor/host.ts` (a read-only cache store that serves the captured `ActionTrace` whose digest is in the PASS round's evidence manifest; the ledger is the audit view and is not turned into a cache entry, per M4-A)
- Create: `scripts/e2e-replay-round.ts --env agentxlivetest123 --task <id> --round <id>` (an admin route; read-only for verdicts)
- Test: `tests/contract/workflow-e2e-replay-round.test.ts` (new), `tests/linux/e2e-agent-replay.test.ts`, `tests/e2e/m1-4-journeys.test.ts` (case `agent-replay`)

**Interfaces:**
- Replay runs the same candidate SHA, admission and accounts. It mounts no model socket, so a replay that reaches the model is impossible: the bootstrap refuses `modelFactory` when `modelRoute` is null.
- The result is recorded only in `replay: { status, reproduced: boolean, downloadSha256Match: boolean, reason? }`.
  - `reproduced` is true when each agent step replays fully (`step.cache` replayed, no hand-off) and each case's evidence digests equal the verified round's.
  - A stale replay (`REPLAY_STALE`) or a hand-off records `reproduced: false`. Replay never hands off to a model.
- Replay never sets `qualifiedRound` or `failedRound`, never offers send-back, and never changes publication.

- [ ] **Step 1: Write the failing tests:**
  - a verified PASS round replays with `reproduced: true` and no socket in the executor arguments;
  - a ledger edited after verification is refused (its digest is bound to the verified evidence);
  - a replay FAILED leaves publication unchanged;
  - trace binding: a trace is used only when its digest is in the evidence manifest of a round whose Rovara verdict is PASS (a trace captured in an UNKNOWN or FAILED round is never replayed), and a trace that does not match the verified ledger one action at a time is discarded at capture (`reviewCapturedE2EAgentTrace`), so `reproduced: false` with no effect on any verdict;
  - the replay reads the ledger only through `parseVerifiedE2EAgentActionLedger` and requires the `VerifiedE2EAgentActionLedger` type;
  - journey `agent-replay`.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): audit replay of verified agent rounds without model calls`. **Deploy** (`--check`).

### Task 4.7: Fixtures (local Linux fixture and live baseline)

**Files:**
- Create: `tests/fixtures/orders-web-m14/` (a copy of the M1.3 orders fixture with the export button renamed: `data-testid=download-orders`, label "Download orders", plus a decoy `data-testid=download-invoices` labelled "Download invoices" that downloads a different CSV), `scripts/fixtures/publish-web-fixture.ts --variant m14`
- Test: `tests/contract/orders-web-m14-fixture.test.ts`

**Interfaces (exact fixture changes):**
1. **Live baseline (`--variant m14`)** = the M1.3 reference state after its demo: the viewer refusal, tenant isolation and inventory column are in place, and the button is still `export-csv` / "Export CSV". No `download-invoices` decoy is added live, so the demo stays one clear goal. The demo request (below) asks the coding agent to rename the button.
2. **Local Linux fixture** = the renamed button plus the decoy, used by Tasks 4.3, 4.5 and 4.6.
3. The README describes both. The `node --test` CI is kept.

- Publish (D6): the owner OKs the push to `main` of `abhishek255/rovara-orders-web-fixture` (outward-facing). The M1.3 demo PR is closed unmerged and kept as a link.
- [ ] **Step 1: Write the failing contract test. Step 2: build the fixture until it passes. Step 3: dry-run the publisher and show the owner the file list. Step 4: commit** `chore(fixtures): M1.4 orders fixtures with a renamed export button`.

### Task 4.8: Deploy check for route readiness and the agent feature

**Files:**
- Modify: `scripts/test-deploy-check.ts`, `scripts/test-deploy.ts`
- Test: `tests/unit/test-deploy-check.test.ts`

**Interfaces:** new `Finding.kind`s:
- `worker-feature-missing` gains `task.workflowE2EAgentSteps.v1`;
- `model-route-not-approved` (a warning until Task 4.9);
- Provider-aware route check (amendment A1): the check first reads the provider from SSM `worker-model-provider` (and, for keyed providers, `worker-<provider>-secret-arn`) through `ssm get-parameter`; these hold an id and an ARN, never a secret. If the deploy profile lacks the permission, it reports `unverifiable`. It never calls `GetSecretValue`.
  - All providers: `model-not-in-catalog` when `requireKeyedModel` or the catalog doesn't know the default e2e model.
  - `amazon-bedrock`: the existing checks stay (`get-inference-profile`, `get-foundation-model-availability`, and the template-based IAM evaluation for `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`). pi-ai uses ConverseStream, so `InvokeModelWithResponseStream` is the action that must be granted on the profile and its foundation-model ARNs in every Region the `us.` profile routes to (`model-access-unverified`, `iam-missing-grant`).
  - `anthropic`, `openai`, `openrouter`: `model-route-secret-missing` (the ARN setting is absent or doesn't match `SECRET_ARN_PATTERN`); `iam-missing-grant` (the deployed worker-role statements don't allow `secretsmanager:GetSecretValue` on that ARN; the finding names the worker instance role); `model-access-unverified` (info: key validity and credit can't be checked without a call). A customer-managed KMS key can't be evaluated from the ARN alone and is reported as `unverifiable`; no `describe-secret` call (owner O6).
  - `openrouter`, in addition: `model-route-openrouter-allowlist` (`worker-openrouter-providers` is set but excludes `anthropic`), `model-route-alias-refused` (the route id starts with `~` or `openrouter/`), and a warning that OpenRouter is a third-party processor (D8 must cover it). The OpenRouter default stays provisional until a canary records the served model (owner O5).
  - `E2E_MODEL_ROUTE` becomes `{ routeId: "rovara-e2e-default", provider, modelId }`, derived from the provider setting.

- [ ] **Step 1: Write the failing tests:**
  - a head that needs the agent feature, against a running worker without it, gives `worker-feature-missing`;
  - a route naming a model absent from the fixture listing gives `model-access-unverified`;
  - an inference-profile ARN outside the granted patterns gives `iam-missing-grant` naming the worker instance role.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.** **Commit** `feat(scripts): deploy check covers the e2e model route and agent feature`.

### Task 4.9: Ship PR E, deploy, requalify, approve the route, live demo

- [ ] **Step 1: Write the M1.4 section of `m1-live-acceptance.md`** (below).
- [ ] **Step 2: Open PR E** as a draft (Tasks 4.0–4.8 are already merged into the milestone branch and deployed task by task). Wait for every CI job, including `linux-runtime` with all `m1-4-journeys` cases. Give it one full Opus review; the review is security-sensitive (sandbox, verification, evidence), per the owner's working mode.
- [ ] **Step 3: Run `--check`** from the PR head. Any `iam-missing-grant` the head declares is applied under the standing TEST pre-approval (guarded change set), and the owner is told after. Anything undeclared goes to the owner as a Tier 3 packet.
- [ ] **Step 4: Requalify** with `test-qualify-runtime --apply` (14 probes; spend under D7). Retire the old runner after the rows are READY. Run `--check`: it must exit 0 except `model-route-not-approved`.
- [ ] **Step 5: Run a model canary** (owner OK for the first real provider call, D1): one call through the worker route on the installation's provider (TEST: Bedrock), recording the receipt, `providerPayloadSha256` and served model; the cost table in the M4-Q ruling is shown to the owner before the call. If model access is refused, stop and raise the Tier 3 item.
- [ ] **Step 6: Publish the fixture baseline** (D6), then **approve setup again** for `rovara-web-fixture`, so the registry writes the route at revision 1 and `policy.modelRouteRevision` is set. Run `--check`: exit 0.
- [ ] **Step 7: Run the live demo, the replay and (optionally) the outage drill.** Record them in `status.md` and `m1-live-acceptance.md`. Merge after owner approval (no production release).

---

## M1.4 live acceptance (TEST `agentxlivetest123`)

**Preconditions:**
- The PR E head is deployed, and `--check` exits 0.
- The rows `PROFILE#linux-arm64-web-api-v1#web` and `#api` are READY on the 14-probe revision, with more than 24 h to expiry, and the web descriptor lists `agent`.
- The model canary receipt is recorded.
- The fixture baseline (`--variant m14`) is published, and setup is approved again with the route shown.
- The Slack channel `#rovara-web-fixture` is bound.

**Fixture change, made by the request:** the base commit has the owner-only button `data-testid=export-csv` labelled "Export CSV". The request renames it to `data-testid=download-orders`, labelled "Download orders", and moves it into a toolbar. A deterministic `click export-csv` step can't survive that change; the agent step has to.

**Request (Slack, `#rovara-web-fixture`, exactly):**

> Rename the orders "Export CSV" button to "Download orders" (test id `download-orders`) and move it into a toolbar above the orders table. The downloaded CSV must not change, and viewers still must not see it.

**Expected plan** (one app, web + API, the route shown as "AI navigation: Bedrock `<model>`; checks decide"):

| Scenario | Kind / account | Steps | Assertion (decides) |
|---|---|---|---|
| `owner-export-ai` | web / `orders-owner` | `navigate "/"`, `agent { goal: "Export the orders as a CSV file", maxActions: 5 }` | `csv` equals the reference rows, including the `inventory` column (`a1,in-stock`, `a2,unavailable`) |
| `owner-toolbar-button` | web / `orders-owner` | `navigate "/"` | `visible` `download-orders`; `text` "Download orders" |
| `viewer-export-refused` | web / `orders-viewer` | `navigate "/"` | `visible` `download-orders` hidden, `export-csv` hidden |
| `viewer-export-api-refused` | api / `orders-viewer` | `request GET /api/orders.csv` | `http-status` 403 |

**Pass criteria** (all required):
1. **Approval.** The plan is approved with an `agent` step. The page shows the route ID and revision 1, and the badge text "checks decide".
2. **Baseline round on the unchanged code** (M1.3 D2). `owner-export-ai` is not run: a baseline skips AI navigation steps (Ruling CX, confirmed by the owner 2026-10-22), so it never calls the model. `owner-toolbar-button` is FAILED (`expected visible, was hidden`). The AI goal is judged on the candidate only (criterion 3).
3. **Candidate round, broker-verified PASS** for every required scenario:
   - the page shows "AI-navigated: the model clicked 'Download orders'; the CSV check decided";
   - receipts ≤ 9 calls for the step, every receipt `ok`, and the receipt route equal to the admission;
   - no `export-csv` in the candidate's DOM.

   If the coding agent's first candidate fails a check, record it, and the send-back loop runs as usual.
4. **Audit replay.** `scripts/e2e-replay-round.ts` on the verified candidate round gives `reproduced: true`, the same download digest, zero receipts, and no socket in the executor arguments (from the host journal).
5. **The draft PR** in `rovara-orders-web-fixture` has green CI.
6. **Evidence recorded in `status.md`:**
   - task, round and replay IDs, candidate SHAs;
   - the operator S3 keys of `agent-actions.json`, the receipts and the redacted transcripts;
   - the total model calls and tokens for the milestone, against the D2 caps;
   - the `--check` outputs before and after;
   - the catalog revision and runner ID.

   A byte scan of the stored transcripts for the seeded credentials finds nothing.
7. **No leftovers.** No `rovara.run` resources and no `model.sock` remain on the runner.

**Optional outage drill (D8):** approve a route revision whose model ID is a model the account can't use, and run the checks again. Expected: UNKNOWN `model-unavailable`, publication blocked, a retry offered, no PASS. Then restore the route and approve again.

**Not a pass:**
- a PASS whose case has no deterministic assertion after the agent step;
- any receipt that the worker didn't write;
- any model call from a replay;
- an agent stop treated as a verdict;
- a transcript visible on the page or in Slack.

## Risks

| Risk | Mitigation |
|---|---|
| e2e 0.20.0's built-in agent can't be pinned to a closed toolset through config, or its `doGenerate` shape doesn't map onto the provider path | Task 4.0 Ruling plus the Task 4.1 Step 0 spike before any driver work (done: the real loop round-trips through pi-ai for each provider). Fallback: a custom `executor` with the closed toolset. |
| The agent clicks a plausible wrong control, its CSV mismatches, and the result is FAILED, which sends back a correct candidate | The display names what the agent clicked. The owner can see the mis-navigation and retry rather than accept the send-back. D3 offers UNKNOWN instead. Live, there is no decoy, so the goal is unambiguous. |
| Sampling is the provider default, so navigation varies more than at temperature 0 | One clear goal, up to 8 actions, and the agent finds the button on the baseline as well. A flake is UNKNOWN (retry), never a false PASS. The Linux case runs 20 times in CI with the double. |
| Prompt injection from candidate page content | App content is quoted data in e2e's prompt. The agent's tools are closed and same-origin on an internal network. The model never decides a verdict. The credential scan refuses before egress. The worst case is wasted budget, which is capped. |
| Candidate page text (synthetic data) leaves the run to the provider | The text is synthetic; prompts are bounded to 256 KiB; vision is off; receipts and transcripts are kept. Depends on the provider: Bedrock stays in the same AWS account, and a keyed provider (Anthropic, OpenAI, OpenRouter) sends redacted synthetic page text to a third party. Owner accepts the data flow in D8, which covers each keyed provider as a data processor. |
| The provider's model access is not enabled (Bedrock in the TEST account), the key is invalid, a throttle, or the runner can't reach the provider | `--check` `model-access-unverified` and the provider-aware findings, and the Task 4.9 canary before the demo. A throttle is UNKNOWN, not a retry. Tier 3 item below. |
| The worker's model fallback swaps models silently | The e2e route never calls `createModelRuntimeWithFallback`. The receipt `modelId` must equal the definition, otherwise the case is `model-receipts-mismatch`. |
| The socket mount is a new container-to-worker channel | It is mounted only into the executor, and serves one endpoint and one run. Request and response are size-bounded, mode 0600, removed at close, and its isolation is probed (`web-agent-app-isolation-v1`). The executor's Chromium renderer is sandboxed (H2) and can't open Unix sockets. |
| Transcripts grow the evidence beyond the group cap | 1 MiB per group for bodies. Over that, bodies are omitted while receipts and the ledger stay. A dropped body never changes a verdict. |
| Replay is stale after harmless DOM changes | Replay is audit-only. `reproduced: false` is recorded with the e2e reason and never gates. |
| Intermediate TEST deploys expose half-built agent paths | Gating requires all three of: a qualified descriptor (4.5 plus requalification), an approved route (4.9) and the worker feature. Until then, agent steps plan as unavailable with a specific reason. |
| Rollback | A rollback to M1.3 is safe while no task holds display `agentNavigation`, route registry refs or receipts. Rolled-back readers ignore the new fields. TEST only. |

## Owner decisions (ask once, up front)

- **D1, model and provider:** the e2e agent uses the installation's configured provider, with that provider's small model, pinned at setup approval, never a fallback: Bedrock `us.anthropic.claude-haiku-5-5`, Anthropic `claude-haiku-5-5`, OpenRouter `anthropic/claude-haiku-5.5` (provisional until a canary records the served model), OpenAI `gpt-5.4-mini`. The provider call goes through model-runtime and pi-ai; `@aws-sdk/client-bedrock-runtime` is not added to model-runtime. The first real call (the Task 4.9 canary) runs only with the owner's OK.
- **D2, budgets:** at most 8 actions per step, `maxActions + 4` calls, 30 s per call, 90 s per step, 40 calls and 400k input tokens per group, and 2M input tokens and 400 calls per project per day in TEST, with no retries. Approve these values, or set others. Please confirm the cost ceiling from current Bedrock pricing.
- **D3, a mismatch after an AI-navigated step:** FAILED, with send-back offered and the display showing what the agent clicked (recommended, because the CSV bytes are real app output). The alternative is UNKNOWN, with a retry: safer against a mis-click, but an AI-navigated check can then never send back.
- **D4, replay:** on demand only (an operator script), plus once in the live acceptance. Alternative: an automatic replay after every verified agent round (one extra runner round each). Recommended: on demand.
- **D5, route approval:** the route is written at setup approval and shown in the setup proposal, and a change requires re-approval (the M1.3 account-registry pattern). Alternative: a separate admin CLI step. Recommended: at setup.
- **D6, fixture baseline:** may Rovara push the M1.4 baseline (the M1.3 reference state, with the button still "Export CSV") to `main` of `abhishek255/rovara-orders-web-fixture` and close the M1.3 demo PR unmerged? Recommended: yes.
- **D7, spend:** up to 3 qualification runner launches (`m6g.large` plus 20 GiB gp3), plus model spend within the D2 caps for CI-free live runs (the canary, the demo, re-runs and the drill). Pre-approve both, or ask each time?
- **D8, data and drill:** accept that redacted page text from candidate apps (synthetic data only) is sent to Bedrock, and that transcripts are kept as operator-only evidence under the existing private-artifact retention. Also, should the optional live outage drill run? Recommended: accept both; run the drill.
- **D9, channel deviation:** use a Unix socket mounted only into the executor, instead of the M1 plan's `model-proxy:8080` on the run network, because the candidate app shares that network. Recommended: yes.
- **D10, release:** M1.4 merges to mainline without a production release, as M1.2 and M1.3 did. M1 exit follows, and then the M2 plan.

## Needs Tier 3 approval

- **Model provider access:** for a Bedrock install, Bedrock model access for the D1 model in the TEST account and region (and `bedrock:InvokeModelWithResponseStream` on the profile and its foundation models). If it is not already enabled, the owner enables it (Anthropic models may need the one-time use-case form) in the console. Rovara never does this by script. A keyed install already has its provider secret. The first real model call (the canary) is owner-approved.
- **IAM:** none expected. The worker instance role already has `BedrockModelInvocation` (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on `foundation-model/*` and on account resources). To verify:
  - (a) the qualification runner uses that role;
  - (b) ConverseStream (the call pi-ai makes) is authorized by `bedrock:InvokeModelWithResponseStream`;
  - (c) the cross-region `us.` inference profile resolves under the granted ARNs.

  If the Task 4.8 check finds a gap that the head code declares, it is applied under the standing TEST pre-approval, and the owner is told after. Anything undeclared, for example a read permission the deploy check needs to list model availability, comes as one packet: the exact statement, role, guarded change set and rollback.
- **Secrets:** none new; a keyed install reuses its existing provider secret, read by the worker role it already has.
- **Network:** no new egress. Containers get none. The worker already reaches Bedrock for coding tasks. To verify (canary): that the qualification runner's subnet reaches `bedrock-runtime` the same way. If it needs a VPC endpoint or a route, that is an infra change for Tier 3.
- **Spend:** runner launches and model spend (D7).
- **Outward-facing:** pushing the fixture baseline and closing the M1.3 demo PR (D6).
- **Production:** nothing. The Release transition stays disabled (D10).


## Owner decisions (recorded 2026-10-21)

All recommended: D1 latest small Claude (Haiku) model available on Bedrock in TEST, pinned, no fallback (resolved by ruling M4-K to `us.anthropic.claude-haiku-5-5`) (verify ID/availability before the first call). Amended 2026-10-21 (A1, M4-Q): the provider is the installation's configured one with its own small model, called through model-runtime and pi-ai; @aws-sdk/client-bedrock-runtime is not added; D2 plan budgets, estimated max daily cost shown before the first live call; D3 mismatch after an AI-navigated step is FAILED with send-back; D4 replay on demand plus once live; D5 route approval at setup approval, re-approve on change; D6 push the M1.4 fixture baseline and close the M1.3 demo PR unmerged; D7 up to 3 runner launches plus model spend within D2 caps pre-approved; D8 synthetic page text to Bedrock accepted, transcripts operator-only, live outage drill skipped (CI only); D9 Unix socket mounted only into the executor; D10 merge to mainline, no production release.
