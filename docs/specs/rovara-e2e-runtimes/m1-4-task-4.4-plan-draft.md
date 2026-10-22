# M1.4 Task 4.4 plan draft: fail-closed result mapping, receipt cross-check and display

> Draft for owner review. No code in this commit. Base: `claude/rovara-m1-4-t43b` (Tasks 4.0–4.3b on top of M1.3).
> Parent plan: `m1-4-plan.md` (Task 4.4, Global Constraints, Review Focus 1, 4, 7). Line numbers below are from this base.

## Goal

A case with an `agent` step gets a Rovara verdict that a model cannot move toward PASS:

1. The worker uploads its receipts, the executor's action ledgers, the run value key, the route definition and the redacted transcripts with the group's evidence. Today they stay in worker memory and are logged as counts only.
2. The broker's own re-collection (`requalifyGroup`) checks them against the e2e report and the admission: `checkE2EStepModelAccounting`, `checkE2EGroupModelBudget`, `parseVerifiedE2EAgentActionLedger`, `crossCheckE2EAgentLedgerReceipts`, and transcript digests. It then maps every agent and model outcome to the fixed UNKNOWN codes in the parent plan's table. The same check runs in the worker's collector, but only as an early signal.
3. The deterministic assertions alone still decide PASSED or FAILED (D3: a `csv` mismatch after AI navigation is FAILED, with send-back).
4. Display: rows gain `agentNavigation`, there are plain sentences for every new UNKNOWN code (including the route-mismatch codes `model-route-changed-reapprove` and `agent-route-not-approved`), Slack gets one line, and the baseline shows the AI scenarios it skipped (BASEREASON).
5. The journey verdict assertions that 4.3b deferred (`agent-renamed-export`, `agent-wrong-action`, `agent-model-outage`) are finished.

## What the code does today (facts the plan relies on)

- **Worker** (`packages/worker/src/workflow-e2e-application-checks.ts:338-365`): `modelChannelFor` opens `openE2EModelChannelSession` with `createE2EModelEvidenceCollector()` (`e2e-model-channel-session.ts:101-113`, in memory only). `close()` returns an `E2EModelReceiptSummary` (`e2e-model-proxy.ts:103-120`: `receipts`, `droppedRequests`, `unscopedRequests`, `overrun`, `evidenceErrors`, `chargedInputTokens`, `transcriptBytes`) and logs counts only. Transcripts are never read back.
- **Host** (`packages/verifier/src/host/docker-application-host.ts`): it generates the value key (`:687`, `generateE2EAgentValueKey()`), writes it into the executor plan as `plan.modelChannel.valueKey` (`:692`) and passes it to `modelChannel.open` (`:603`). `closeModelChannel` (`:362-366`) **discards** the summary (`close(): Promise<unknown>`).
- **Readback** (`host/executor-readback.ts`): `readAgentEvidence` (`:186-218`) reads `agent/<case>/agent-actions.json` (≤ 256 KiB each, ≤ 64) and traces into `ExecutorOutputEvidence.agent`. `assembleDockerCollectionInputs` (`:341-357`) hard-codes `governedModelReceipts: Object.freeze([])`, typed `readonly never[]` (`:334`).
- **Worker upload**: `operatorEvidence()` (`workflow-e2e-application-checks.ts:111-131`) never copies `executorEvidence.agent`, so ledgers and traces are not uploaded either.
- **Collector** (`packages/verifier/src/application-result-adapter.ts`) still has the M1-era model design:
  - `E2EApplicationGovernedModelReceiptRow` with projection frames inside the supervisor proof (`:102-107`);
  - per-action `agentOperationRefs` frames (`:126-138`, `:349-359`, `:1404-1473`);
  - receipt rows in `capture.modelReceipts` (`:1324-1327`, `:1605-1639`).

  4.3b's web runtime emits `agentOperationRefs: []` and no `modelReceipts`. So any agent case that called the model or took an action fails one of two checks. One is `groupModelCalls !== actualModelReceiptCount` (`:1325`). The other is `rows.length === 0` with `metrics.actionSteps !== 0` (`:1446`). Either way the case comes out as generic UNKNOWN `application-evidence-floor-unmet` or a whole-group `unknown(...)` sentence. It fails closed, but it can never PASS and never says why.
- **Broker** (`packages/broker/src/e2e/application-evidence.ts:286`): it refuses any non-empty `governedModelReceipts` ("a run with no model route cannot carry model receipts") and passes `governedModelReceipts: []` to the oracle (`:317`). It pins `APPLICATION_RUNNER_LIMITS.maxModelTokensPerCall: 64_000` (`:253`).
- **Reasons**:
  - Case reasons are free `id(500)` strings (`contracts/src/e2e.ts:535`).
  - The display puts into words only the collector reasons listed in `PLAIN_REASONS` (`broker/src/e2e/application-display.ts:185-190`). A group's own reason is never repeated (`:211-212`), so a group that is UNKNOWN with `model-route-changed-reapprove` (the worker sets `unavailableReason = channel.code`, `workflow-e2e-application-checks.ts:378`) shows "this check could not be verified".
- **Baseline**:
  - A plan whose scenarios are all AI scenarios throws `ApplicationBaselineSkipped` (`application-dispatch-check.ts:15-19`). That is recorded as `UNAVAILABLE` with reason `agent-steps-only` (`aws/workflow-e2e-baseline.ts:35,39`) and rendered from `UNAVAILABLE_BASELINE` as "Couldn't run the checks on the unchanged code." (`e2e-presentation.ts:127,152`). The reason is lost.
  - A mixed plan drops its AI scenarios from the baseline admission (`application-admission.ts:110-118`), so their rows are silently absent.
- **Display schema**: `E2EDisplayScenarioSchema` is `.strict()` (`contracts/src/e2e-view.ts:36-49`). The v2 envelope is strict (`aws/workflow-e2e-notifier-projection.ts:19-20`).

## Files

**Modify**
- `packages/verifier/src/host/docker-application-host.ts`: `DockerApplicationModelChannel.open` returns `{ close(): Promise<E2EModelChannelClosed> }`. `closeModelChannel` keeps the result in `state.modelChannelClosed`, and `readCollectionInputs` passes it on.
- `packages/verifier/src/host/executor-readback.ts`: `DockerCollectionInputs` replaces `governedModelReceipts: readonly never[]` with `agentModel: E2EAgentModelEvidence | null`, built from the closed channel and from `snapshot`'s `agent.ledgers`.
- `packages/verifier/src/application-collection.ts`: thread `agentModel` through to `collect`.
- `packages/verifier/src/application-result-adapter.ts`:
  - the oracle gains `agentModel`;
  - a new pure `evaluateE2EAgentCase()` (in a new file, see below) replaces the M1-era agent-operation-frame and projection-row checks for `kind: "agent"` steps;
  - the group counter check `:1324-1327` counts `ok` worker receipts;
  - the case `reason` becomes the mapped code.
- `packages/worker/src/workflow-e2e-application-checks.ts`: the channel `close()` returns `{ summary, transcripts, valueKey, definition }`. `collectionInputs.agentModel` is uploaded as a verdict input. Transcripts go to `operatorEvidence.agentTranscripts` and ledgers to `operatorEvidence.agentLedgers`, both copies for the operator; the verdict copy lives in `collectionInputs`.
- `packages/worker/src/e2e-model-channel-session.ts`: `close()` also returns the evidence collector's transcripts and the resolved `definition`.
- `packages/broker/src/e2e/application-evidence.ts`: `:286` accepts `agentModel` exactly when the admission's `modelRoute` is non-null and the group has an agent step. It rebinds the definition to the admission (Ruling C3), passes `agentModel` to the oracle and stops passing `governedModelReceipts: []`.
- `packages/broker/src/e2e/application-display.ts`:
  - `PLAIN_REASONS` gains the agent codes;
  - a new `GROUP_REASON_CODES` allowlist (exact match on a `code:` prefix) covers the route and channel codes;
  - `buildScenarioRows` fills `agentNavigation` from the verified ledger only;
  - `baselineOf` adds the skipped AI scenarios.
- `packages/broker/src/e2e-presentation.ts`: the badge sentence, the Slack line `AI navigation: …`, and baseline sentences for `agent-steps-only` and for skipped AI scenarios.
- `packages/broker/src/aws/workflow-e2e-notifier-projection.ts`: display envelope v3 (Ruling C5). v2 is still read.
- `packages/broker/src/aws/workflow-e2e-baseline.ts`: `baselineOf` / the `UNAVAILABLE` record keeps `reason`.
- `packages/broker/src/aws/developer-task-notifier.ts`: render the v3 Slack line and keep the fallback.
- `packages/contracts/src/e2e-view.ts`:
  - `E2EDisplayScenarioSchema.agentNavigation?`;
  - `E2EDisplayBaselineSchema.reason?: "agent-steps-only"` and `skippedAiScenarios?: [{ scenarioId, title }] ≤ 64`.

  This is a contracts change outside the barrel; `index.ts` is untouched.

**Create**
- `packages/verifier/src/application-agent-result.ts`: `evaluateE2EAgentCase`, `E2E_AGENT_UNKNOWN_CODES`, and the precedence order. It is a pure function, the one place the parent plan's table is implemented.
- `tests/contract/workflow-e2e-agent-results.test.ts` (new).

**Test (modify)**
- `tests/unit/e2e-application-collection.test.ts`
- `tests/contract/workflow-e2e-application-evidence.test.ts`
- `tests/contract/workflow-e2e-notifier-projection.test.ts`
- `tests/contract/e2e-scenario-results-presentation.test.ts`
- `tests/unit/e2e-docker-application-host.test.ts`
- `tests/e2e/m1-4-journeys.test.ts` (the verdicts deferred from 4.3b)

## Interfaces

Consumed (exact, from `packages/contracts/src/e2e-model-channel.ts`):
```ts
checkE2EStepModelAccounting(input: { roundScope: E2ERoundScope; identity: { runId; caseId; stepIndex; routeId; routeRevision; provider; modelId };
  reportModelCalls: number; receipts: readonly unknown[]; maxModelCallsPerStep: number }): E2EStepModelAccounting
checkE2EGroupModelBudget(input: { receipts: readonly unknown[]; budgets: Pick<E2EModelRouteBudgets, "maxModelCallsPerGroup" | "maxInputTokensPerGroup" | "maxAgentStepsPerGroup"> }): E2EGroupModelBudget
parseVerifiedE2EAgentActionLedger(raw: unknown, context: { goals: ReadonlyMap<number, string>; valueKey: string; runId: string; caseId: string })
  : { ok: true; ledger: VerifiedE2EAgentActionLedger } | { ok: false; reason: string }
crossCheckE2EAgentLedgerReceipts(ledger: VerifiedE2EAgentActionLedger, workerReceipts: readonly unknown[]): LedgerReceiptCheck
e2eModelRouteRevision(definition: unknown): string;  e2eModelReceiptAdmissibleForRound(receipt, roundScope)
E2EModelReceiptSchema, E2EModelRouteDefinitionSchema, E2E_AGENT_STOP_CODES, E2E_MODEL_ROUTE_CHANGED_REAPPROVE, E2E_AGENT_UNAVAILABLE_REASONS
```
Also consumed: `E2EModelReceiptSummary` and `E2EModelTranscript` (`worker/src/e2e-model-proxy.ts:52,103`), and `ExecutorAgentEvidence` (`executor-readback.ts:54-63`).

Produced:
```ts
// verifier: what the worker hands the collector and uploads as a verdict input (bounded; no prompt or response text)
export type E2EAgentModelEvidence = Readonly<{
  schemaVersion: "rovara-agent-model-evidence/v1";
  route: E2EModelRouteDefinition;               // re-bound by the broker to admission.modelRoute (C3)
  valueKey: string;                             // 32-byte hex; verdict-input only, never displayed (C2)
  receipts: readonly E2EModelReceipt[];         // the summary's receipts, ordered by (caseId, stepIndex, callIndex)
  channel: { droppedRequests: number; unscopedRequests: number; overrun: boolean; evidenceErrors: number };
  ledgers: ReadonlyArray<{ caseId: string; bytesBase64: string; sha256: string }>;  // ≤ 64 KiB each (C6)
  transcriptDigests: ReadonlyArray<{ receiptId: string; promptSha256: string | null; responseSha256: string | null; omitted: "budget" | "unparseable" | null }>;
}>;
export type E2EModelChannelClosed = Readonly<{ summary: E2EModelReceiptSummary; transcripts: readonly E2EModelTranscript[]; valueKey: string; definition: E2EModelRouteDefinition }>;

// verifier/src/application-agent-result.ts
export const E2E_AGENT_UNKNOWN_CODES = ["model-receipts-mismatch", "model-prompt-credential-match", "model-route-budget-exhausted",
  "model-unavailable", "agent-timeout", "agent-budget-exhausted", "agent-navigation-incomplete", "agent-no-download", "ambiguous-download"] as const;
export type E2EAgentCaseVerdict =
  | { kind: "deterministic" }                                   // the agent part is clean: the assertions decide (PASSED or FAILED)
  | { kind: "unknown"; code: (typeof E2E_AGENT_UNKNOWN_CODES)[number] };
export function evaluateE2EAgentCase(input: {
  roundScope: E2ERoundScope; runId: string; caseId: string; route: E2EModelRouteDefinition;
  agentSteps: ReadonlyArray<{ declaredStepIndex: number; goal: string; maxActions: number;
    report: { modelCalls: number; actionSteps: number; status: string; errorCode: string | null } | null }>;
  receipts: readonly unknown[]; ledgerBytes: Uint8Array | null; valueKey: string;
  transcriptDigests: E2EAgentModelEvidence["transcriptDigests"]; channel: E2EAgentModelEvidence["channel"];
  csvDownload: "captured" | "none" | "multiple" | "not-applicable";
}): { verdict: E2EAgentCaseVerdict; ledger: VerifiedE2EAgentActionLedger | null; verifiedReceiptIds: string[] };

// contracts/src/e2e-view.ts
agentNavigation?: { steps: Array<{ goal: string /*≤120*/; actedOn: Array<{ role: string; name: string /*≤60*/ }> /*≤8*/; stop: "concluded" | "cut-short" | "failed" }> /*≤3*/;
  modelCalls: number; routeId: string }
E2EDisplayBaselineSchema += { reason?: "agent-steps-only"; skippedAiScenarios?: Array<{ scenarioId: string; title: string }> }
```

**Precedence** (first match wins; "deterministic" only when nothing matches). The order is fixed so that integrity faults come before availability faults, and availability faults before navigation faults:

1. **`model-receipts-mismatch`.** Any of:
   - `channel.droppedRequests` or `unscopedRequests` is not 0, `overrun` is set, or `evidenceErrors` is not 0;
   - accounting fails with any code other than `budget-refused`;
   - the ledger is missing or not verified, or `crossCheckE2EAgentLedgerReceipts` fails;
   - a ledger step has more actions than its `maxActions`;
   - a receipt's prompt or response digest differs from its transcript entry where a body was kept;
   - receipts exist for a case or step that is not an agent step.
2. **`model-prompt-credential-match`.** Any receipt in the step has the outcome `refused-credential-match`.
3. **`model-route-budget-exhausted`.** Accounting returns `budget-refused`, or the group budget check fails with `budget-refused` or `over-group-budget`.
4. **`model-unavailable`.** A receipt has the outcome `provider-error` or `timeout`, or the stop code is `MODEL_UNAVAILABLE` or `MODEL_PROVIDER_FAILED`.
5. **`agent-timeout`.** The stop code is `STEP_TIMEOUT`.
6. **`agent-budget-exhausted`.** The stop code is `STEP_BUDGET_EXHAUSTED`.
7. **`agent-navigation-incomplete`.** Any of:
   - the stop code is `MODEL_OUTPUT_INVALID` or `STEP_NO_CONCLUSION`;
   - any other failed stop code;
   - the ledger verdict is not `concluded`;
   - a receipt has the outcome `invalid-output`, `refused-protocol` or `refused-busy` while the step did not conclude.
8. **`agent-no-download` or `ambiguous-download`** (a `csv` case). The collector derives this from whether a `csv` evidence ref exists. The executor's assertion `reason` is used only to tell "none" from "multiple", and only from the closed set `{agent-no-download, ambiguous-download}`.

If none of these matches, the verdict is `deterministic`: PASSED only through the existing `allPassed && … && modelBound` path (`application-result-adapter.ts:1666`), with `modelBound` now meaning "rule 1 passed"; FAILED through the existing `failed && …` path (D3).

## Test cases

`tests/contract/workflow-e2e-agent-results.test.ts`: the pure `evaluateE2EAgentCase`, plus the adapter end to end on a synthetic collection.

1. Concluded, one `csv` download, receipts `ok`×2 equal to the report's `modelCalls` 2, assertion passes → PASSED; `modelReceiptIds` equals the 2 receipt ids, sorted.
2. Same, but the CSV bytes differ → FAILED, reason `observed-application-assertion-failure`. The case is not UNKNOWN (D3).
3. The act verdict is `passed`, there are 0 actions and no download → UNKNOWN `agent-no-download`, **not** PASSED.
4. Stop code `STEP_BUDGET_EXHAUSTED` → `agent-budget-exhausted`, even though the assertions pass.
5. `STEP_TIMEOUT` → `agent-timeout`.
6. Receipt `provider-error` with stop code `MODEL_PROVIDER_FAILED` → `model-unavailable`. A `timeout` receipt also → `model-unavailable`.
7. `MODEL_OUTPUT_INVALID` → `agent-navigation-incomplete`; `STEP_NO_CONCLUSION` → the same.
8. A failed step with `LOCATOR_NOT_FOUND` → `agent-navigation-incomplete`. A `cut-short` ledger verdict → the same.
9. Two downloads → `ambiguous-download`.
10. Receipt `refused-credential-match` → `model-prompt-credential-match`. It wins over the `MODEL_PROVIDER_FAILED` stop code.
11. Receipt `budget` in the step → `model-route-budget-exhausted`. The group passes 40 calls → the same.
12. Each accounting failure gives `model-receipts-mismatch`, one test per code (`receipt-identity-mismatch`, `receipt-index-gap`, `receipt-duplicate-id`, `receipt-served-model-mismatch`, `over-step-budget`, `report-calls-mismatch`, `receipt-not-admissible`: a scripted receipt in a standard round).
13. **Forged extra receipt.** The executor's ledger names a receipt id the worker never wrote → `model-receipts-mismatch`. An extra receipt id that the worker did write but for another step → the same.
14. Ledger missing; ledger under another `valueKeyId`; ledger `goalDigest` not the approved goal; ledger literal not in the goal → all `model-receipts-mismatch`.
15. Actions greater than `maxActions` (a hand-made ledger with 9 actions where `maxActions` is 8, with the schema cap lifted in the fixture) → `model-receipts-mismatch`.
16. Transcript `promptSha256` differs from the receipt → `model-receipts-mismatch`. A transcript with `omitted: "budget"` → no effect.
17. Channel `droppedRequests: 1`, `unscopedRequests: 1`, `overrun: true` or `evidenceErrors: 1` → `model-receipts-mismatch` in each case.
18. **Precedence.** A credential receipt together with a `STEP_TIMEOUT` stop gives the credential code. A mismatch together with a credential receipt gives `model-receipts-mismatch`.
19. A deterministic case in the same group with no receipts → its verdict is unchanged. A deterministic case with receipts attributed to it → the group fails with `model-receipts-mismatch`.
20. Raw vs parsed (Review Focus 7): receipts whose keys are reordered, or whose `servedModelId` is absent rather than `null`, give the same verdict as the parsed form.

`tests/contract/workflow-e2e-application-evidence.test.ts` (broker):

21. `agentModel` present with `modelRoute: null` → UNKNOWN. `agentModel` absent with an agent step and a non-null route → UNKNOWN `model-receipts-mismatch`.
22. `agentModel.route` whose `e2eModelRouteRevision` differs from `admission.modelRoute.routeRevision` → UNKNOWN `model-receipts-mismatch` (C3).
23. **Worker-owned receipts.** A broker re-collection with receipts edited after upload (one `outcome` flipped to `ok`) → the content address fails, or the relation fails → UNKNOWN. The worker's own `collection` claim of PASS is ignored.
24. Group `unavailableReason` `model-route-changed-reapprove: …` → the display sentence "The AI navigation settings changed after setup was approved. Approve setup again to run these checks." `agent-route-not-approved` → "AI navigation isn't approved for this project yet. Approve setup to run the AI-navigated checks." `model-environment-unsafe` → COULD_NOT_VERIFY plus an operator log line. Any other group reason is still not repeated.

Display (`tests/contract/e2e-scenario-results-presentation.test.ts`, `workflow-e2e-notifier-projection.test.ts`):

25. **Badge.** `agentNavigation` with an action on `button "Download orders"` and a `csv` assertion → "AI-navigated: the model clicked 'Download orders'; the CSV check decided".
26. **Slack.** One line per round: `AI navigation: 1 step, 3 model calls (checks decide)`, only when some row has `agentNavigation`.
27. **Sentences for every agent code** (8 of them), each a fixed string, for example `agent-no-download` → "The AI navigator didn't find a way to download the CSV; retry, or check the button exists".
28. **A v2 reader falls back for a v3 envelope.** The fallback is "Open the task page" (the parent plan says "v1 reader"; see C5).
29. **No goal-external typed value or credential in any row or Slack block.** The test drives a ledger whose `type` action has `valueLiteral: null` and a known `valueDigest`, and a seeded password present in the page snapshot. It then byte-scans the view, the Slack blocks and the artifact list. `actedOn` carries only `role` and `name`, never a value.
30. **BASEREASON.** A baseline that is `UNAVAILABLE` with reason `agent-steps-only` reads "Before the change: not run. Every check here uses AI navigation, which runs only on the change." A mixed baseline with `skippedAiScenarios: [owner-export-ai]` adds "1 AI-navigated check is not run on the unchanged code." and a row-less list of titles. Both carry no PASS or FAILED word.

Executor-side wiring (`tests/unit/e2e-docker-application-host.test.ts`):

31. `readCollectionInputs` for a model group returns `agentModel` with the closed summary's receipts and the plan's `valueKey`. For a group without a model it returns `agentModel: null`. A host whose channel `close()` threw gives an `agentModel` with `channel.evidenceErrors ≥ 1` (UNKNOWN), not `null`.

Journeys (`tests/e2e/m1-4-journeys.test.ts`, finishing the verdicts 4.3b deferred, run through `verifyApplicationE2EEvidence` on the uploaded bytes):

32. `agent-renamed-export`: broker verdict PASS, the case PASSED, `modelReceiptIds` has 2 entries, the publication checks list is not empty, and the display row has the badge.
33. `agent-wrong-action`: the case is FAILED on a deterministic `csv` mismatch (D3), with send-back offered and the row naming 'Download invoices'.

    The parent plan's Task 4.3 lists this journey as "UNKNOWN, publication blocked, retry offered", which contradicts D3 (see C1).
34. `agent-model-outage`: UNKNOWN `model-unavailable`, publication blocked, retry offered, no PASS.

## Verification commands

```bash
npx vitest run tests/contract/workflow-e2e-agent-results.test.ts tests/unit/e2e-application-collection.test.ts \
  tests/contract/workflow-e2e-application-evidence.test.ts tests/contract/workflow-e2e-notifier-projection.test.ts \
  tests/contract/e2e-scenario-results-presentation.test.ts tests/unit/e2e-docker-application-host.test.ts
npx vitest run tests/contract/e2e-model-channel.test.ts tests/unit/developer-task-notifier.test.ts   # no regressions
npm run typecheck && npm run lint
# Linux CI job `linux-runtime`: tests/e2e/m1-4-journeys.test.ts (all 3 cases) and tests/linux/e2e-agent.test.ts
npx tsx scripts/test-deploy.ts --check   # before and after deploy
```

## Deploy notes

- **Order:** control plane (broker) first, then the worker image, then the executor image. The broker reads both `agentModel`-less (M1.3) and `agentModel`-bearing group evidence, so a new broker with an old worker is safe. An old broker with a new worker refuses `agentModel` at `:286`, so the result is UNKNOWN, never PASS. That is safe, but it means the broker must deploy first.
- **Display v3:** `--check` must not flag v3 envelopes. Readers of v2 fall back. A rollback to M1.3 renders v3 tasks as "Open the task page".
- **Still dark:** the catalog has no `agent` step until 4.5 and requalification, and no route is approved until 4.9. So no customer plan reaches this code in TEST; only the journeys and Linux CI exercise it.
- **Evidence size:** `agentModel` is at most about 40 receipts × about 700 B, plus at most 64 ledgers × 64 KiB. That fits within the 8 MiB group cap, but `e2eApplicationPrivateTransferMaxBytes` must be re-measured with 3 agent cases. The transcripts (≤ 1 MiB) are operator evidence and are shed first by `fitGroupEvidence`. `collectionInputs.agentModel` is never shed.
- **No AWS change.** No new IAM, tables or secrets.

## Contradictions between the plan text and the code

| # | Plan text | Code | Proposed ruling |
|---|---|---|---|
| C1 | Task 4.3 journey `agent-wrong-action`: "UNKNOWN, publication blocked, retry offered". | D3 (owner, 2026-10-21): a mismatch after AI navigation is FAILED with send-back. The 4.4 table says the same. | **FAILED (send-back)**, per D3. Correct the 4.3 journey text in the parent plan. |
| C2 | "The broker re-verifies … the receipt digests against the stored transcripts." `parseVerifiedE2EAgentActionLedger` needs the run's `valueKey`. | The key lives only in the worker and host (`docker-application-host.ts:687`) and in the executor plan. It is not uploaded, and 4.3a's comment calls it "operator evidence". Transcripts are never uploaded. | Upload `valueKey` in `collectionInputs.agentModel` (a verdict input, private S3 only, never displayed). The broker verifies ledgers with it. Transcript **digests** are a verdict input; the bodies are operator evidence that can be shed. A shed body never changes a verdict. |
| C3 | `checkE2EStepModelAccounting` needs `provider` and `modelId`. "The route against the admission." | The admission carries only `{ routeId, routeRevision }`. `verifyApplicationE2EEvidence` is synchronous and has no registry access. | The worker uploads the resolved `E2EModelRouteDefinition`. The broker accepts it only if `e2eModelRouteRevision(definition) === admission.modelRoute.routeRevision` and `routeId` matches. Option B, safer and costing one GetItem: the caller passes the registry's stored definition for that revision. **Recommend B**: per-revision rows exist (`e2eModelRouteRevisionKey`, `model-route-registry.ts:54`), read with one GetItem in the async caller of `verifyApplicationE2EEvidence`. The digest is 12 hex characters (48 bits) (risk R3). |
| C4 | File list: the agent rows at `application-result-adapter.ts:1331-1385` and the receipts at `:1518-1534`; `executor-readback.ts:195`; `application-evidence.ts:236`. | They are now at `:1404-1473`, `:1605-1639`, `executor-readback.ts:334,355` and `application-evidence.ts:286,317`. The adapter's receipt model is the M1-era projection-frame and agent-operation-frame design, which 4.3b never emits. | Retire the M1 frames **for agent steps**: require `agentOperationRefs: []` and `capture.modelReceipts: []`, and verify through `evaluateE2EAgentCase` over the worker receipts and the verified ledger. Keep the schemas, so M1.3 bytes still parse. Do not port the projection frames. |
| C5 | "Display v2 gains `agentNavigation?` … Readers built before M1.4 ignore it." Test: "a v1 reader falls back". | `E2EDisplayScenarioSchema` and the v2 envelope are `.strict()`. An old reader **refuses** an unknown key instead of ignoring it. | Bump the display to **v3** (`displaySchemaVersion: 3`). A v2 reader falls back to "Open the task page". Rename the test accordingly. |
| C6 | Ledger "at most 64 KiB". | Readback accepts up to 256 KiB per ledger (`executor-readback.ts:178`). The contract says its structural caps keep a ledger under 64 KiB. | The collector refuses more than 64 KiB (`model-receipts-mismatch`). Keep the readback cap as a transport bound. |
| C7 | Route-mismatch UNKNOWN codes get sentences (the owner's ask). | Group reasons are deliberately never repeated (`application-display.ts:211`), so they show "could not be verified". | Add a closed `GROUP_REASON_CODES` map keyed on the `code:` prefix the worker and broker already emit (`model-route-changed-reapprove`, `agent-route-not-approved`, `model-route-budget-exhausted`). The rest of the reason text is never shown. |
| C8 | Baseline: "a baseline skips AI navigation steps" (criterion 2), shown clearly. | `agent-steps-only` maps to the generic `UNAVAILABLE_BASELINE`. In a mixed plan the AI rows are silently absent. | Add `reason` and `skippedAiScenarios` to `E2EDisplayBaselineSchema` (BASEREASON), with the sentences in test 30. |
| C9 | Budgets: input ≤ 32000 per call. | `APPLICATION_RUNNER_LIMITS.maxModelTokensPerCall: 64_000` (`application-evidence.ts:253`). The receipt schema allows 64000 for non-`ok` receipts. | Leave the runner limit unchanged: it is e2e's configured limit, and the route enforces 32k. The receipt schema already caps `ok` receipts at 32k. Note this in the parent plan. |
| C10 | Download codes come from the collector. | `agent-no-download` and `ambiguous-download` are the executor's assertion `reason` (`web-runtime.ts:466`), which is untrusted. | The collector decides "a download was captured" from the evidence ref. It uses the executor reason only to choose between the two UNKNOWN codes (closed set). Neither code can produce a PASS. |
| C11 | "Receipts from the worker are cross-checked against the executor's report", "The worker owns the receipts." | The parent plan names no transport, and the 4.3a/4.3b decision kept receipts in the worker. | Receipts travel worker → `collectionInputs.agentModel` (content-addressed with the group evidence). The executor never sees receipts except the ids in its ledger, which are cross-checked. |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `sdkStep.cache` under the M4-A capture store may not be `undefined` or `missed`. The adapter's `:1457` check would then reject every agent step. | Read one real 4.3b journey report before coding. The capture store is `read-write` and always misses, so expect `mode: "missed"`. Pin the observed shape in a test. |
| R2 | The broker and the worker collector diverge. | Both call the same `evaluateE2EAgentCase` (in verifier, exported). Only the broker's result gates. |
| R3 | Option A of C3 trusts a 48-bit revision digest against a worker-supplied definition. | Prefer option B. Under A, the worker is already trusted for receipts, so the residual risk is a compromised worker, which can already forge receipts. Record this in Review Focus 4. |
| R4 | Uploading `valueKey` makes typed-value digests dictionary-attackable by anyone who can read private evidence. | Typed values are only goal literals or agent text on synthetic data, and seeded credentials are refused before egress. The key lives in private S3 under existing retention and is never displayed. |
| R5 | Evidence size with 3 agent cases and transcripts. | Re-measure `e2eApplicationPrivateTransferMaxBytes`. Transcripts are shed first; receipts and ledgers are never shed. A group over its bound is UNKNOWN "evidence too large", never PASS. |
| R6 | Display v3 against an old notifier during a staggered deploy. | Deploy the broker first. A v2 reader falls back to the link. |
| R7 | The precedence order hides a second cause. | Return the first code only; log every matched code in the worker's structured log (counts and codes only). |

## Should 4.4 be split?

**Yes, into three PRs, merged and deployed in order.** Each one stays dark and fails closed.

- **4.4a: the receipt and ledger transport and the collector.**
  - host keeps the close result, `DockerCollectionInputs.agentModel`, the worker upload, the broker's `:286` acceptance and C3;
  - `evaluateE2EAgentCase` and the adapter rewrite for agent steps (C4, C6, C10);
  - tests 1–23, 31, and journeys 32–34 at verdict level.

  This is the security-critical half (Review Focus 1 and 4) and gets the full Opus review. It owns `application-result-adapter.ts`, `docker-application-host.ts` and `workflow-e2e-application-checks.ts`.
- **4.4b: display.**
  - contracts `e2e-view.ts` v3 and `agentNavigation`, `application-display.ts`, `e2e-presentation.ts`, the notifier projection and the notifier;
  - reason sentences, the group-code map (C5, C7);
  - tests 24–29 and the journey display assertions.

  It depends on 4.4a's verified ledger, but touches none of its files.
- **4.4c: BASEREASON.**
  - `E2EDisplayBaselineSchema.reason` and `skippedAiScenarios`, `workflow-e2e-baseline.ts`, the admission's skipped-scenario list (C8);
  - test 30.

  It is small and independent of 4.4a, and can run in parallel with 4.4a.

Why split: 4.4a alone changes the trust boundary (new verdict inputs). Keeping it free of display churn keeps its review small. 4.4b and 4.4c are owner-facing wording that the owner may want to iterate on without re-reviewing the verifier. Task 4.6 (replay) needs only 4.4a, through the verified ledger and the trace binding in PASS evidence. Task 4.5's probes need 4.4a's codes (`agent-no-download`).

## Open questions for the owner

1. C3: option A (a worker-supplied definition re-bound by digest) or option B (the broker reads the registry revision)? Recommendation: B.
2. C2/R4: is uploading the per-run value key into private evidence acceptable? The alternative is the broker never verifying ledger literals, which weakens Review Focus 4.
3. The wording of the route-mismatch and BASEREASON sentences (tests 24 and 30).
