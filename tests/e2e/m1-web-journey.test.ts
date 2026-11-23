import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { E2EApplicationPlanIntentSchema, workflowSendBackOffered, type E2EScenario } from "@agentx/contracts";

import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";

import { call } from "../support/slack-broker.js";
import { MAYA } from "../support/developer-task-broker.js";

import { PROFILE } from "../support/e2e-application-plan-fixtures.js";
import { startCoreBrowserJourney, readJourneyTask, journeyPublicationChecks, journeyGit as git, publishJourneyDraft, assertJourneySharing, readJourneyResults } from "../support/core-browser-journey.js";

// The whole browser path of an application round, natively: Rovara plans and approves a real web scenario, the worker (the same code the EC2 worker runs) implements it
// into a real git commit, the broker admits a round for that commit, the worker runs it through the production Docker application host (the hardened containers: no
// published ports, no capabilities, internal network, the pinned seccomp profile) with real Chromium, the broker verifies what came back on its own, and a failing round is
// sent back before the passing one lets the task on to review and publication. Nothing here writes a verdict: the broker derives each one from collected evidence.
//
// It needs Docker and the executor image, so it runs where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE) and skips cleanly everywhere else.
// Locally, colima's Docker works too (DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock), with CONTAINED_FOUNDATION_EVIDENCE_DIR pointing at a fresh private
// directory under the home folder, because the run directories are shared with the Docker VM and the VM only sees the home folder.
const dockerReady = process.env.ROVARA_DOCKER === "1";
const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/e2e-web-api-app");

/** The two candidates the coder produces: the fixture app with its `extra-order` defect on, then the fixture app as it ships. */
async function stageCandidates(root: string) {
  const files = ["package.json", "server.mjs", "public", "fixtures", "defects"];
  const fixed = join(root, "candidate-fixed");
  const defective = join(root, "candidate-defective");
  for (const dir of [fixed, defective]) {
    await mkdir(dir, { recursive: true });
    for (const name of files) await cp(join(FIXTURE_ROOT, name), join(dir, name), { recursive: true });
  }
  // The fixture's own defect mechanism is a record from its fixed registry handed to `createOrdersApplication`; the app reads it from the owned mount when the test host
  // sets one. A candidate is source, so the defective one has the same registry record (the fixture's own `defects/extra-order.json`) as its default.
  const server = await readFile(join(defective, "server.mjs"), "utf8");
  const line = "const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE);";
  expect(server, "the fixture's defect hook moved; update the journey's defective candidate").toContain(line);
  await writeFile(join(defective, "server.mjs"), server.replace(line,
    'const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE) ?? JSON.parse(readFileSync(join(root, "defects/extra-order.json"), "utf8"));'));
  return { fixed, defective };
}

// Manual native proof is enabled; CI registration awaits a passing controller Linux run.
describe.runIf(dockerReady)("M1 native core web journeys", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); }, 120_000);
  async function journey(variant: "single-account" | "two-accounts" | "viewer-refused" | "unknown-retry-cancel") {
    const journey = await startCoreBrowserJourney({ fixtureRoot: FIXTURE_ROOT, planningFiles: ["package.json"], instructions: "Add an orders CSV export", plan: async (context) => {
    const targetOf = (profileId: string) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId);
    const target = targetOf("orders-owner");
    expect(target, JSON.stringify(context.targets)).toBeDefined();
    const viewerTarget = targetOf("orders-viewer");
    if ((variant === "two-accounts" || variant === "viewer-refused")) expect(viewerTarget, JSON.stringify(context.targets)).toBeDefined();
    const orders = (JSON.parse(await readFile(join(FIXTURE_ROOT, "fixtures/orders.json"), "utf8")) as { orders: Array<{ id: string; tenantId: string; customer: string; total: number; state: string }> }).orders;
    const scenario: E2EScenario = { scenarioId: "export-orders-csv", requirementId: "orders-export", requestedTargetIds: [target!.targetId], required: true, accountProfileId: target!.accountProfileId,
      minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "download-orders" }],
      assertions: [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"],
        rows: orders.filter((order) => order.tenantId === "tenant-a").map((order) => [order.id, order.customer, String(order.total), order.state]) }] };
    // The viewer of the same application: the page opens for it and shows the export button (what it may do with it is another scenario's matter).
    const viewerScenario: E2EScenario | undefined = viewerTarget === undefined ? undefined : { scenarioId: "viewer-sees-export", requirementId: "orders-export-visible", requestedTargetIds: [viewerTarget.targetId],
      required: true, accountProfileId: viewerTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      // "viewer-refused": the viewer presses the export button and the app answers HTTP 403 (it prints "Access refused (403)"): a forbidden action, asserted as refused.
      steps: variant === "viewer-refused" ? [{ kind: "navigate", path: "/" }, { kind: "click", testId: "download-orders" }] : [{ kind: "navigate", path: "/" }],
      assertions: variant === "viewer-refused" ? [{ kind: "text", testId: "orders-access-error", equals: "Access refused (403)" }] : [{ kind: "visible", testId: "download-orders", equals: true }] };
    const accountTargets = (variant === "two-accounts" || variant === "viewer-refused") ? [target!, viewerTarget!] : [target!];
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: accountTargets.map((item) => item.targetId), portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: accountTargets.flatMap((item) => context.accountContextRefs.filter((ref) => ref.applicationId === item.applicationId && ref.profileId === item.accountProfileId)),
      scenarios: (variant === "two-accounts" || variant === "viewer-refused") ? [scenario, viewerScenario!] : [scenario], semanticExportDeltas: [],
      applicationRuntimeRefs: accountTargets.flatMap((item) => context.runtimeRefs!.filter((ref) => ref.targetId === item.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
      runtimeAccountRefs: accountTargets.flatMap((item) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === item.applicationId && ref.profileId === item.accountProfileId)), unavailableTargetRefs: [] });
    // The plan is stored the way the planner writes it: what the schema makes optional and the planner has nothing to say about is left out, not written as empty lists.
    const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
    void _portable; void _mocks; void _unavailable;

    return { title: "Add an orders CSV export", claims: [{ id: "1", text: "The orders page exports the owner’s orders as CSV." }], plannerIntent };
    } }, roots);
    const { root, repository, harness, taskId, taskKey, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    const candidates = await stageCandidates(root);
    const webRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    if ((variant === "two-accounts" || variant === "viewer-refused")) {
      // The coder implements the export (the fixture app as it ships); the broker admits one round of two cases, one per account; the worker runs both in real Chromium on the
      // Docker host; the broker verifies the evidence itself, case by case, each against its own account.
      faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidates.fixed}/." repo/demo/` })]), fauxAssistantMessage("I added the orders CSV export.")]);
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
      const implemented = await runOperation("IMPLEMENT");
      expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
      expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY" }); expect(["WAITING", "RUNNING"], "the round is queued, or the core already started it").toContain(workflowNow().state);
      await completeReadiness();
      const checks = await runOperation("CHECKS");
      expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
      // A round that did not pass says why: the group evidence's own diagnostics (the executor's log tail) go with the failure.
      const diagnostics = (checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }> | undefined ?? []).map((ref) => (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { diagnostics: unknown } }).groupRun.diagnostics);
      expect(workflowNow(), JSON.stringify({ blockReason: workflowNow().blockReason, diagnostics })).toMatchObject({ stage: "REVIEW" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeDefined();
      const refs = checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>;
      const cases = refs.flatMap((ref) => (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: Array<{ scenarioId?: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> }> } } } })
        .groupRun.collection.result.cases);
      expect(cases, "one case per account of the one application").toHaveLength(2);
      for (const item of cases) expect(item.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "passed"]]);
      await nothingLeftBehind();
      return;
    }

    if (variant === "unknown-retry-cancel") {
      await writeFile(join(candidates.defective, "server.mjs"), "process.exit(1);\n");
      faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidates.defective}/." repo/demo/` })]), fauxAssistantMessage("The application is ready for its checks.")]);
      await writePreparationManifest(Number(harness.db.get(taskKey.pk, taskKey.sk)?.startingRevision ?? 1));
      await runOperation("IMPLEMENT");
      await completeReadiness();
      const unknown = await runOperation("CHECKS");
      expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect((await readJourneyTask(harness, taskId)).e2ePresentation?.shared.e2e.status).toBe("UNKNOWN");
      expect(workflowNow().e2e?.qualifiedRound).toBeUndefined();
      expect(workflowNow().e2e?.failedRound).toBeUndefined();
      const checksCount = () => operationRows((row) => row.workflowMode === "CHECKS").length;
      const beforeRetry = checksCount();
      harness.world.clock.advance(300);
      await harness.runtime.flow.sweepOnce();
      expect(checksCount(), "UNKNOWN never automatically restarts a browser round").toBe(beforeRetry);
      const sessionId = String(harness.db.get(taskKey.pk, taskKey.sk)?.sessionId);
      const retryId = randomUUID();
      const retry = () => harness.client("web", MAYA, "POST", `/v1/app/sessions/${sessionId}/retry`, { requestId: retryId });
      expect((await retry()).status).toBe(200);
      const accepted = checksCount();
      expect((await retry()).status).toBe(200);
      expect(checksCount(), "same explicit retry creates no duplicate checks").toBe(accepted);
      const runsBefore = new Set(journey.seenRuns);
      const pending = runOperation("CHECKS", unknown.invocation.operationId);
      let live: string[] = [];
      for (let attempt = 0; attempt < 600 && live.length === 0; attempt += 1) {
        live = [...journey.seenRuns].filter((id) => !runsBefore.has(id)).flatMap((id) => execFileSync("docker", ["ps", "--filter", `label=rovara.run=${id}`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean));
        if (live.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(live.length, "cancel observes a container owned by this live retry").toBeGreaterThan(0);
      expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() })).status).toBe(200);
      await harness.runtime.flow.relayOnce();
      await harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
      const cancelled = await pending;
      expect(cancelled.operation.status).toBe("CANCELLED");
      const beforeLate = JSON.stringify(workflowNow());
      const late = await call(harness.handler, { method: "POST", path: `/v1/internal/workspaces/${journey.workspaceId}/operations/${cancelled.invocation.operationId}/result`, headers: { "x-agentx-callback-capability": cancelled.invocation.callbackCapability }, body: { operationId: cancelled.invocation.operationId, status: "SUCCEEDED" } });
      expect([200, 403, 409]).toContain(late.status);
      expect(JSON.stringify(workflowNow())).toBe(beforeLate);
      expect(workflowNow().e2e?.qualifiedRound).toBeUndefined();
      await nothingLeftBehind();
      return;
    }

    // Step 2: the coder implements the export; candidate 1 is the fixture app with its extra-order defect.
    const implementation = (candidate: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]);
    faux.setResponses([implementation(candidates.defective), fauxAssistantMessage("I added the orders CSV export.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const first = await runOperation("IMPLEMENT");
    expect(first.operation.status, JSON.stringify(first.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY" }); expect(["WAITING", "RUNNING"], "the round is queued, or the core already started it").toContain(workflowNow().state);
    const firstCandidateDigest = workflowNow().candidate!.digest;
    const sourceOf = (candidateDigest: string) => harness.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT"
      && (item.candidateSourceRef as { candidateDigest?: string } | undefined)?.candidateDigest === candidateDigest)[0];
    expect(sourceOf(firstCandidateDigest), "the broker stored the first candidate's source export").toBeDefined();
    expect(git(repository, "show", "HEAD:server.mjs")).toContain("defects/extra-order.json");

    // Step 3: the broker admits one browser round for candidate 1; the worker runs it on the Docker host with real Chromium; the broker verifies the evidence itself.
    await completeReadiness();
    const checks1 = await runOperation("CHECKS");
    expect(checks1.operation.status, JSON.stringify({ operation: checks1.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow().blockReason, "round 1 must be FAILED by the broker (an assertion mismatch), not UNKNOWN").toBe("one or more admitted E2E groups failed");
    expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const e2e1 = workflowNow().e2e as { failedRound?: { status: string; candidateDigest: string; roundId: string }; qualifiedRound?: unknown };
    expect(e2e1.failedRound).toMatchObject({ status: "FAILED", candidateDigest: firstCandidateDigest });
    expect(e2e1.qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
    /** What the collector read off the stored group evidence for the one assertion of the one case; the verdict above is the broker's own, this shows what it stood on. */
    const assertionReceipts = (operation: Record<string, unknown>) => {
      const ref = (operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>)[0]!;
      const stored = JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: Array<{ assertionReceipts: Array<{ assertionIndex: number; status: string }> }> } } } };
      return stored.groupRun.collection.result.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status]);
    };
    expect(assertionReceipts(checks1.operation), "the one csv assertion is what failed").toEqual([[0, "failed"]]);
    const presentation = () => readJourneyTask(harness, taskId).then((task) => task.e2ePresentation);
    const publicationChecks = () => journeyPublicationChecks(harness, taskId);
    // The failed round is the broker's own finding from the collected evidence; the task shows FAILED and nothing is offered for publication.
    expect((await presentation())?.shared.e2e.status).toBe("FAILED");
    expect(await publicationChecks()).toBeUndefined();
    const failedRows = await readJourneyResults(harness, taskId);
    const screenshot = failedRows?.scenarios.find((row) => row.screenshotRef !== undefined)?.screenshotRef;
    expect(screenshot, "the failed browser assertion has a protected screenshot").toBeDefined();
    await assertJourneySharing(journey, screenshot!.sha256);

    // Step 4: send it back; the coder fixes the defect, and the broker admits a fresh round for candidate 2 (the fixture app as it ships).
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision,
      instructions: "The exported CSV holds an order that is not the owner's: a3. Export only the owner's tenant's orders." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "IMPLEMENT" });
    faux.setResponses([implementation(candidates.fixed), fauxAssistantMessage("I removed the extra order from the export.")]);
    const second = await runOperation("IMPLEMENT");
    expect(second.operation.status, JSON.stringify(second.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY" }); expect(["WAITING", "RUNNING"], "the round is queued, or the core already started it").toContain(workflowNow().state);
    const secondCandidateDigest = workflowNow().candidate!.digest;
    expect(secondCandidateDigest).not.toBe(firstCandidateDigest);
    expect(git(repository, "show", "HEAD:server.mjs")).not.toContain("defects/extra-order.json");

    // Step 5: the round for candidate 2 passes: the CSV is exactly the owner's orders.
    await completeReadiness();
    const checks2 = await runOperation("CHECKS", checks1.invocation.operationId);
    expect(checks2.operation.status, JSON.stringify({ operation: checks2.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e2 = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string; roundId: string; groupRunIds: string[]; evidenceSha256: string } };
    expect(e2e2.qualifiedRound).toMatchObject({ candidateDigest: secondCandidateDigest });
    expect(e2e2.qualifiedRound!.roundId).not.toBe((e2e1.failedRound as { roundId: string }).roundId);
    expect(e2e2.failedRound, "the failed round of the earlier candidate is no longer current").toBeUndefined();
    expect(assertionReceipts(checks2.operation)).toEqual([[0, "passed"]]);

    // Step 6: the verdict persists where the owner reads it, and publication is offered checks that name what they stand on.
    const reread = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    expect(reread.body).toMatchObject({ task: { workflow: { stage: "REVIEW" }, e2ePresentation: { shared: { e2e: { status: "PASS" } } } } });
    expect((await presentation())?.shared.e2e.status).toBe("PASS");
    const checks = await publicationChecks();
    expect(checks?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(checks)).toContain(webRowKey.sk);

    await publishJourneyDraft(journey);

    // Step 7: nothing of either round is left behind.
    await nothingLeftBehind();
  }

  it("runs the CSV export scenario through the real Docker host and real Chromium, sends the defective candidate back, and publishes the fixed one on its passing round", async () => {
    await journey("single-account");
  }, 1_800_000);

  it("runs two scenarios on two accounts of the same application (owner and viewer), as the planner wrote them, and passes the round on the fixed candidate", async () => {
    await journey("two-accounts");
  }, 1_800_000);

  it("runs a viewer scenario whose click is refused with HTTP 403 as a verdict, never as an unreadable report", async () => {
    await journey("viewer-refused");
  }, 1_800_000);
  it("browser-required UNKNOWN stays blocked; explicit retry is idempotent; live cancel and late callback cannot qualify", async () => {
    await journey("unknown-retry-cancel");
  }, 1_800_000);

});
