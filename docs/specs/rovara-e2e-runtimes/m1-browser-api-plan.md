# M1: Browser and API Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rovara verifies web and HTTP API features by building the exact candidate, running it in a contained environment, and exercising it with a real Chromium browser and real HTTP requests before a draft PR opens. This is shipped to mainline and proven live in TEST.

**Architecture:** Extend the merged P0 pipeline (discovery → plan intent → CHECKS round → result adapter → broker re-verification → publication guard) with an *application* execution branch:

- **Salvaged pieces** from branch `codex/rovara-e2e-runtime-automation-20261017`: the compiler and the web/API case hosts.
- **The worker** runs an application round through a new Docker host. The host makes a per-run `--internal` network and three containers: build (egress, no credentials, IMDS dropped), app (internal only) and Rovara executor (e2e CLI + `@e2e-dev/web` + local Chromium, internal only).
- **Results** reuse the application result adapter; the publication guard is unchanged.

**Tech Stack:** Node 22.23.2, TypeScript 5.9.3, Vitest 5.0.1, `e2e` 0.20.0 (`upstream/e2e-0.20.0.tgz`), `@e2e-dev/web` 0.14.0, `playwright-core` 1.63.0, Docker on Amazon Linux 2023 arm64 (EC2 `m6g.large` runner), AWS CDK (`infra/`), GitHub Actions.

**Spec:** `docs/specs/rovara-e2e-runtimes/roadmap.md` (the Decisions and M1 rows), plus the Oct 12 product spec `ManagedSDLC/docs/superpowers/specs/2026-10-12-rovara-tester-army-e2e/` for UX intent.

## Global Constraints

- Node exactly `v22.23.2` for qualification and the native suites; `engines` is `>=22.19.0 <23`.
- Pinned: `e2e@0.20.0`, `@e2e-dev/web@0.14.0`, `playwright-core@1.63.0`. No automatic upgrades.
- Base image: `public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` (same as `environments/base/Dockerfile`).
- **Containers.** App and executor containers:
  - attach only to `rovara-e2e-<runId>`, created with `docker network create --internal`;
  - never mount the Docker socket;
  - never receive any `AWS_*`, `AGENTX_*`, `PI_*`, `GIT_*` or `*TOKEN*`/`*SECRET*` variable;
  - run with `--cap-drop=ALL --security-opt no-new-privileges`.

  The build container runs on its own per-run internet-only bridge (H1: no default bridge; the host firewall drops it from the host and private ranges). IMDS (`169.254.169.254`) must be unreachable from every container.
- No host port publishing (`-p`). Every resource carries label `rovara.run=<runId>`; `close()` removes everything with that label.
- **Result semantics** (unchanged from P0):
  - skipped, flaky, retried, missing or stale results never become PASS;
  - a required scenario that couldn't run makes the result UNKNOWN, which blocks publication;
  - an assertion mismatch is FAILED, which offers send-back.
- Assertions are deterministic code. No model output decides pass or fail. `agent` steps stay unavailable until M1.4.
- **Owned files.** `packages/broker/src/aws/broker.ts`, `packages/broker/src/aws/developer-tasks.ts`, `packages/contracts/src/index.ts` and `package-lock.json` are edited by one task at a time (serialize those tasks).
- Don't edit `/Users/abhishekgarg/web/AgentX-spec059-20261012` (protected handoff checkout) or the paused Codex branch.
- Every AWS change in TEST goes through `scripts/test-deploy.ts` (Task 0.2) or CDK. No ad hoc console or CLI mutations.

## Review Focus

1. **Candidate app never becomes healthy, or crashes mid-run.** The round becomes UNKNOWN with reason `app-unhealthy` (or `app-exited`) and the last 64 KiB of app logs in evidence. All run containers are gone afterwards. Test lives in Task 1.4.
2. **App loads third-party assets (CDN fonts, analytics) that the internal network blocks.** The page still runs and blocked hosts are listed in evidence as diagnostics. A scenario fails only if one of its assertions fails. Test lives in Task 1.3.
3. **Build is slow or heavy** (large `npm ci`, a build that runs out of memory). Per-command timeout and memory cap apply. The round is UNKNOWN with `build-failed`, the log tail is shown, and send-back is offered. Test lives in Task 1.4.
4. **Two groups run concurrently on one runner** (P0 allows `MAX_CONCURRENT_E2E_GROUPS = 2`). Networks, container names and output directories are per-run, with no cross-talk. Test lives in Task 1.4.
5. **Runner restarts mid-run.** The next `allocate` sweeps resources labeled `rovara.run` older than 1 hour. The interrupted task surfaces UNKNOWN with retry; it isn't stuck. Test lives in Task 1.4.

---

## M1.0: TEST fast lane

### Task 0.1: Standing qualification transport (IaC)

**Files:**
- Modify: `infra/lib/ec2-workers.ts` (after the existing `instanceRole.addToPolicy` statements, ~line 112)
- Test: `tests/contract/ec2-worker-infrastructure.test.ts`

**Interfaces:**
- Produces: CDK context key `agentx:e2eQualificationTransport` (boolean, default `false`). When true, the instance role gets one statement allowing:
  - `s3:GetObject` on `<controlArtifactsBucket>/e2e-runtime/*/challenge.json`;
  - `s3:PutObject` on `<controlArtifactsBucket>/e2e-runtime/*/proposal.json` and `.../status.json`.

  There is no List, Delete or wildcard object access. Task 1.6 uses prefix `e2e-runtime/<installationId>/`.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds no qualification transport by default", () => {
  expect(statementsWithAction(template, "s3:GetObject").filter(onPrefix("e2e-runtime/"))).toHaveLength(0);
});
it("adds exact challenge/proposal/status object access when enabled", () => {
  const t = synthWorkers({ context: { "agentx:e2eQualificationTransport": true } });
  expect(resourcesFor(t, "s3:GetObject")).toEqual([expect.stringMatching(/\/e2e-runtime\/\*\/challenge\.json$/)]);
  expect(resourcesFor(t, "s3:PutObject").sort()).toEqual([
    expect.stringMatching(/\/e2e-runtime\/\*\/proposal\.json$/), expect.stringMatching(/\/e2e-runtime\/\*\/status\.json$/)]);
  expect(actionsMatching(t, /s3:(List|Delete)/)).toHaveLength(0);
});
it("keeps IMDS hop limit 1", () => expect(launchTemplateMetadata(template).HttpPutResponseHopLimit).toBe(1));
```

- [ ] **Step 2: Run them and confirm the new ones fail**

Run: `npx vitest run tests/contract/ec2-worker-infrastructure.test.ts`. Expected: the "when enabled" test fails.

- [ ] **Step 3: Implement the conditional statement.** Read the flag with `this.node.tryGetContext("agentx:e2eQualificationTransport") === true`. The bucket comes from whatever the stack already passes for control artifacts. If `Ec2Workers` doesn't receive it, add a `controlArtifactsBucket?: s3.IBucket` prop and thread it from `infra/lib/app.ts`.
- [ ] **Step 4: Run the tests until they pass.** Also run `npx vitest run tests/contract/infrastructure.test.ts` and expect no regressions.
- [ ] **Step 5: Commit** `feat(infra): optional standing E2E qualification transport for test installations`

### Task 0.2: One-command TEST deploy and the fast-lane runbook

**Files:**
- Create: `scripts/test-deploy.ts`, `docs/specs/rovara-e2e-runtimes/test-fast-lane.md`, `docs/specs/rovara-e2e-runtimes/status.md`
- Test: `tests/unit/test-deploy-plan.test.ts`

**Interfaces:**
- Produces: `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test [--apply] [--only broker,dispatcher,worker-image,executor-image]`.
  - Without `--apply`, it prints the plan and exits 0.
  - Exported pure function `planTestDeploy(input: { env: string; only: DeployUnit[]; artifacts: BuiltArtifacts; previous: StackParameters }): DeployStep[]`, where `DeployUnit = "broker" | "dispatcher" | "worker-image" | "executor-image"`.
  - Every CloudFormation step is a change set that changes only the listed parameter or Lambda code and sets every other parameter to `UsePreviousValue: true`. This reproduces the P0 procedure recorded in `AgentX-e2e-p0-20261012-evidence/.../deadline-fix/pr400-test-deployment-runtime-plan-2026-10-16.md`.

- [ ] **Step 1: Write the failing tests.**
  - `planTestDeploy({only:["broker"], ...})` returns exactly: build Broker zip → upload to the access stack's versioned artifact bucket (after checking its versioning is `Enabled` and that the deployed Broker's `Code.S3Bucket` is that bucket; templates for change sets go to the same bucket) → change set on the control-plane stack changing only `BrokerE1355FD6` Code → execute → verify Lambda `CodeSha256` equals the zip's sha256 (base64).
  - With `only:["worker-image"]`: ECR push → runtime stack change set with only `WorkerImageUri` changed.
  - The plan never contains a step touching any stack other than the control-plane and runtime stacks for `--env`.
  - An `env` that is not `agentxlivetest123` (or not listed in `scripts/test-deploy.allowlist.json`) throws `"test-deploy only targets allowlisted TEST installations"`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/test-deploy-plan.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `planTestDeploy` plus a thin `--apply` executor. Reuse `scripts/release-common.ts` for ECR ensure/push/verify and `describeStack`. Use `@aws-sdk/client-cloudformation` change sets, with `aws login --profile` credentials only.
- [ ] **Step 4: Run tests until they pass.**
- [ ] **Step 5: Write `docs/specs/rovara-e2e-runtimes/test-fast-lane.md`.** It is the owner's one-time Tier 3 approval packet in the format of ManagedSDLC `AGENTS.md:102-110`. It covers:
  - (a) deploying Task 0.1 with the context flag on for `agentxlivetest123` only;
  - (b) a lasting developer membership for the owner on fixture project `rovara-web-fixture` (Task 0.3);
  - (c) `limits.workspacesPerMember` set to 5 in TEST;
  - (d) `scripts/test-deploy.ts --apply` as the standing TEST deploy path.

  Seed `docs/specs/rovara-e2e-runtimes/status.md` with the M1 sub-milestone table from the roadmap, all "not started".
- [ ] **Step 6: Commit** `feat(scripts): plan-first TEST deploy and fast-lane runbook`

**Owner gate:** the owner approves `test-fast-lane.md` once. After that, M1 never asks for per-run grants.

### Task 0.3: Live web fixture repository

**Files:**
- Create (after Task 1.1 brings `tests/fixtures/e2e-web-api-app/`): `scripts/fixtures/publish-web-fixture.ts`
- Test: none (owner-run, verified by Step 3)

- [ ] **Step 1: Owner creates the private GitHub repo** `abhishek255/rovara-orders-web-fixture`. This is an outward-facing action, so the owner does it.
- [ ] **Step 2: Seed the repo.** `npx tsx scripts/fixtures/publish-web-fixture.ts --repo abhishek255/rovara-orders-web-fixture --dry-run` prints the files it will push:
  - the contents of `tests/fixtures/e2e-web-api-app/` minus `defects/`;
  - a GitHub Actions workflow running `node --test`;
  - `README.md` describing the orders page.

  The owner reruns it without `--dry-run`.
- [ ] **Step 3: Register the project** in TEST as `rovara-web-fixture` through the normal `agentx --env agentxlivetest123 project add` flow, and bind it to a Slack channel. Record the result in `docs/specs/rovara-e2e-runtimes/status.md`.
- [ ] **Step 4: Commit** `chore(fixtures): web fixture publisher`

**M1.0 exit:** `scripts/test-deploy.ts --apply --only broker` deploys a no-op rebuild to TEST, and `doctor` is green. The fixture project accepts a task from Slack. Record this in `status.md`.

---

## M1.1: Real browser and API runtime on the runner

### Task 1.1: Port the salvaged browser/API code onto this branch

**Files:**
- Cherry-pick, in this order: `13281458 972a4f9a 32bf8330 f8e4a875 62ad3870 9fedffdb a8ee5a9a e8e32229 7829eb79 a7792e5b 1b2018cc 182d0c88 a5ca634e 78a96add 728d69a8 a6c50f82`
- From `8ca50053`, take only these paths with `git checkout 8ca50053 -- <paths>`:
  - `packages/contracts/src/{e2e-application-accounts,e2e-application-cli-launch,e2e-application-metadata,e2e-application-services,e2e-catalog,e2e-native-recipes}.ts`
  - `packages/verifier/src/{api-runtime,api-templates,application-network,application-runtime-assets,application-runtime-bootstrap,application-runtime-probes,application-scenarios,application-services,web-runtime,web-templates}.ts`
  - `packages/verifier/src/host/artifact-store.ts`
  - `packages/verifier/assets/application-runtime-v1/{file-fixtures,probes}/`
  - `tests/contract/{e2e-application-accounts,e2e-application-services}.test.ts`
- Hand-edit: `packages/contracts/src/index.ts`, `packages/verifier/src/index.ts`, `packages/verifier/package.json`, `package-lock.json`
- Leave behind: `environments/e2e-linux/**`, `packages/verifier/src/host/linux-*.ts`, `host/cli-supervisor.ts`, `android-provider.ts`, `ios-provider.ts`, `mobile-*.ts`, `native-*.ts`, `packages/verifier-native/**`, `assets/application-runtime-v1/cli-hosts.json`, every Darwin and mobile test

**Interfaces:**
- Produces (used by later tasks, names exactly as they are on the source branch):
  - `compileE2EApplicationScenarios`, `validateE2EApplicationExecutionAdmission`, `encodeE2EApplicationExecutionAdmission` and `decodeE2EApplicationExecutionAdmission` (`application-scenarios.ts`)
  - `createWebApplicationCliHost` and `E2EWebRuntimePorts` (`web-runtime.ts`)
  - `createAPIApplicationCliHost` and `E2EApiRuntimePorts` (`api-runtime.ts`)
  - `runIsolatedE2EApplication` and `E2EApplicationRuntimePorts` (`application-runtime.ts`)
  - `prepareE2EApplicationEnvironment` and `sealE2EApplicationEnvironment` (`application-services.ts`)
  - the application collector and adapter (`application-collection.ts`, `application-result-adapter.ts`)
  - `projectE2ERuntimeReadiness` (`broker/src/aws/e2e-runtime-readiness.ts`)

- [ ] **Step 1: Cherry-pick the 16 commits in order.** Resolve conflicts in `package-lock.json`, `contracts/src/index.ts` and `verifier/package.json` by keeping both sides' exports and dependencies. If a commit conflicts anywhere else, stop and record the file in `status.md`. The branch analysis found no other overlaps.
- [ ] **Step 2: Check out the `8ca50053` subset.** Remove the barrel lines for `native-bundle`, `native-artifact-staging`, `mobile-provider`, `android-provider`, `ios-provider` and `mobile-templates` from `packages/verifier/src/index.ts`. Remove `@e2e-dev/mobile` and `agent-device` from `packages/verifier/package.json`. Run `npm install` on Node 22.23.2 to regenerate the lockfile.
- [ ] **Step 3: Build and type-check.** Run `npm run build && npm run typecheck:all`. Expected: exit 0 and a baseline of 0 new errors. If a kept file imports a left-behind file, handle it in one of two ways:
  - if the import is a pure type or schema, bring that file too;
  - otherwise, remove the dependent code path, and add a test showing that path returns "unavailable".
- [ ] **Step 4: Run the salvaged tests.** Expected: all pass, except those gated to Linux/procfs, which skip on macOS.

```bash
npx vitest run tests/unit/e2e-web-runtime.test.ts tests/unit/e2e-api-runtime.test.ts tests/unit/e2e-web-templates.test.ts \
  tests/unit/e2e-api-templates.test.ts tests/unit/e2e-application-*.test.ts tests/unit/workflow-e2e-application-planning.test.ts \
  tests/contract/e2e-application-*.test.ts tests/contract/e2e-runtime-*.test.ts
```

- [ ] **Step 5: Run the P0 regression.** `npx vitest run tests/unit/e2e-compiler.test.ts tests/unit/e2e-result-adapter.test.ts tests/contract/workflow-e2e-current-authority.test.ts tests/contract/e2e-feature-verifier-catalog.test.ts`. Expected: PASS.
- [ ] **Step 6: Lint.** `npm run lint`. Expected: exit 0.
- [ ] **Step 7: Commit** `feat(e2e): port browser and API runtime foundation from runtime-automation branch`

### Task 1.2: Executor image and the Linux runtime CI job

**Files:**
- Create: `environments/e2e-executor/Dockerfile`, `.github/workflows/ci.yml` job `linux-runtime`
- Test: `tests/contract/executor-image-closure.test.ts` (model it on `tests/contract/verifier-image-closure.test.ts`)

**Interfaces:**
- Produces image `rovara-e2e-executor`. Its entrypoint is `node /opt/agentx/packages/verifier/dist/executor/entry.js` (Task 1.3) and its smoke command is `node /opt/agentx/packages/verifier/dist/executor/smoke.js`. It runs as user `node`, with Chromium from `playwright-core@1.63.0 install --with-deps chromium` under `/ms-playwright`.

- [ ] **Step 1: Write the failing test.**

```ts
it("pins the base by digest and the browser stack by exact version", () => {
  expect(dockerfile).toMatch(/^FROM public\.ecr\.aws\/docker\/library\/node:22\.23\.2-bookworm-slim@sha256:83f487e0/m);
  expect(dockerfile).toContain("playwright-core@1.63.0 install --with-deps chromium");
  expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  expect(dockerfile).toMatch(/^USER node$/m);
});
it("closes over the e2e and web packages at pinned versions", () => {
  expect(installedVersion("e2e")).toBe("0.20.0");
  expect(installedVersion("@e2e-dev/web")).toBe("0.14.0");
  expect(installedVersion("playwright-core")).toBe("1.63.0");
});
```

- [ ] **Step 2: Run** `npx vitest run tests/contract/executor-image-closure.test.ts` and expect FAIL (no Dockerfile).
- [ ] **Step 3: Write the Dockerfile.** Use a multi-stage build like `environments/base/Dockerfile`: build stage `npm ci && npm run build`; runtime stage copies `packages/contracts`, `packages/verifier` (dist + package.json) and the production `node_modules` closure. Set `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.
- [ ] **Step 4: Add the CI job** `linux-runtime` on `ubuntu-24.04-arm`. It does `docker build -f environments/e2e-executor/Dockerfile -t rovara-e2e-executor:ci .`, then `docker run --rm --network none rovara-e2e-executor:ci node /opt/agentx/packages/verifier/dist/executor/smoke.js`, then `ROVARA_DOCKER=1 ROVARA_EXECUTOR_IMAGE=rovara-e2e-executor:ci npx vitest run tests/linux`. Add it to the "Every job passed?" aggregate.
- [ ] **Step 5: Run the test until it passes. Commit** `build(e2e): pinned browser executor image and linux runtime CI job`. CI goes fully green after Task 1.3 adds `smoke.js`.

### Task 1.3: Executor in-container runtime

**Files:**
- Create: `packages/contracts/src/e2e-executor.ts`
- Create: `packages/verifier/src/executor/case-ledger.ts`, `local-browser.ts`, `entry.ts`, `smoke.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/verifier/src/index.ts` (export the schema and `runE2EExecutor` only)
- Test: `tests/unit/e2e-executor-ledger.test.ts`, `tests/unit/e2e-executor-plan.test.ts`, `tests/linux/e2e-executor-chromium.test.ts`

**Interfaces:**
- Consumes: `createWebApplicationCliHost` and `createAPIApplicationCliHost` (Task 1.1). Port the CLI composition from `git show c3b2ff95:packages/verifier/src/host/linux-cli-entry.ts`, replacing helper-transport ports with the ports below.
- Produces:
  - `E2EExecutorPlanSchema` (strict): `{ schemaVersion: "e2e-executor-plan/v1"; runId: uuid; compiledSuite: E2ECompiledApplicationSuite; admissionDigest: sha256hex; app: { origin: "http://app:4317"; health: { path: string; expectedStatus: number; timeoutMs: number ≤ 120000 } }; deadlineAt: epochMs }`.
  - `createFileCaseLedger(root: string, plan: E2EExecutorPlan): Pick<E2EWebRuntimePorts, "casePlans" | "caseObservations" | "evidence" | "actionWindows">`.
  - `launchLocalChromium(input: { downloadDir: string; signal: AbortSignal }): Promise<{ cdpEndpoint: string; close(): Promise<void> }>`. It uses `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0` and reads `DevToolsActivePort`.
  - `runE2EExecutor(input: { planPath: string; outDir: string; signal: AbortSignal }): Promise<{ exitCode: 0 | 1 | 2 }>`, where `0` means the run completed, `1` means the run completed with failures, and `2` means unavailable (unhealthy app, deadline, internal error).
  - Output contract in `outDir`: `report.json` (upstream `report-1`), `observations/*.json` (ledger), `downloads/`, `blocked-requests.json`, `executor.log`.

- [ ] **Step 1: Write the failing ledger and plan tests.**

```ts
it("allows one action window per case/action", async () => {
  const l = createFileCaseLedger(tmp, plan);
  await l.actionWindows.begin({ caseId: "c1", actionIndex: 0, actionDigest: d0 }, signal);
  await expect(l.actionWindows.begin({ caseId: "c1", actionIndex: 0, actionDigest: d0 }, signal)).rejects.toThrow("action window already used");
});
it("rejects evidence for a case not in the plan", async () => {
  await expect(l.evidence.recordCaseEvidence({ caseId: "nope", kind: "case-capture", bytes })).rejects.toThrow("unknown case");
});
it("never writes outside its root", async () => {
  await expect(l.evidence.recordCaseEvidence({ caseId: "c1", kind: "case-capture", name: "../x", bytes })).rejects.toThrow();
});
it("rejects a plan whose app origin is not http://app:4317", () => {
  expect(() => E2EExecutorPlanSchema.parse({ ...plan, app: { ...plan.app, origin: "http://example.com" } })).toThrow();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/e2e-executor-ledger.test.ts tests/unit/e2e-executor-plan.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `e2e-executor.ts`, `case-ledger.ts` and `local-browser.ts`, with names as in Interfaces.
- [ ] **Step 4: Implement `entry.ts` (calls `runE2EExecutor`) and `smoke.ts`.** `smoke.ts` launches Chromium, loads `data:text/html,<p data-testid=ok>ok</p>`, prints `chromium ok` and exits 0. `runE2EExecutor`:
  1. Parse the plan.
  2. Poll `app.origin + health.path` until `expectedStatus`, `timeoutMs` passes, or `deadlineAt` passes (exit 2 with `app-unhealthy`).
  3. Launch Chromium. Record every request to an origin other than `http://app:4317` as blocked in `blocked-requests.json`, using Playwright route interception.
  4. Run the e2e CLI with the web or API host from the compiled suite (workers 1, retries 0, reporter json).
  5. Close the browser and write outputs.
- [ ] **Step 5: Run the unit tests until they pass.**
- [ ] **Step 6: Write the Linux runtime test.** It is gated with `describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")`, and uses a helper that runs the fixture app and executor on an internal network.

```ts
it("web-csv-positive: real Chromium downloads the exact CSV", async () => {
  const r = await runProbe("web-csv-positive-v1", { defect: null });
  expect(r.exitCode).toBe(0);
  expect(caseStatuses(r.report)).toEqual({ "web-csv-positive-v1": "passed" });
  expect(csvRows(r.outDir)).toEqual([["id","customer","total","state"],["a1","Ada","12.50","ready"],["a2","Lin","7.00","ready"]]);
});
it("web-csv-negative: the extra-order defect fails the csv assertion", async () => {
  const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
  expect(r.exitCode).toBe(1);
  expect(failedAssertionKinds(r.report)).toEqual(["csv"]);
});
it("web-egress-denial: navigation off the app origin cannot pass", async () => {
  const r = await runProbe("web-egress-denial-v1", { defect: null });
  expect(caseStatuses(r.report)["web-egress-denial-v1"]).not.toBe("passed");
});
it("third-party assets are blocked and recorded, not fatal", async () => {
  const r = await runProbe("web-csv-positive-v1", { defect: null, appEnv: { FIXTURE_EXTERNAL_FONT: "https://fonts.example.com/a.css" } });
  expect(r.exitCode).toBe(0);
  expect(blockedHosts(r.outDir)).toContain("fonts.example.com");
});
it("api-state-positive passes and an unhealthy app is unavailable", async () => {
  expect((await runProbe("api-state-positive-v1", { defect: null })).exitCode).toBe(0);
  expect((await runProbe("api-state-positive-v1", { defect: null, appCommand: ["node", "-e", "process.exit(3)"] })).exitCode).toBe(2);
});
```

  Take the CSV rows from `tests/fixtures/e2e-web-api-app/fixtures/orders.json` and the probe files. If they differ from the literals above, the fixture is the source of truth: update the literals. Add `FIXTURE_EXTERNAL_FONT` support to the fixture's `public/index.html` as an optional `<link>`.
- [ ] **Step 7: Push and confirm the Linux runtime job passes.** Run CI `linux-runtime` (local macOS skips the test). Expected: all five tests PASS on `ubuntu-24.04-arm`.
- [ ] **Step 8: Commit** `feat(e2e): browser executor runtime with local Chromium and file case ledger`

### Task 1.4: Docker application host in the worker

**Files:**
- Create: `packages/verifier/src/host/docker-application-host.ts`
- Modify: `packages/worker/ec2/boot.sh` (IMDS drop rule, executor image pull), `packages/verifier/src/index.ts`
- Test: `tests/unit/e2e-docker-application-host.test.ts`, `tests/contract/ec2-boot-config.test.ts`, `tests/linux/e2e-docker-host.test.ts`

**Interfaces:**
- Consumes: `E2EExecutorPlan` and the `runE2EExecutor` outputs (Task 1.3); `E2EApplicationRuntimePorts` (Task 1.1).
- Produces:
  - `type DockerCli = { run(args: string[], opts: { signal: AbortSignal; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> }`
  - `createDockerApplicationHost(deps: { docker: DockerCli; executorImage: string; buildImage: string; runRoot: string; now(): number }): E2EApplicationRuntimePorts`
  - `sweepStaleRovaraRuns(docker: DockerCli, olderThanMs: number): Promise<number>`
  - Per allocate:
    1. Create network `rovara-e2e-<runId>` with `--internal`.
    2. Run the build container: `/src` read-only from `git archive` of the candidate commit, `/out` writable, default bridge, recipe build commands in order with each command's `timeoutMs`, `--memory 2g --pids-limit 1024`.
    3. Run the app container: alias `app`, `--read-only --tmpfs /tmp:rw,size=256m`, `/out` read-only as `/app`, `APP_PORT=4317`, `--memory 1g --pids-limit 512`.
    4. Run the executor container: `--shm-size 1g`, plan read-only, out writable.
    5. Wait for the executor until `deadlineAt`.

  Unavailable reasons: `build-failed`, `app-unhealthy`, `app-exited`, `deadline-exceeded` and `executor-failed`.

- [ ] **Step 1: Write failing unit tests with a recording fake `DockerCli`.**

```ts
it("never gives app or executor the docker socket, credentials or a published port", async () => {
  await runWithFake(host, plan);
  for (const args of [fake.argsFor("app"), fake.argsFor("executor")]) {
    expect(args).toEqual(expect.arrayContaining(["--network", `rovara-e2e-${plan.runId}`, "--cap-drop=ALL", "--security-opt", "no-new-privileges"]));
    expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|TOKEN|SECRET|(^| )-p /);
  }
  expect(fake.argsFor("app")).toContain("--read-only");
  expect(fake.call("network create")).toContain("--internal");
});
it("removes every labeled resource even when the build fails", async () => {
  fake.failOn("build", 1);
  const r = await runWithFake(host, plan);
  expect(r.unavailableReason).toBe("build-failed");
  expect(fake.liveResources(`rovara.run=${plan.runId}`)).toEqual([]);
});
it("kills the run at the deadline and never reports PASS", async () => {
  fake.hangOn("executor");
  const r = await runWithFake(host, { ...plan, deadlineAt: clock.now() + 1000 });
  expect(r.unavailableReason).toBe("deadline-exceeded");
  expect(r.actualRun).toBeNull();
});
it("isolates concurrent runs", async () => {
  await Promise.all([runWithFake(host, planA), runWithFake(host, planB)]);
  expect(fake.networks()).toEqual(expect.arrayContaining([`rovara-e2e-${planA.runId}`, `rovara-e2e-${planB.runId}`]));
  expect(fake.mountsFor("executor", planA.runId).some((m) => m.includes(planB.runId))).toBe(false);
});
it("sweeps stale runs older than one hour", async () => {
  fake.seedStale({ runId: "old", ageMs: 3_700_000 }); fake.seedStale({ runId: "fresh", ageMs: 60_000 });
  expect(await sweepStaleRovaraRuns(fake, 3_600_000)).toBe(1);
});
it("returns app-exited with the app log tail when the app crashes mid-run", async () => {
  fake.exitDuringExecutor("app", 137, "boom\n");
  const r = await runWithFake(host, plan);
  expect(r.unavailableReason).toBe("app-exited");
  expect(r.diagnostics.appLogTail).toContain("boom");
});
```

  The boot config test should assert `boot.sh` contains `iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP` and pulls `EXECUTOR_IMAGE`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/e2e-docker-application-host.test.ts tests/contract/ec2-boot-config.test.ts` and expect FAIL.
- [ ] **Step 3: Implement the host and `sweepStaleRovaraRuns`.** Reuse docker invocation and labeling conventions from `container-envelope.ts` (`isOwnedContainer`, the label scheme) instead of new ones. Call `sweepStaleRovaraRuns` at the start of each allocate.
- [ ] **Step 4: Update `boot.sh`.** Add the iptables rule after Docker starts (idempotent: check with `-C` before `-I`). Add `EXECUTOR_IMAGE` alongside `CONTAINED_IMAGE`, with the same retrying pull.
- [ ] **Step 5: Run the tests until they pass.**
- [ ] **Step 6: Write the Linux Docker host test** (`tests/linux/e2e-docker-host.test.ts`, same gate as Task 1.3).
  - Run the fixture app end to end through `createDockerApplicationHost` with a real `DockerCli`. The CSV positive passes.
  - A build command `["npm","run","does-not-exist"]` gives `build-failed`.
  - The build container running `node -e "fetch('http://169.254.169.254/latest/meta-data/').then(()=>process.exit(0),()=>process.exit(7))"` exits non-zero. CI must apply the same iptables rule first, as a step in the `linux-runtime` job.
- [ ] **Step 7: Push and confirm CI `linux-runtime` passes.**
- [ ] **Step 8: Commit** `feat(e2e): docker application host with per-run internal network`

### Task 1.5: Web/API runtime qualification profile

**Files:**
- Modify: `packages/verifier/src/install-qualification.ts`, `packages/verifier/src/install-qualification-cli.ts`, `packages/broker/src/aws/runtime-installation.ts` (`knownProfile` at line 42, the registration guard at line 161), `packages/broker/src/aws/e2e-feature-verifier-catalog.ts`
- Test: `tests/unit/install-qualification-web.test.ts`, `tests/contract/e2e-runtime-registration.test.ts`, `tests/e2e/runtime-installation-qualification.native.test.ts` (add a web case gated like Task 1.3)

**Interfaces:**
- Consumes: `createDockerApplicationHost` (Task 1.4); probe assets under `packages/verifier/assets/application-runtime-v1/probes/` (Task 1.1); the registered-runtime v2 schema `E2ERegisteredRuntimeSchema` and `admitE2ERegisteredRuntime` (Task 1.1, from `32bf8330`).
- Produces:
  - Profile ID `linux-arm64-web-api-v1`, scope `"application-web-api/v1"`.
  - `qualifyInstalledWebApiRuntime(input: { challenge: RuntimeInstallChallenge; evidenceRoot: string; host: E2EApplicationRuntimePorts }): Promise<RuntimeInstallProposal>`. The required outcomes are:
    - `web-csv-positive-v1` PASS
    - `web-csv-negative-v1` EXPECTED_FAILURE
    - `web-egress-denial-v1` EXPECTED_FAILURE
    - `api-state-positive-v1` PASS
    - `api-egress-denial-v1` EXPECTED_FAILURE
    - `build-imds-denial-v1` EXPECTED_FAILURE (new asset)
  - The registrar writes a v2 `E2E_FEATURE_VERIFIER` row with the capability descriptor `{ kind: "web" | "api", engine: { name: "e2e", version: "0.20.0" }, steps: ["navigate","fill","click","choose-file","request"], assertions: ["text","visible","csv","http-status","json"] }`.

- [ ] **Step 1: Write the failing tests.**
  - All six outcomes as listed give a proposal with `state: "READY"`.
  - A negative probe that passes is rejected with `"negative-probe-passed:web-csv-negative-v1"`.
  - Any probe that is skipped, flaky or retried is rejected.
  - Registration with profile `linux-arm64-web-api-v1` writes a v2 row that `admitE2ERegisteredRuntime` accepts.
  - The P0 profile `linux-arm64-docker-v1` registration is byte-for-byte unchanged (existing tests).
- [ ] **Step 2: Run** `npx vitest run tests/unit/install-qualification-web.test.ts tests/contract/e2e-runtime-registration.test.ts tests/contract/runtime-installation-packaging.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** Branch the CLI with `--profile`. Extend `knownProfile` and the line-161 guard so that each profile requires its own fixed Linux ARM64 supervisor facts. Add the `build-imds-denial-v1` probe asset (build command is the IMDS `fetch` from Task 1.4 Step 6; expected failure).
- [ ] **Step 4: Run tests until they pass, and confirm** `npm run test:contract` has no regressions.
- [ ] **Step 5: Commit** `feat(e2e): qualify and register linux web/api runtime profile`

### Task 1.6: Package, deploy and qualify in TEST, then ship PR B

**Files:**
- Modify: `scripts/release/build.ts` (build and push the executor image alongside the worker), `infra/lib/worker-settings.ts` (`ExecutorImageUri` parameter next to `WorkerImageUri` at line 23, passed to the boot config as `EXECUTOR_IMAGE`), `scripts/test-deploy.ts` (`executor-image` unit)
- Create: `docs/specs/rovara-e2e-runtimes/m1-live-acceptance.md`
- Test: `tests/contract/worker-image.test.ts`, `tests/contract/infrastructure.test.ts`, `tests/unit/test-deploy-plan.test.ts`

- [ ] **Step 1: Write failing tests.**
  - The release build emits two image digests, `worker` and `executor`.
  - The runtime stack exposes the `ExecutorImageUri` parameter and boot config passes `EXECUTOR_IMAGE`.
  - `planTestDeploy({only:["executor-image"]})` changes only `ExecutorImageUri`.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Open PR B** (Tasks 1.1–1.6) as a draft and wait for every CI job including `linux-runtime`. Get one review pass from a fresh reviewer, using the roadmap's blocker-only rule, and fix the blockers.
- [ ] **Step 4: Deploy the PR head to TEST:** `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --apply --only broker,dispatcher,worker-image,executor-image`. Expected: each stack is at `UPDATE_COMPLETE` and the Lambda `CodeSha256` values match.
- [ ] **Step 5: Qualify live**, following `docs/runtime-installation.md` with `--profile linux-arm64-web-api-v1`. The challenge, proposal and status files go under `e2e-runtime/<installationId>/` using the standing transport from Task 0.1. Expected: register succeeds, and the catalog row reads `READY` for `linux-arm64-web-api-v1`. Record the challenge ID, proposal sha256 and row in `status.md`.
- [ ] **Step 6: Merge PR B** after owner approval (human merge).

**M1.1 exit:** the TEST runner is qualified for `linux-arm64-web-api-v1`, with the positive, defect, egress and IMDS probes all as expected. This is recorded in `status.md`.

---

## M1.2: Workflow wiring (feature request to draft PR)

Tasks 2.1–2.4 each touch `broker.ts` or `developer-tasks.ts`, so run them sequentially. Task 2.5 may start once 2.3 lands.

### Task 2.1: Discovery proposes real web/API targets and a launch recipe

**Files:**
- Modify: `packages/contracts/src/e2e-catalog.ts` (`proposeE2ESetup` ~`:262`, the profile assignment at `:380-381`, `:460`), `packages/broker/src/aws/broker.ts` (`POST /v1/admin/projects/setup-proposals`, ~`:1133`)
- Test: `tests/unit/e2e-discovery.test.ts`

**Interfaces:**
- Consumes: `projectE2ERuntimeReadiness` (Task 1.1).
- Produces:
  - `proposeE2ESetup({ inspection, snapshot, expectedCandidate, readyProfiles: readonly { kind: "web" | "api"; profileId: string }[] })`. Web and API targets get the READY profile's ID when one exists; otherwise they keep `web-phase-unavailable` / `api-phase-unavailable`.
  - `inferNodeWebRecipe(snapshot: E2ESourceSnapshot): E2EAppRecipe | null`. It returns null unless the root `package.json` has `scripts.start` and a lockfile. The recipe is:
    - build `[["npm","ci"]]`, plus `["npm","run","build"]` when `scripts.build` exists;
    - start `["npm","start"]` with env `{ PORT: "4317" }`;
    - health `{ path: "/", expectedStatus: 200 }`.

  An explicit `package.json#agentx.e2e.recipe` (as in the fixture) wins over inference.

- [ ] **Step 1: Write failing tests.**
  - With `readyProfiles: [{kind:"web", profileId:"linux-arm64-web-api-v1"}]`, a web target gets that profile.
  - With an empty list, it gets `web-phase-unavailable`.
  - A repo with `scripts.start`, `scripts.build` and `package-lock.json` infers both build commands.
  - With no lockfile, the result is null.
  - The explicit fixture recipe is returned unchanged with its `recipeDigest`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/e2e-discovery.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** The broker route reads READY rows through `admitE2ERegisteredRuntime` for the installation's runtime catalog and passes them as `readyProfiles`.
- [ ] **Step 4: Run tests until they pass.**
- [ ] **Step 5: Commit** `feat(e2e): propose qualified web/api targets and node launch recipes`

### Task 2.2: Planner admits browser/API scenarios

**Files:**
- Modify: `packages/contracts/src/e2e-execution-plan.ts` (`selectE2EExecutionPlan` `:68`, unavailable criteria `:62-70`), `packages/broker/src/e2e/feature-plan-planning-context.ts` (`buildFeatureE2EPlanningContext` `:76`), and the application selection files from Task 1.1 (`e2e-application-execution-plan.ts`, `application-feature-plan-intent.ts`)
- Test: `tests/unit/e2e-execution-plan.test.ts`, `tests/unit/e2e-feature-plan-intent.test.ts`, `tests/unit/workflow-e2e-application-planning.test.ts`

**Interfaces:**
- Produces: for a target whose profile is READY `linux-arm64-web-api-v1`, these become executable application groups: steps `navigate|fill|click|choose-file` (web) and `request` (API), with assertions `text|visible|csv` (web) and `http-status|json` (API). `agent` steps stay in `unavailableCriteria` with reason `"agent-steps-arrive-in-m1.4"`. The planning context lists the available step and assertion kinds per target, so the planner model proposes them.

- [ ] **Step 1: Write failing tests.**
  - A web scenario `[navigate "/orders", click "export-csv"]` with a `csv` assertion on a READY target produces one application group and no unavailable criteria.
  - The same scenario on `web-phase-unavailable` stays unavailable.
  - An `agent` step stays unavailable with the M1.4 reason.
  - A portable-only plan selects exactly as before (snapshot-compare the existing P0 fixture).
  - The planning-context string for a READY web target contains `navigate, fill, click, choose-file` and `text, visible, csv`.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): admit browser and api scenarios for qualified targets`

### Task 2.3: Worker executes application rounds

**Files:**
- Modify: `packages/worker/src/workflow-e2e-checks.ts` (`executeWorkflowE2EChecks`), `packages/worker/src/run-task.ts` (~`:235`, where host deps are passed)
- Test: `tests/contract/workflow-e2e-application-checks.test.ts` (new; follow the style of `tests/contract/workflow-e2e-cancellation.test.ts`)

**Interfaces:**
- Consumes: `decodeE2EApplicationExecutionAdmission`, `runIsolatedE2EApplication` (Task 1.1); `createDockerApplicationHost` (Task 1.4).
- Produces:
  - The application admission schema (`packages/contracts/src/e2e-application-execution.ts`) gains required `candidateCommitSha: string` (40 hex) and `candidateTreeSha: string` (40 hex). Task 2.4 populates them.
  - When the admission's `schemaVersion` is the application admission version, `executeWorkflowE2EChecks` runs it through `runIsolatedE2EApplication` with the Docker host, building from `git -C <sourceRoot> archive <candidateCommitSha>`.
  - Before building, it requires `git -C <sourceRoot> rev-parse <candidateCommitSha>^{tree}` to equal the admission's `candidateTreeSha`.
  - Evidence goes up as `workflow-e2e-evidence/v1` with `payload.kind: "application"`.
  - The portable path is unchanged.

- [ ] **Step 1: Write failing tests.**
  - An application admission calls the host's allocate, execute and close once per group, at most 2 concurrently.
  - A tree mismatch throws `"candidate tree does not match admission"` before any docker call.
  - An abort signal mid-execute calls close and rejects with the cancellation.
  - `unavailableReason: "deadline-exceeded"` uploads evidence whose broker verdict input is UNKNOWN, not PASS.
  - Portable admissions never construct the Docker host.
- [ ] **Step 2: Run them and confirm FAIL. Implement, then run them again and confirm PASS.**
- [ ] **Step 3: Commit** `feat(e2e): execute application rounds through the docker host`

### Task 2.4: Broker dispatch, re-verification and gating for application rounds

**Files:**
- Modify: `packages/broker/src/aws/broker.ts` (`startWorkflowE2EChecksDispatch` `:9331`, `verifyWorkflowE2EEvidence` `:6663`), `packages/broker/src/aws/developer-tasks.ts` (only if publication context needs the application status; the guard keys on PASS)
- Test: `tests/contract/workflow-e2e-current-authority.test.ts`, `tests/contract/workflow-e2e-application-gating.test.ts` (new)

**Interfaces:**
- Consumes: the application collector and adapter (Task 1.1); the application admission encoder (Task 1.1).
- Produces:
  - Dispatch builds an application admission when the execution plan has application groups. It fills `candidateCommitSha` and `candidateTreeSha` (Task 2.3 schema) from the candidate export record that `handleWorkflowCandidateExport` stores (`broker.ts:5760`).
  - Verification recompiles, recollects with the application collector, qualifies with the application adapter, and applies the same `workflowE2ECurrentAuthorityIsValid` and complete-required-criteria checks.
  - The verdict is `PASS | FAILED | UNKNOWN`, exactly as in P0.

- [ ] **Step 1: Write failing tests.**
  - An application PASS records `qualifiedRound`, and `workflowE2EPublicationChecks` returns non-empty checks.
  - An application FAILED blocks the workflow with `failedRound`, and `workflowSendBackOffered` is true.
  - A required application scenario reported `skipped` gives UNKNOWN, and publication returns STALE.
  - Evidence for an older candidate is rejected.
  - Worker-claimed PASS with a tampered report digest gives UNKNOWN.
  - Existing portable cases are unchanged.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS.** Also run `npx vitest run tests/contract/workflow-e2e-*.test.ts` and expect PASS.
- [ ] **Step 3: Commit** `feat(e2e): dispatch and verify application rounds before publication`

### Task 2.5: Native web journey

**Files:**
- Create: `tests/e2e/m1-web-journey.test.ts`
- Modify: `tests/support/vitest-shared-config.ts` (add to the native file list), `.github/workflows/ci.yml` (`linux-runtime` also runs this file)

**Interfaces:**
- Consumes: the P0 native harness used by `tests/e2e/p0-native-journey.test.ts`.

- [ ] **Step 1: Write the journey test** (gated as in Task 1.3). Using the fixture app and the harness:
  1. Approve a plan with scenario `export-filtered-csv` (navigate `/orders`, click the date filter, click `export-csv`, csv assertion).
  2. Candidate 1 is the fixture with the `extra-order` defect: the round is FAILED and send-back is offered.
  3. Send back, then candidate 2 is the fixed fixture: the round is PASS.
  4. Review persists, and the publication checks are non-empty.
  5. Assert no `rovara.run`-labeled resources remain.
- [ ] **Step 2: Run it in CI `linux-runtime` and expect PASS.**
- [ ] **Step 3: Commit** `test(e2e): native browser journey from failing round to publication`

### Task 2.6: Live TEST demo, then ship PR C

- [ ] **Step 1: Write the M1.2 section of `docs/specs/rovara-e2e-runtimes/m1-live-acceptance.md`.** It covers:
  - preconditions: M1.1 exit, fixture project `rovara-web-fixture`;
  - the exact Slack request: "Add an Export CSV button to the orders page. Export only the selected date range and the current tenant's orders.";
  - the expected plan scenarios;
  - pass criteria: at least one browser scenario FAILED on a real candidate before a repair, then PASS on the repaired candidate; draft PR in `rovara-orders-web-fixture` with green CI; Rovara page shows the scenario results.
- [ ] **Step 2: Open PR C** (Tasks 2.1–2.5) and wait for green CI. Do one review pass and fix blockers. Deploy it with `scripts/test-deploy.ts --apply`.
- [ ] **Step 3: Run the live demo, record the evidence links in `status.md`, and merge after owner approval.**

**M1.2 exit:** the live CSV-export journey passes in TEST. This is the first shipped end-to-end browser verification.

---

## M1.3: Accounts, external-origin mocks and result UX

### Task 3.1: Synthetic accounts via recipe seed and form login

**Files:** `packages/contracts/src/e2e.ts` (recipe adds optional `seed: CommandRecipe` and `accountProfiles[].login: { kind: "form"; path; usernameTestId; passwordTestId; submitTestId }`), `packages/verifier/src/executor/entry.ts`, `packages/verifier/src/host/docker-application-host.ts`, `tests/fixtures/e2e-web-api-app/server.mjs`

**Interfaces:**
- Produces:
  - Per run, the host generates synthetic credentials: username `rovara-<profileId>-<6 random hex>`, password 24 random bytes base64url.
  - It passes them to the seed command (run in the app container before start) as `ROVARA_ACCOUNTS_JSON=[{profileId, username, password, tenantRef, roleRef}]`, and passes them to the executor plan.
  - The executor performs form login for the scenario's `accountProfileId` before its steps.
  - Credentials never appear in evidence (redacted to `<account:profileId>`).

- [ ] **Step 1: Write failing tests:**
  - unit: credentials are unique per run and redacted in every evidence file;
  - Linux: an `orders-viewer` scenario expecting the `export-csv` button not visible passes;
  - Linux: the `viewer-access` defect fails it.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS. Commit** `feat(e2e): per-run synthetic accounts with form login`

### Task 3.2: External-origin mocks

**Files:** `packages/verifier/src/executor/mock-server.ts` (new; the executor image's second mode, `node .../executor/entry.js --mock <fixtureFile>`), `docker-application-host.ts`, `packages/contracts/src/e2e.ts` (use the existing `mockFixtureRefs`)

**Interfaces:**
- Produces:
  - Each approved `originBindings[]` entry gets a mock container on the run network with alias `mock-<originRef>`, and the app receives `<envName>=http://mock-<originRef>:8080`.
  - A request that no approved fixture matches returns 599 and is recorded in `unmocked-calls.json`. Any unmocked call in a required scenario makes it UNKNOWN with reason `unmocked-external-call`.
  - The result lists `mockedOrigins` so the UI can say what was not tested for real.

- [ ] **Step 1: Write failing tests:**
  - Linux: the fixture's `inventory-v1` origin is mocked, so the scenario passes;
  - Linux: the `dependency-route` defect (calls `/internal/admin`) makes the scenario UNKNOWN with `unmocked-external-call`;
  - unit: mocked origins appear in the collected result.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS. Commit** `feat(e2e): approved external-origin mocks with unmocked-call detection`

### Task 3.3: Screenshots, trace and per-scenario results in page and Slack

**Files:** `packages/verifier/src/executor/entry.ts` (screenshot after the last step of every case, Playwright trace on failure, each capped at 5 MiB), `packages/broker/src/aws/broker.ts` (upload to private artifacts with existing `workflow-e2e-group-evidence` refs), the existing E2E notifier projection (`tests/contract/workflow-e2e-notifier-projection.test.ts` names the module)

**Interfaces:**
- Produces: per scenario, the display row is `{ scenarioId, status: "PASSED" | "FAILED" | "UNKNOWN", reason?: string, failedAssertion?: { kind; expected; actual }, screenshotRef?, traceRef?, mockedOrigins: string[] }`. Slack shows status counts and the first failed scenario's expected vs actual. The page shows all rows with links.

- [ ] **Step 1: Write failing tests.**
  - The projection renders `Filtered records — failed: expected 2 rows, received 3` for the extra-order defect.
  - Capture caps are enforced.
  - The projection never includes credentials.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS. Commit** `feat(e2e): scenario results with screenshots and traces`

### Task 3.4: Live demo, then ship PR D

- [ ] **Step 1: Add the M1.3 section to `m1-live-acceptance.md`.** The request: "Viewers must not be able to export, and exports include inventory status from the inventory service". Pass criteria: viewer-refusal and tenant scenarios pass, inventory is shown as mocked, and a failure screenshot is visible in the page on the failing round.
- [ ] **Step 2: Open the PR, get green CI and one review, deploy, run the live demo, record it in `status.md`, and merge after owner approval.**

---

## M1.4: AI navigation (`agent` steps)

### Task 4.1: Governed model bridge for `agent` steps

**Files:** port `packages/verifier/src/model-bridge.ts` from `c3b2ff95`. Modify `packages/verifier/src/web-runtime.ts` (replace the `case "agent"` throw at ~`:239` with a bridge call) and `packages/verifier/src/executor/entry.ts`. Add an executor-side model proxy that runs in the worker and is reachable only on the run network as `model-proxy:8080`. Update `e2e-execution-plan.ts` to remove the M1.4 unavailable rule when the policy's `modelRouteRevision` is non-null.

**Interfaces:**
- Consumes: the existing model-runtime route configuration used for coding tasks. Do **not** port the `e2e-model-*` governance stack. The policy's `modelRouteRevision` selects the route.
- Produces:
  - An `agent` step `{goal, maxActions}` runs through the bridge with a per-run budget of `maxActions` model calls and the run's absolute deadline.
  - Provider credentials stay in the worker proxy and never reach the executor or app containers.
  - Each model call records `{ model, inputTokens, outputTokens }` in evidence.
  - Assertions after the step are unchanged and deterministic.

- [ ] **Step 1: Write failing tests:**
  - unit: the bridge refuses after `maxActions` and the scenario becomes UNKNOWN with `agent-budget-exhausted`;
  - unit: executor container args contain no provider key;
  - Linux (with a scripted model double in CI): with the Export button's test ID renamed, the agent step clicks it and the csv assertion passes;
  - a double that claims success without clicking leaves the csv assertion FAILED.
- [ ] **Step 2: Run them and confirm FAIL. Implement. Run them again and confirm PASS. Commit** `feat(e2e): governed agent navigation with deterministic assertions`

### Task 4.2: Live demo, then ship PR E

- [ ] **Step 1: Add the M1.4 section to `m1-live-acceptance.md`** (a real model route in TEST, a renamed button, CSV assertions decide). Owner approves the model spend in the runbook.
- [ ] **Step 2: Open the PR, get green CI and one review, deploy, run the live demo, record it in `status.md`, and merge after owner approval.**

**M1 exit:** M1.0–M1.4 are merged and demonstrated live. Then write the M2 detailed plan, starting with the host spike (roadmap M2.0).
