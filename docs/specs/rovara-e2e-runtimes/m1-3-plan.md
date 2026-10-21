# M1.3: Accounts, External-Origin Mocks and Result UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rovara verifies role and tenant rules of a web/API feature with per-run synthetic accounts, replaces declared external services with approved in-network mocks, and shows every scenario's outcome on the task page and in Slack. A failure shows its screenshot and its expected and actual values. This ships to mainline and is proven live in TEST.

**Architecture:** M1.3 builds on the merged M1.2 application path (mainline `a44b93e7`), which runs discovery → v2 plan intent → APPROVE → application admission → Docker host (build / app / executor) → collector → broker re-verification → publication guard. It adds these pieces and changes nothing else:

- **Account registry.** The broker holds versioned account definitions. They replace the Ruling AT stand-in (`deriveE2ESyntheticRuntimeAccountRef`, revision 1 derived from the recipe).
- **Generic accounts in the host and executor.** The host supports a recipe-declared seed command and form login next to the built-in `orders-seed/v1` and `orders-auth/v1`. Anonymous scenarios (Ruling AZ) are added too.
- **Runtime keying by (profile, kind).** Web and API targets can be in one plan (Ruling BF).
- **Mock containers.** Each approved origin gets a mock container on the run's `--internal` network, served from the executor image. A sinkhole records every call that no approved mock matches.
- **Bounded capture and display.** Screenshots and traces are captured within a budget. A per-scenario display row is derived by the broker from verified evidence only, never from the worker's claims.
- **Baseline round (owner decision D2).** This makes the live failure deterministic.

**Tech Stack:** unchanged from M1 (Node 22.23.2, TypeScript 5.9.3, Vitest 5.0.1, `e2e@0.20.0`, `@e2e-dev/web@0.14.0`, `playwright-core@1.63.0`, Docker on AL2023 arm64 `m6g.large`, CDK, GitHub Actions).

**Spec:** `docs/specs/rovara-e2e-runtimes/roadmap.md` (M1.3 row), `m1-browser-api-plan.md` (the M1.3 section this plan replaces), ledger `.superpowers/sdd/m1-browser-api-plan/progress.md` (Rulings AT, AU, AZ, BE, BF, BV, BZ, C), `final-merge-review.md` (before-release checklist).

## Scope

### In

| Item | Source | Why it is in M1.3 |
|---|---|---|
| Account registry (versioned definitions; plan pins `{revision, definitionDigest}`) | Task 3.1 of the M1 plan, Ruling AT | Tenant isolation needs accounts in two tenants, with identities the broker can re-check. The AT stand-in authorizes "whatever the recipe says", without a revision or expiry. |
| Generic synthetic accounts: recipe seed command and form login | Task 3.1 of the M1 plan, Ruling C | The host hard-codes `orders-seed/v1` and `orders-auth/v1` (`docker-application-host.ts:84,212`). A real repository can't use those. |
| Anonymous scenarios and inferred-recipe apps | Ruling AZ (deferred from AN) | "Signed-out visitor" is a basic access scenario. Inferred-recipe apps (no `agentx.e2e` contract) are most real repositories. Today they plan as `needs-project-contract`. |
| Web and API in one plan: runtime bindings keyed by (profile, kind) | Ruling BF | Tenant isolation is naturally an API check (`GET /api/tenants/<other>/orders` → 403) beside the browser checks. M1.2 refuses that plan. |
| External-origin mocks with unmocked-call detection | Task 3.2 of the M1 plan, roadmap M1.3 | Exit criterion. The contracts already carry it: source-backed `E2EApiMockFixtureSchema`, group `mode: "hybrid"`, `mockManifestDigest`, collector `mockConsumptions`. Only the Docker host lacks it. |
| Screenshots, traces and raw per-scenario reports kept | Task 3.3 of the M1 plan, M1.2 lesson | Exit criterion. M1.2 diagnosis 2 was slowed by the missing raw reports (FX3 follow-up). |
| Per-scenario results on the page and in Slack, with expected vs actual | Task 3.3 of the M1 plan | Exit criterion. Today the page and Slack show only aggregate counts (`e2e-presentation.ts`). |
| Slack shows the real refusal reason (Ruling AU) | Ruling AU | Already fixed in FU1 item 10 (branch `claude/rovara-m1-followups`). M1.3 only checks it live and adds the reasons M1.3 introduces (accounts changed, mock fixture changed). |
| A TEST deploy check before the live demo | M1.2 lessons (stale Lambdas, IAM drift) | Each one cost a live retry in M1.2. |
| Baseline round: approved scenarios run once on the unchanged base commit, for information only | New, owner decision D2 | It makes the exit's "a failure shows a screenshot" deterministic live. In M1.2, "FAILED before repair" was never exercised live, because the agent's first candidate passed. |

### Out (deferred further)

| Item | Deferred to | Why |
|---|---|---|
| Mixed portable + application plans (Ruling BE) | After M1.4 (a follow-up issue) | One CHECKS operation carries one admission. Mixing them changes the operation, outbox and publication-guard records for a shape that no demo or known user needs. M1.2's refusal is clear ("put portable checks in a schemaVersion 1 plan"). `combineE2EVerdicts` stays as tested code. |
| Real external connections (`external-test` accounts, `approvedExternalConnectionRefs`, any egress from the run network) | Not scheduled | It needs credential handling, an egress allowlist and a Tier 3 network change. M1.3 proves the mock path. Real external calls stay unavailable, and the result says so (`mockedOrigins`). |
| One app container serving both web and API groups | M1.4 or later | M1.3 runs web and API as separate groups (two builds, at most 2 concurrent). That is simpler and keeps "one application per group" (`docker-application-host.ts`). The cost is one extra build per round. |
| Uploading screenshots into Slack | Owner decision D3 | It sends candidate-app pixels to Slack. M1.3 Slack carries text plus a page link. |
| Video capture | Not scheduled | Video-only stays UNKNOWN (Ruling CB). |
| `agent` steps | M1.4 | Unchanged. |

## Global Constraints

Everything in M1 Global Constraints still applies (containers, labels, result semantics, deterministic assertions, owned files, no ad hoc AWS). In addition:

- **Mocks are in-network only.** Each mock container joins only `rvi<8 hex>` (the run's `--internal` bridge) with alias `mock-<originRef>`. It gets `--cap-drop=ALL --security-opt no-new-privileges --read-only`, user `node`, Docker's default seccomp profile (not the executor profile), and no environment variables except `ROVARA_MOCK_FIXTURE=/mock/fixture.json`. No run gets egress. A declared origin with no approved mock is pointed at the sinkhole `mock-unbound:8080`. It is never left unset and never pointed at a real host.
- **Mock replies.** A request that no approved fixture matches gets HTTP `599`, body `{"error":"rovara-unmocked"}`. The call is recorded. A required scenario with any recorded unmocked call is UNKNOWN with reason `unmocked-external-call`. It is never PASS and never FAILED.
- **Credentials never leave the run.** Synthetic credentials appear only in the plan mount, the seed file and the executor's memory. Every evidence file, screenshot name, trace, display row and Slack block goes through the credential redactor (`executor/redact.ts`). A trace or report in which the redactor finds a credential is dropped: it is not stored, and the drop is recorded as `artifact-omitted: credential-match`.
- **Tracing starts after login.** The form-login keystrokes are never in a trace.
- **Capture budget per group:** 6 MiB of artifacts, counted as the base64 text stored in the evidence, inside the 8 MiB group evidence cap (Ruling BV; the 24 MiB aggregate is unchanged).
  - Screenshot: JPEG, quality 70, at most 512 KiB each, only for FAILED or UNKNOWN cases. Baseline rounds also get one for passed cases.
  - **No traces (Ruling CJ).** A Playwright trace keeps rotated `Set-Cookie` values, bearer and query tokens and the page's own text, none of which can be scrubbed reliably. Trace capture is deferred past M1.3. No policy, launch descriptor or capture API accepts one: a policy that asks for `traces` is refused.
  - Over budget: screenshots are shed one file at a time, the largest first, each drop recorded as `omitted: "budget"`. Each group is held to a fixed share of the aggregate, `min(group cap, (aggregate - 1 MiB envelope) / admitted group count)`, known before any group runs, so a group uploads the moment it finishes (the broker's 30 s post-close window is timed to the start of that upload) and one group's captures can never take another group's room. Within its share a group sheds only operator evidence, never verdict inputs. A dropped artifact never changes a verdict.
  - The new setup default is `{ screenshots: true, traces: false, video: false, downloads: true }`. A project whose setup was approved earlier keeps its stored policy, so it gets captures only after its setup is approved again (propose and approve the setup again). A setup proposal made before the default changed cannot be approved ("propose the setup again"); a decision already recorded for it is still answered as an idempotent retry (`duplicate: true`).
  - The web qualification probes still declare `screenshots` (their engine descriptor needs the `artifacts` capability, and changing it would move pinned digests), so a FAILED probe case takes one screenshot into the executor's out directory; nothing in the probe runner reads it and no digest depends on it.
- **Raw per-scenario evidence is always kept,** whatever the verdict: the shard `report.json`, the per-case observation files and the first 64 KiB of `executor.log`, under operator-only evidence. This extends B8, which kept them for unqualified groups only. The broker never reads `diagnostics` to decide a verdict.
  - What can still be dropped under "evidence too large", exactly: when a group is over its share of the aggregate, operator evidence is shed in this order: screenshots (one file at a time, largest first), then the bytes of the copied observations (one at a time, largest first; their listing stays), then the executor log head and the rest of the operator evidence. A qualified group's report and observations are inside its collection (verdict inputs), so they are never shed. Only a group whose verdict inputs alone (its collection and diagnostics) do not fit its share becomes UNKNOWN "evidence too large", and then its `actual`, `diagnostics` and `operatorEvidence` are all dropped, which includes the shard report heads and observations of that group.
- **Display rows come from verified evidence only.** `failedAssertion.expected` comes from the approved assertion. `failedAssertion.actual` comes from the collector's re-derived observation, bounded to 200 characters per value and redacted. A worker-supplied display field is ignored.
- **Contract comparisons use parsed forms.** Every new canonical comparison (registry digests, display rows, runtime keys) compares schema-parsed values on both sides. This is the FX3 lesson: raw stored JSON compared with a normalized admission.
- **Back-compat for readers in mixed fleets.** The notifier, page and Slack must read both display schema v1 (M1.2) and v2 (M1.3). A worker without the new feature string is refused at dispatch with a clear reason (Ruling BQ pattern), and portable work continues.
- **Owned files:** `broker.ts`, `developer-tasks.ts`, `packages/contracts/src/index.ts`, `package-lock.json`, `docker-application-host.ts` and `executor/run.ts` are edited by one task at a time.
- **TEST changes** go only through `scripts/test-deploy.ts`, `scripts/test-qualify-runtime.ts` or a reviewed guarded change set. No production release is part of M1.3 (owner decision D9).

## Review Focus

1. **Two tenants, three accounts, one run.** Each case must be bound to its own `(applicationId, accountProfileId)` session and account ref (the FX3 collector bug). Test: Task 3.2 journey. Three accounts in two tenants: viewer refused, the other tenant refused, owner allowed.
2. **The registry authorizes nothing beyond the approved contract** (Ruling AT check, carried forward). A definition whose `contractDigest`, `tenantIdDigest` or `roleRef` differs from the current approved contract is refused at APPROVE and at dispatch. So is an expired definition. Test: Task 3.1.
3. **A mock can't become a pass for an unexercised dependency.** An unmatched path or method on a mocked origin, or any call to the sinkhole, makes the case UNKNOWN. A mocked dependency is always listed in `mockedOrigins` on the page and in Slack. Tests: Task 3.4, and the qualification probe `web-unmocked-call-v1`.
4. **Credentials in captures.** Form-login keystrokes, `Set-Cookie` values and the seed file must never reach a screenshot name, trace, raw report, display row or Slack block. Test: Task 3.5 (seeded credential strings are scanned for across every stored byte).
5. **Raw vs parsed, and stale readers.** The new admission fields, runtime keys and display v2 are compared in parsed form. The notifier and page built before M1.3 still render a v2 row as the fallback ("Open the task page"), never as a verdict. Tests: Tasks 3.3 and 3.6.
6. **A baseline round never gates.** Its verdict is informational. It can't satisfy or block publication, can't trigger send-back, and is never confused with a candidate round in `qualifiedRound` or `failedRound`. Test: Task 3.7.

---

## M1.3 tasks

Order and parallelism:

- Task 3.0 (scripts only) and Task 3.8 (fixture publisher) may run in parallel with anything.
- 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 run sequentially, because each touches `broker.ts`, the contracts barrel, `docker-application-host.ts` or `executor/run.ts`.
- Task 3.9 ships.

Every task that adds a new shape adds its native journey case to `tests/e2e/m1-3-journeys.test.ts`, gated like `m1-web-journey.test.ts`, and runs it in CI `linux-runtime`.

### Task 3.0: TEST deploy check (stale code, IAM drift, runner readiness)

**Files:**
- Modify: `scripts/test-deploy.ts` (new `--check` mode; reuse the existing `control-plane-code` unit inventory)
- Create: `scripts/test-deploy-check.ts` (pure functions)
- Test: `tests/unit/test-deploy-check.test.ts`, `tests/contract/test-deploy-control-plane-lambdas.test.ts` (extend)

**Interfaces:**
- Produces `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --check`. It is read-only and exits 0 only when every check passes. Pure function: `evaluateTestDeployCheck(input: { headTemplate; deployedTemplate; lambdaCodeShas: Record<logicalId, string>; builtZipShas: Record<logicalId, string>; catalogRows; runnerFacts; now }): { ok: boolean; findings: Finding[] }`. `Finding.kind` is one of:
  - `stale-lambda`: deployed `CodeSha256` ≠ head build, for every repo-built control-plane Lambda, not only the units being deployed;
  - `iam-missing-grant`: a head IAM statement action or resource that is absent from the deployed policy of the same role, after normalizing as in `test-iam-drift-audit.md`;
  - `iam-extra-grant` (warning only);
  - `catalog-not-ready` or `catalog-expiring` (a `#web` or `#api` row not READY, or expiring within 24 h);
  - `runner-image-mismatch` (the runner's executor image digest ≠ the deployed `ExecutorImageUri`);
  - `worker-feature-missing` (the running worker's `/ping` lacks the feature strings this head needs).
- `--apply` of code units runs the check first. It refuses when an `iam-missing-grant` names a role used by a unit being deployed, and prints the exact statement for a Tier 3 request. It never applies IAM itself.

- [ ] **Step 1: Write the failing tests.**
  - The live M1.2 SessionsSteps drift (head adds `.../worker-executor-image` to `ssm:GetParameters`) gives exactly one `iam-missing-grant` naming `SessionsStepsServiceRoleDefaultPolicy9F4B87C9`.
  - The 2026-10-14 notifier code against a newer head gives `stale-lambda` for `DeveloperTaskNotifier`.
  - Statement order changes only (the Broker `ConditionCheckItem` move) give no finding.
  - A row expiring in 23 h gives `catalog-expiring`.
  - `--apply --only control-plane-code` with an `iam-missing-grant` on SessionsSteps throws `"deploy check failed: iam-missing-grant SessionsSteps (needs Tier 3 approval)"`.
  - Non-allowlisted environments still throw the M1.0 error.
- [ ] **Step 2: Run** `npx vitest run tests/unit/test-deploy-check.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** Use only read calls: `get-template`, `get-function`, `describe-stacks`, the admin catalog read, and an SSM parameter read. The runner facts come from the qualification status object, not SSH.
- [ ] **Step 4: Run tests until they pass.**
- [ ] **Step 5: Commit** `feat(scripts): read-only TEST deploy check for stale code, IAM drift and runner readiness`

### Task 3.1: Account registry

**Files:**
- Modify: `packages/contracts/src/e2e-application-accounts.ts` (registry row schema; keep `deriveE2ESyntheticRuntimeAccountRef` only for reading M1.2 records)
- Modify: `packages/broker/src/aws/developer-tasks.ts` (APPROVE pins the refs), `packages/broker/src/aws/broker.ts` (setup approval writes definitions; dispatch re-reads them)
- Modify: `packages/broker/src/e2e/application-plan-approval.ts`, `packages/broker/src/e2e/application-admission.ts`, `packages/broker/src/e2e/feature-plan-planning-context.ts`
- Test: `tests/contract/e2e-account-registry.test.ts` (new), `tests/contract/workflow-e2e-application-gating.test.ts` (extend)

**Interfaces:**
- Storage goes in the existing broker table (no new table and no GSI):
  - `pk = PROJECT#<projectId>`, `sk = E2E_ACCOUNT#<applicationId>#<profileId>#REV#<n>` holds the `E2EApplicationAccountDefinition`;
  - `sk = E2E_ACCOUNT_LATEST#<applicationId>#<profileId>` holds `{ revision, definitionDigest }`.
  - Writes are conditional on the previous `revision`.
- Writer: setup approval (owner decision D5, recommended). For each `synthetic-test` profile in the approved contract, the broker writes revision `n+1` when `e2eApplicationAccountDefinitionDigest` changes, otherwise nothing. The values are:
  - `subjectIdDigest = sha256("rovara-synthetic-subject/v1\0" + applicationId + "\0" + profileId)`
  - `tenantIdDigest = sha256(tenantRef)` (as `validateE2EApplicationAccountBinding` expects)
  - `credentialHandleId = null`, `connectionRef = null`
  - `expiresAt = approval + 90 days`
- Reader: the planning context shows the planner the latest refs. APPROVE requires each scenario's account ref to equal the latest parsed ref and calls `validateE2EApplicationAccountBinding` with the approved contract. Dispatch re-reads the latest ref and refuses a changed one with `accounts-changed-reapprove`, the same re-approval path as requalification (FX4 routes).
- M1.2 records that carry a stand-in ref (revision 1, recipe-derived digest) are read as they are. A new APPROVE never accepts one.

- [ ] **Step 1: Write the failing tests.**
  - Setup approval of the fixture contract writes 4 definitions (`synthetic`, `orders-owner`, `orders-viewer`, `orders-owner-b`), each at revision 1. Re-approving the same contract writes nothing. Changing `orders-viewer.roleRef` writes revision 2 for that profile only.
  - APPROVE with a stale revision is refused with `accounts-changed-reapprove`. An expired definition is refused too.
  - A definition whose `tenantIdDigest` ≠ `sha256(tenantRef)` is refused at dispatch even if its digest is the latest (registry tampering).
  - A stored plan without defaulted keys still verifies (parsed comparison, FX3 lesson).
  - The Slack re-approval route shows "The test accounts changed; approve the checks again" (AU pattern).
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.** Also run `npx vitest run tests/contract/workflow-e2e-*.test.ts`.
- [ ] **Step 3: Commit** `feat(e2e): versioned synthetic account registry replaces the recipe-derived stand-in`

### Task 3.2: Generic seed and form login in the host and executor

**Files:**
- Modify: `packages/contracts/src/e2e.ts` (recipe `seed?: CommandRecipe`), `packages/contracts/src/e2e-application-accounts.ts` (account profile `login?`), `packages/contracts/src/e2e-executor.ts` (plan account carries `login`)
- Modify: `packages/verifier/src/host/docker-application-host.ts` (seed container, data volume), `packages/verifier/src/executor/accounts.ts` (form login), `packages/verifier/src/executor/run.ts`
- Modify: `tests/fixtures/e2e-web-api-app/` (the qualification app is unchanged; add `tests/fixtures/orders-web-m13/` as the M1.3 baseline, see Task 3.8)
- Test: `tests/unit/e2e-executor-accounts.test.ts`, `tests/unit/e2e-docker-application-host.test.ts`, `tests/linux/e2e-accounts.test.ts` (new), `tests/e2e/m1-3-journeys.test.ts` (case `accounts`)

**Interfaces:**
- Seed profile `rovara-accounts-file/v1`:
  - The host writes `/app/.owned/rovara-accounts.json` with `{ schemaVersion: "rovara-accounts/v1", accounts: [{ profileId, email, password, tenantRef, roleRef }] }`. The email is `rovara-<profile>-<6 hex>@example.test`, as today; the password is 24 random bytes in base64url.
  - The host runs `recipe.seed` (timeout ≤ 60000 ms) in a seed container that uses the app container's flags. Env: `ROVARA_ACCOUNTS_FILE=/app/.owned/rovara-accounts.json`, `ROVARA_DATA_DIR=/data`.
  - The seed exits 0, or the run is UNKNOWN with `seed-failed`.
  - `/data` is a per-run Docker volume labeled `rovara.run=<runId>`, mounted read-write in the seed and app containers only, and removed by `close()`.
- Auth profile `rovara-form-login/v1`: `login: { kind: "form", path: string, usernameTestId, passwordTestId, submitTestId, successTestId }`. The executor fills the form in a fresh browser context and waits up to 10000 ms for `successTestId` to be visible (otherwise the case is UNKNOWN with `login-failed`). It then keeps that context's storage state for the case. API cases with this profile reuse the storage state's cookies through a Playwright request context. Tracing starts only after the login.
- The built-ins `orders-seed/v1` and `orders-auth/v1` stay unchanged, so the qualification digests don't move.

- [ ] **Step 1: Write the failing tests.**
  - unit: two runs give different emails and passwords. Every file under `out/` is free of every seeded password and email-local-part.
  - unit: a seed exit of 3 gives `seed-failed` and removes all labeled resources, including the volume.
  - unit: app and seed arguments carry no `AWS_`, `AGENTX_`, `TOKEN` or `SECRET`, and no docker socket.
  - Linux (M1.3 baseline app with `rovara-accounts-file/v1` + `rovara-form-login/v1`):
    - `orders-viewer` sees no `export-csv` and passes;
    - `orders-owner` exports and passes;
    - `orders-owner-b` (tenant-b) sees no row `a1`.
  - Linux: the `viewer-access` defect makes the viewer case FAILED on the `visible` assertion.
  - journey `accounts`: three accounts in two tenants, in one group. Candidate 1 has `viewer-access`: FAILED, send-back. Candidate 2 is fixed: PASS. Each case's account ref resolves by `(applicationId, accountProfileId)`.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS** (Linux in CI `linux-runtime`).
- [ ] **Step 3: Commit** `feat(e2e): recipe-declared account seed and form login`

### Task 3.3: Anonymous scenarios and inferred-recipe apps (Ruling AZ)

**Files:**
- Modify: `packages/contracts/src/e2e-application-accounts.ts` (reserved profile), `packages/contracts/src/e2e-application-execution-plan.ts` (lift the `needs-project-contract` gate for inferred recipes)
- Modify: `packages/broker/src/e2e/feature-plan-planning-context.ts`, `packages/verifier/src/executor/accounts.ts`, `packages/verifier/src/executor/run.ts`, `packages/verifier/src/application-result-adapter.ts` (an anonymous case has no account binding), `packages/verifier/src/host/docker-application-host.ts` (Ruling AN's synthesized service contract `{ listenPort: 4317, portEnv: "PORT" }`, PORT dropped from the inferred env)
- Create: `tests/fixtures/e2e-inferred-web-app/` (`package.json` with `scripts.start`, `package-lock.json`, `server.mjs`; no `agentx.e2e`)
- Test: `tests/unit/e2e-execution-plan.test.ts`, `tests/unit/e2e-application-collection.test.ts`, `tests/linux/e2e-anonymous.test.ts`, `tests/e2e/m1-3-journeys.test.ts` (case `anonymous-inferred`)

**Interfaces:**
- Reserved account profile ID `rovara-anonymous`.
  - A contract may not declare it; declaring it is refused with `reserved-account-profile`.
  - Every web/API target implicitly offers it.
  - It has no registry row. Its account ref is the fixed `{ applicationId, profileId: "rovara-anonymous", revision: 1, definitionDigest: sha256("rovara-anonymous/v1\0" + applicationId) }`.
  - The executor opens no session for it: a fresh context with no cookies.
- Inferred-recipe targets are executable for `rovara-anonymous` scenarios only. A non-anonymous scenario on an inferred target stays unavailable with `needs-project-contract`.

- [ ] **Step 1: Write the failing tests.**
  - A plan with one `rovara-anonymous` web scenario on an inferred target selects one application group with no unavailable criteria.
  - The same target with an `orders-owner` scenario stays `needs-project-contract`.
  - The collector qualifies an anonymous case with no account binding, and refuses an anonymous case whose report claims a session.
  - A contract declaring `rovara-anonymous` is refused.
  - Linux: the inferred app builds with `npm ci` and starts on `PORT=4317`, and `GET /` shows `data-testid=welcome`.
  - journey `anonymous-inferred`: plan → PASS → publication checks non-empty.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): anonymous scenarios and inferred-recipe web apps`

### Task 3.4: Web and API in one plan: runtime keying by (profile, kind) (Ruling BF)

**Files:**
- Modify: `packages/contracts/src/e2e-application-execution.ts` (runtime binding key format, admission version), `packages/broker/src/e2e/application-admission.ts` (`:171` keys), `packages/broker/src/e2e/application-plan-approval.ts` (drop the "one runtime kind per plan" refusal)
- Modify: `packages/verifier/src/application-scenarios.ts` (`:181` lookup), `packages/verifier/src/application-result-adapter.ts`, `packages/worker/src/main.ts` and `workflow-e2e-application-runtime.ts` (feature string)
- Test: `tests/contract/e2e-application-execution.test.ts`, `tests/contract/workflow-e2e-application-gating.test.ts`, `tests/e2e/m1-3-journeys.test.ts` (case `web-and-api`)

**Interfaces:**
- `runtimeBindings[].key = "<runtimeProfileId>#<kind>"`, for example `linux-arm64-web-api-v1#web` (the same suffix as the catalog row `sk`). The application admission's `schemaVersion` goes up by 1. The previous version still decodes for reading stored records, but the broker no longer builds it.
- Groups: one per `(runtimeProfileId, kind, applicationId)`, so web and API targets of one app are two groups in one round, run at most 2 at a time. The round verdict combines them as `combineE2EVerdicts` already does: any FAILED → FAILED; otherwise any UNKNOWN → UNKNOWN; otherwise PASS.
- Workers advertise `task.workflowE2EApplicationChecks.v2`. Dispatch sends the new admission only to workers that advertise it; any other worker gets RUNTIME_UNAVAILABLE with "This worker can't run combined browser and API checks yet; retry once it restarts."
- Each group's deadline stays under the one-hour stale sweep. It is computed as `min(binding deadline, groupStart + 25 min)`.

- [ ] **Step 1: Write the failing tests.**
  - A v2 intent with a web scenario and an API scenario on one app approves, and dispatch builds one admission with keys `…#web` and `…#api` and two groups.
  - The verifier compiles each group against its own kind's descriptor (an API `request` step in a web group is refused).
  - The web group PASS with the API group FAILED gives a FAILED round with send-back offered.
  - A worker without `.v2` is refused at dispatch with the sentence above.
  - The old admission version still decodes.
  - The parsed approved intent equals `admission.intent` (FX3 lesson).
  - journey `web-and-api`: the tenant-a owner gets 403 from `GET /api/tenants/tenant-b/orders` (API, `http-status`), and the web table shows only tenant-a rows (`text`).
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): web and API targets in one plan with kind-keyed runtime bindings`

### Task 3.5: External-origin mocks and unmocked-call detection

**Files:**
- Create: `packages/verifier/src/executor/mock-server.ts` (second executor-image mode: `node /opt/agentx/packages/verifier/dist/executor/entry.js --mock /mock/fixture.json`)
- Modify: `packages/verifier/src/host/docker-application-host.ts` (mock containers, sinkhole, origin env), `packages/verifier/src/host/executor-readback.ts` (consumption ledger readback), `packages/verifier/src/application-result-adapter.ts` (`unmocked-external-call`)
- Modify: `packages/contracts/src/e2e-application-services.ts` (`originBindings[]` gains optional `contractPath`, linking an origin to the discovery component `api-schema-<sha256(path)[0:12]>`)
- Modify: `packages/verifier/src/install-qualification.ts`, `packages/broker/src/aws/e2e-feature-verifier-catalog.ts` (descriptor `mocks: ["source-backed-api-fixtures/v1"]`)
- Create: probe assets `packages/verifier/assets/application-runtime-v1/probes/web-mock-origin-v1`, `web-unmocked-call-v1`
- Test: `tests/unit/e2e-mock-server.test.ts`, `tests/unit/e2e-docker-application-host.test.ts`, `tests/unit/install-qualification-web.test.ts`, `tests/linux/e2e-mocks.test.ts`, `tests/e2e/m1-3-journeys.test.ts` (case `mocked-origin`)

**Interfaces:**
- For each `mockManifest` row of the group, the host runs `rovara-mock-<runId>-<originRef>` (alias `mock-<originRef>`, port 8080) and gives the app `<envName>=http://mock-<originRef>:8080`. Every other non-owned declared origin gets `<envName>=http://mock-unbound:8080` (one sinkhole container per run).
- The mock serves exactly the fixture's `method` and `path` and picks the variant whose `inputValue` equals the query parameter `inputField`. Anything else, including any call to the sinkhole, gets `599`.
- Each request appends one line to `/out/mock/<originRef>.jsonl`: `{ requestId, method, path, inputValue, variantId | null, status, requestSha256, responseSha256, observedAt }`, at most 2048 lines per run. The collector turns these into `mockConsumptions` rows bound to the case by the time window of the executor's action.
- Result: `mockedOrigins: string[]` per case and per round. A required case with any `variantId: null` line is UNKNOWN with `unmocked-external-call`.
- Qualification adds two required probes (11 in all):
  - `web-mock-origin-v1`: PASS, with exactly one `success` consumption;
  - `web-unmocked-call-v1`: EXPECTED_FAILURE = UNKNOWN for `unmocked-external-call` with one sinkhole line. Any other cause rejects (Ruling X style).

  The required probe set changes, so requalify (Task 3.9).

- [ ] **Step 1: Write the failing tests.**
  - unit: the mock returns the `success`, `refusal` and `invalid-data` variant by `inputValue`. A wrong path, a wrong method, or a missing `inputField` gives 599 and a `variantId: null` line.
  - unit: the mock container's arguments carry only `rvi`, cap-drop, read-only, no secrets env and no docker socket.
  - unit: an origin without an approved mock points at `mock-unbound`. The app env never contains a non-`mock-` host.
  - unit: `mockedOrigins` appears in the collected result.
  - Linux: the M1.3 baseline's `inventory-v1` is mocked, and the owner CSV shows `in-stock` for `a1` and `unavailable` for `a2`: PASS.
  - Linux: the `dependency-route` defect (calls `/internal/admin`) gives UNKNOWN with `unmocked-external-call`.
  - Qualification: the evaluator accepts all 11 outcomes and rejects `web-unmocked-call-v1` passing.
  - journey `mocked-origin`: the round is PASS with `mockedOrigins: ["inventory-v1"]` on the display row.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): approved in-network external-origin mocks with unmocked-call detection`

### Task 3.6: Screenshots, traces and raw reports in evidence

> Ruling CJ: trace capture is deferred past M1.3. Everything below that says "trace" is not built; capture is screenshots plus the raw reports and observations. See the capture budget in Global Constraints.

**Files:**
- Modify: `packages/verifier/src/executor/run.ts`, `packages/verifier/src/executor/case-ledger.ts`, `packages/verifier/src/web-runtime.ts` (capture follows the admitted policy, Ruling BZ), `packages/verifier/src/executor/redact.ts`
- Modify: `packages/worker/src/workflow-e2e-application-checks.ts` (evidence packing, budget), `packages/broker/src/aws/broker.ts` (store artifacts under the existing `workflow-e2e-group-evidence` refs; capture policy default)
- Test: `tests/unit/e2e-executor-capture.test.ts` (new), `tests/contract/workflow-e2e-application-evidence.test.ts`, `tests/linux/e2e-capture.test.ts`

**Interfaces:**
- The capture policy default for new web targets (owner decision D3) is `{ screenshots: true, traces: true, video: false, downloads: true }`. It replaces the all-false default at `broker.ts:353` for new setup approvals only. Existing projects keep their stored policy until setup is approved again.
- The executor captures under the budget in Global Constraints. Artifact names are `case-<caseIndex>-<kind>.<ext>`, never scenario text or account names. Each artifact is listed in `artifacts.json` as `{ caseId, kind: "screenshot" | "trace", sha256, bytes, omitted?: "budget" | "credential-match" }`.
- Raw per-case evidence is always packed, as listed in Global Constraints.

- [ ] **Step 1: Write the failing tests.**
  - A FAILED case gets one screenshot of at most 524288 bytes and one trace of at most 4194304 bytes. A PASS case gets none.
  - A 7 MiB artifact set drops the trace first, records `omitted: "budget"`, and leaves the verdict unchanged.
  - A trace that contains a seeded password is dropped with `credential-match`.
  - With capture off, nothing is captured (the Ruling BZ regression).
  - A qualified group's evidence contains `report.json` and the observations.
  - No pinned probe digest moves (the qualification policy stays capture-off).
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): bounded screenshots and traces; raw per-case evidence always kept`

### Task 3.7: Per-scenario results on the page and in Slack; baseline round

**Files:**
- Modify: `packages/broker/src/aws/workflow-e2e-notifier-projection.ts`, `packages/broker/src/e2e-presentation.ts`, `packages/broker/src/aws/task-web-api.ts` (artifact read route), `packages/broker/src/aws/task-page-assets.ts`, `packages/broker/src/aws/developer-task-notifier.ts`
- Modify: `packages/broker/src/aws/broker.ts` (baseline dispatch at APPROVE when D2 = yes), `packages/broker/src/aws/developer-tasks.ts` (baseline is recorded apart from candidate rounds)
- Test: `tests/contract/workflow-e2e-notifier-projection.test.ts`, `tests/contract/task-web-api-e2e-artifacts.test.ts` (new), `tests/contract/workflow-e2e-baseline-round.test.ts` (new), `tests/e2e/m1-3-journeys.test.ts` (case `results`)

**Interfaces:**
- Display schema `displaySchemaVersion: 2` adds `scenarios[]`:

  ```
  { scenarioId, title ≤ 120, kind: "web" | "api", accountLabel ≤ 60 (profile id, never email),
    status: "PASSED" | "FAILED" | "UNKNOWN", reason?: string,
    failedAssertion?: { kind, expected ≤ 200, actual ≤ 200 },
    screenshotRef?, traceRef?, mockedOrigins: string[] }
  ```

  It also adds `baseline?: { status, scenarios[] }`. Readers accept v1 and v2.
- Expected vs actual is derived by the broker from verified evidence:
  - `csv`: `expected 2 rows, received 3` plus the first differing row;
  - `text`: the expected and the actual text;
  - `visible`: `expected hidden, was visible`;
  - `http-status`: `expected 403, received 200`;
  - `json`: the first differing JSON pointer.
- Page: one row per scenario, with a status, the account label, a mocked badge ("Inventory service mocked") and links to the screenshot and trace. Route: `GET /v1/tasks/<taskId>/e2e/artifacts/<sha256>`. It needs a task session (owner, developer or viewer of the task's channel) and streams the private object with `content-type` from the artifact list and `cache-control: private, max-age=300`. It answers 404 for any digest not in the task's current display.
- Slack, text only, at most 3000 characters:
  - `Browser and API checks: 4 passed, 1 failed, 0 incomplete`;
  - then the first FAILED row: `Viewer can't export — failed: expected hidden, was visible (orders-viewer)`;
  - then `Mocked: inventory-v1`;
  - then the task-page link.

  A baseline adds `Before the change: 2 of 5 failed, as expected for new behaviour.`
- Baseline round (D2): at APPROVE the broker dispatches one extra application round on the prepared base commit, with `purpose: "baseline"`. It records the result only in `baseline` and never in `qualifiedRound` or `failedRound`. It ignores the result for gating and send-back. If it fails to run, the display shows "Couldn't run the checks on the unchanged code" and nothing else changes.
- Ruling AU: check that FU1 item 10 is on mainline. Add plain sentences for `accounts-changed-reapprove` and `mock-fixture-changed-reapprove`.

- [ ] **Step 1: Write the failing tests.**
  - The extra-order defect renders `Owner export — failed: expected 2 rows, received 3`.
  - Display v2 is read by the current notifier. A v1-only reader falls back to "Open the task page", never a verdict.
  - No display row, Slack block or artifact list contains a seeded credential or email.
  - The artifact route returns 403 for a non-member, 404 for a digest outside the display, and 200 with `content-type: image/jpeg` for the screenshot.
  - The baseline FAILED does not set `failedRound` or offer send-back, and the candidate PASS still publishes.
  - The baseline failing to run leaves APPROVE and CHECKS unchanged.
  - journey `results`: the baseline is FAILED with a screenshot ref; candidate 1 is FAILED (`viewer-access`) with a screenshot and expected vs actual; candidate 2 is PASS; the page HTML lists 5 rows.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): per-scenario results with screenshots, expected vs actual, and an informational baseline round`

### Task 3.8: M1.3 fixture baseline for `rovara-orders-web-fixture`

**Files:**
- Create: `tests/fixtures/orders-web-m13/` (starter + reference CSV export + the M1.3 contract), `scripts/fixtures/publish-web-fixture.ts --variant m13`
- Test: `tests/contract/orders-web-m13-fixture.test.ts` (the contract parses; discovery finds the `inventory/openapi.json` edge; the mock fixture validates against it; `node --test` passes)

**Interfaces (exact fixture changes):**
1. **CSV export as the M1.2 reference shape, without inventory:** owner-only button `data-testid=export-csv` and route `GET /api/orders.csv?from&to`, with the CSV-injection quoting that M1.2's security review required. The viewer check is deliberately missing, the `viewer-access` defect state: viewers see and can use the export. That is the bug the request fixes, so the baseline round fails on it.
2. **Orders table** `data-testid=orders-table`, one row per order (`data-testid=order-row-<id>`). No inventory column.
3. **Accounts:**
   - `orders-owner` (tenant-a, owner), `orders-viewer` (tenant-a, viewer) and new `orders-owner-b` (tenant-b, owner);
   - all three use seed `rovara-accounts-file/v1` with `recipe.seed = node scripts/seed.mjs` and auth `rovara-form-login/v1` with `{ path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" }`;
   - `synthetic` is dropped;
   - `targetAccounts` covers `web-1` and `api-1` for all three.
4. **Inventory origin:** `inventory/openapi.json` (one operation, `GET /v1/stock`, query `orderId`, `200 { status: "in-stock" | "low" | "out" }`, `404 { error }`). `e2e/mocks/inventory-v1.json` follows `source-backed-api-fixtures/v1`, with variants:
   - `success` (`a1` → 200 in-stock);
   - `refusal` (`a2` → 404);
   - `invalid-data` (`b1` → 200 `{ status: 7 }`).

   `originBindings` `inventory-v1` gets `contractPath: "inventory/openapi.json"`. `INVENTORY_ORIGIN` is read but not yet used for rows.
5. **README** describes the above. The `node --test` CI is kept.

- Publish (owner decision D1): the owner OKs the push to `main` of `abhishek255/rovara-orders-web-fixture` (an outward-facing action). Draft PR #1 (M1.2 demo record) is closed unmerged and kept as a link.
- [ ] **Step 1: Write the failing contract test. Step 2: build the fixture until it passes. Step 3: dry-run the publisher and show the owner the file list. Step 4: commit** `chore(fixtures): M1.3 orders fixture baseline with accounts, tenant-b and inventory contract`

### Task 3.9: Ship PR D, deploy check, deploy, requalify, live demo

- [ ] **Step 1: Write the M1.3 section of `docs/specs/rovara-e2e-runtimes/m1-live-acceptance.md`** (below).
- [ ] **Step 2: Open PR D** (Tasks 3.0–3.8) as a draft. Wait for every CI job, including `linux-runtime` with all `m1-3-journeys` cases. One review pass, at most one re-review; blockers only.
- [ ] **Step 3: Run the TEST deploy check** (`--check`) from the PR head. Every `iam-missing-grant` goes to the owner as one Tier 3 packet, applied by a guarded change set. Expect none: M1.3 adds no SSM parameter or role. A finding means drift.
- [ ] **Step 4: Deploy.** `test-deploy --apply --only control-plane-code,worker-image,executor-image`, then `--check` again. It must exit 0 except `catalog-*` and `runner-image-mismatch`, which requalification clears.
- [ ] **Step 5: Requalify** with `test-qualify-runtime --apply` (owner OK for the spend; 11 probes). Retire the old runner and its volume after the rows are READY. Run `--check` again: exit 0.
- [ ] **Step 6: Publish the fixture baseline** (Task 3.8, owner OK). Approve setup again for `rovara-web-fixture` (owner admin sign-in), so the registry writes the three definitions and the new capture policy.
- [ ] **Step 7: Run the live demo, record it in `status.md` and `m1-live-acceptance.md`, and merge after owner approval** (no production release).

---

## M1.3 live acceptance (TEST `agentxlivetest123`)

**Preconditions:**
- PR D head deployed and `--check` exit 0.
- Rows `PROFILE#linux-arm64-web-api-v1#web` and `#api` READY on the new 11-probe revision, with more than 24 h to expiry.
- Fixture baseline published, and setup approved again.
- Slack `#rovara-web-fixture` bound.
- FU1 merged (AU wording).

**Request (Slack, `#rovara-web-fixture`, exactly):**

> Viewers must not be able to export orders, and each tenant must only ever see and export its own orders. Add each order's inventory status from the inventory service to the orders table and the CSV export.

**Expected plan** (v2 intent, one app, web + API targets, the inventory mock selected):

| Scenario | Kind / account | Assertion | Mock |
|---|---|---|---|
| `owner-export-with-inventory` | web / `orders-owner` | `csv` has the `inventory` column: `a1,in-stock`, `a2,unavailable` | inventory-v1 |
| `viewer-export-refused` | web / `orders-viewer` | `visible` `export-csv` hidden | none |
| `viewer-export-api-refused` | api / `orders-viewer` | `http-status` 403 on `GET /api/orders.csv` | none |
| `tenant-isolation-api` | api / `orders-owner` | `http-status` 403 on `GET /api/tenants/tenant-b/orders` | none |
| `tenant-isolation-web` | web / `orders-owner-b` | `text`: the table has `b1` and no `a1` | inventory-v1 |
| `signed-out-visitor` (optional) | web / `rovara-anonymous` | `visible` sign-in form, `export-csv` hidden | none |

**Pass criteria** (all required):
1. The plan is approved with web and API scenarios together (BF) and three distinct accounts in two tenants. The page shows the account refs at revision 1 from the registry.
2. **Baseline round on the unchanged code:**
   - `viewer-export-refused` and `owner-export-with-inventory` are FAILED;
   - the page shows a screenshot for each, plus expected vs actual (`expected hidden, was visible`; `expected column inventory, missing`);
   - Slack shows `Before the change: … failed, as expected for new behaviour`.

   This meets the exit's "a failure shows a screenshot and expected vs actual" deterministically. If the coding agent's first candidate also fails a scenario, record that too.
3. A candidate round is broker-verified PASS for every required scenario, with `inventory-v1` shown as mocked on the page and in Slack, and no `unmocked-external-call`.
4. The draft PR in `rovara-orders-web-fixture` has green CI.
5. **Evidence kept and recorded in `status.md`:**
   - task ID, round IDs, candidate SHAs;
   - the operator S3 keys of every group's raw `report.json` and observations (baseline and candidate);
   - screenshot digests;
   - the deploy `--check` outputs (before and after);
   - catalog revisions and runner ID.

   No credential, cookie or challenge appears anywhere in the record.
6. **No leftovers.** No `rovara.run` resources are left on the runner after the rounds (operator reads the qualification status object, or the hook's journal).

**Not a pass:** a PASS whose display lacks `mockedOrigins`, any stale-Lambda or IAM finding found during the demo instead of before it, or a baseline result shown as a gate.

## Risks

| Risk | Mitigation |
|---|---|
| The coding agent calls inventory differently from the fixture contract (another path, or no `orderId` query): unmocked → UNKNOWN, not send-back | The plan context gives the planner and coder the OpenAPI path. The display names the unmatched call. The owner sends back with that text. Recorded as a known UX gap (UNKNOWN offers retry, not send-back) for M1.4. |
| The approved CSV literals (`in-stock`, `unavailable`) differ from the wording the agent picks | The plan's scenarios are the spec the coding agent sees. A mismatch is FAILED with expected vs actual, which offers send-back. That is the intended loop, not a demo failure. |
| Form login is flaky in the real Chromium (timing) | A fixed 10 s wait for `successTestId`, no retries (retries never pass). A login failure is UNKNOWN `login-failed`, never FAILED. The Linux test runs it 20 times in CI before merge. |
| Two groups per round double build time and evidence size | At most 2 concurrent groups (P0 limit), per-group deadline ≤ 25 min, 6 MiB artifact budget inside 8 MiB. Measure the live sizes and revisit Ruling BV after the demo. |
| Account definitions expire mid-project (90 days) | Expiry gives `accounts-changed-reapprove` with a plain sentence. Approving setup again renews it. Nothing silently passes. |
| Traces leak application data (page text, URLs) to operator evidence | Already true of raw reports (final review minor 7). Traces only on failure, operator-only, redacted for credentials. Documented in status.md "Before untrusted candidates". |
| Executor image change, probe-set change and a new admission version need a coordinated TEST rollout | One deploy order (Task 3.9), `--check` before and after, and requalification last. The worker feature `.v2` makes a mixed fleet fail closed. |
| The baseline round doubles runner time per approval | It is one round per APPROVE, not per candidate, and it can be switched off per project (D2). |
| Rollback | A rollback to M1.2 code is safe only while no task holds display v2, registry refs or the new admission version. TEST only; no production records. |

## Owner decisions (ask once, up front)

- **D1, fixture baseline:** may Rovara push the M1.3 baseline (Task 3.8) to `main` of `abhishek255/rovara-orders-web-fixture` and close draft PR #1 unmerged? Recommended: yes. The alternative is merging PR #1, which is agent-written and not deterministic.
- **D2, baseline round:** add the informational baseline round, so the live demo shows a real failure with a screenshot every time? Recommended: yes. Without it, the live failure depends on the agent's first candidate failing (it didn't in M1.2), and the failure display is proven only by the CI journey.
- **D3, capture and Slack:** the default capture for new web targets is screenshots and traces on failure. Slack is text only, with a page link, and no image upload to Slack. Recommended: yes.
- **D4, artifact retention:** keep screenshots and traces under the existing private-artifacts retention. If that bucket has no lifecycle rule for these keys, do we add a 30-day expiry (an infra change, Tier 3) or accept indefinite retention in TEST?
- **D5, registry writer:** account definitions are written automatically at setup approval, which the owner already approves and which now lists the accounts. The alternative is a separate admin CLI step. Recommended: automatic. Expiry is 90 days.
- **D6, deferrals:** confirm that BE (mixed portable + application) and real external connections are deferred past M1.3.
- **D7, spend:** expect 2–3 qualification runner launches during M1.3, each one `m6g.large` plus a 20 GiB gp3 volume, kept for the demo window. Pre-approve up to 3, or ask each time?
- **D8, anonymous and inferred:** prove Ruling AZ in CI only, plus the optional `signed-out-visitor` scenario live. Or also stand up a second, inferred-recipe fixture repo live (another owner-created repository)? Recommended: CI only.
- **D9, release:** M1.3 merges to mainline without a production release, as M1.2 did. The production Release transition stays disabled, and `final-merge-review.md`'s checklist still applies before any release.

## Needs Tier 3 approval

- **IAM:** none is expected. M1.3 adds no role, SSM parameter or bucket. Task 3.0's `--check` decides. Any `iam-missing-grant`, for example if the broker role lacks `s3:GetObject` on the evidence prefix for the new artifact route, comes to the owner as one packet: the exact statement, role, guarded change set and rollback.
- **New resources:** none is planned. Registry rows go in the existing broker table, artifacts in the existing private bucket, and the image in the existing executor ECR repository. A lifecycle rule (D4) would be the only one.
- **External egress for mocks:** none. Mocks and the sinkhole run on the run's `--internal` bridge. The H1 firewall (`rvi+` drops to anything outside an `rvi` bridge) is unchanged. Any request to open egress for real services is out of scope (D6).
- **Spend:** qualification runner launches (D7). This is explicit owner OK and is not covered by the fast-lane packet.
- **Outward-facing:** pushing the fixture baseline and closing PR #1 (D1).


## Owner decisions (recorded 2026-10-20)

All recommended: D1 yes (push fixture baseline to main, close PR #1 unmerged); D2 yes (informational baseline round); D3 yes (capture on failure; Slack text + page link); D4 reuse existing private-artifact retention, else add a 30-day lifecycle rule; D5 automatic account definitions at setup approval, 90-day expiry; D6 defer mixed portable+application plans and real external connections; D7 up to 3 TEST runner launches pre-approved; D8 anonymous/inferred apps proven in CI (+ optional signed-out scenario live); D9 merge M1.3 to mainline with no production release.
