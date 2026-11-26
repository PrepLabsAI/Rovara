// BROWSER-SKIP-HONESTY (DEC 540): a browser or application round that was skipped or refused because the install has no browser runner (no executor image) says so in plain words on every path, and is never
// "passed" or left out without a word. One describe per path: dispatch, the block reason the task keeps, round admission, the Testing view, the plan finding, the evidence pack's not-tested list, the local machine.
import { describe, expect, it } from "vitest";
import { browserRunnerMissingWords, WORKER_INVOCATION_FEATURES, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WorkflowSnapshotSchema, createWorkflowSnapshot, type JsonValue } from "@agentx/contracts";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { blockReasonOfFailedRun } from "../../packages/broker/src/core/build-step/results.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { browserEvidenceLinesWithSkip, localBrowserEvidenceDeps } from "../../packages/broker/src/local/app/browser-evidence-skip.js";
import { createHash } from "node:crypto";
import { planQualityFinding } from "@agentx/contracts";
import { readFileSync } from "node:fs";
import { WEB_API_RUNTIME_PROFILE_ID, createCandidateManifest, inspectE2ERepository, proposeE2ESetup, type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { NOW, binding, planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";

const NOT_RUN = "Browser checks not run: this install has no browser runner.";
const WORKER_NOT_RUN = "Browser checks not run: the worker for this task has no browser runner ready.";
const TOO_OLD = "this worker is too old to run this step; upgrade it";
/** What a worker lists while it withholds the browser checks (no executor image on its host): everything but the application-check family. */
const WITHHOLDING = WORKER_INVOCATION_FEATURES.filter((feature) => !["task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks"].includes(feature));
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });

async function readyTask(features: readonly string[]) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: [...features] } });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  const answered = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const current = (await readWorkspace(h.deps, task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 });
    h.clock.advance(70);
    const after = (await readWorkspace(h.deps, task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find((entry) => !answered.has(entry.operationId));
    if (job === undefined) continue;
    answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  return { h, task };
}

describe("dispatch: an application round handed to a worker that lists no browser checks", () => {
  it("ends the step with the plain words, never 'too old', and delivers nothing", async () => {
    const { h, task } = await readyTask(WITHHOLDING);
    const fresh = (await readTask(h.deps, task.taskId))!;
    const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
    const accepted = await acceptStep(h.deps, { task: fresh, workspace, requestId: newRequestId(), workflowMode: "CHECKS", prompt: "Run the admitted application scenarios on the committed source. Do not edit files.",
      payload: JSON.parse(JSON.stringify({ readiness: [cmd("npm", ["test"])] })) as Record<string, JsonValue>,
      requires: ["task.workflowMode", "task.workflowE2EAdmission", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.readiness"] });
    expect(accepted.result).toBe("STARTED");
    await h.flow.dispatchOnce({ maxMessages: 10 });
    const after = (await workspaceOperations(h.deps, task.workspaceId)).find((entry) => entry.id === accepted.operation!.id)!;
    expect(after.status).toBe("FAILED");
    expect(after.error).not.toBe(TOO_OLD);
    expect(after.error).toBe(WORKER_NOT_RUN);
  });

  it("still says 'too old' for a worker that lacks the application plan feature too", async () => {
    const { h, task } = await readyTask(WITHHOLDING.filter((feature) => feature !== "task.workflowE2EApplicationPlan"));
    const fresh = (await readTask(h.deps, task.taskId))!;
    const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
    const accepted = await acceptStep(h.deps, { task: fresh, workspace, requestId: newRequestId(), workflowMode: "CHECKS", prompt: "Run the checks. Do not edit files.",
      payload: JSON.parse(JSON.stringify({ readiness: [cmd("npm", ["test"])] })) as Record<string, JsonValue>,
      requires: ["task.workflowMode", "task.workflowE2EApplicationChecks", "task.readiness"] });
    await h.flow.dispatchOnce({ maxMessages: 10 });
    const after = (await workspaceOperations(h.deps, task.workspaceId)).find((entry) => entry.id === accepted.operation!.id)!;
    expect(after).toMatchObject({ status: "FAILED", error: TOO_OLD });
  });
});

describe("round admission: the live selection of an approved application round", () => {
  const evaluate = (over: Record<string, unknown>) => {
    const fx = planFixture({});
    return evaluateApplicationPlanApproval({ intent: fx.intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
      setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW,
      accounts: { entries: fx.registry, mode: "approve", pinned: [] }, ...over } as never);
  };
  it("says plainly that browser checks were not run when the project has no runtime row at all, and none expired", () => {
    const result = evaluate({ registeredRuntimes: [], expiredRuntimes: [] });
    expect(result).toMatchObject({ ok: false, scope: "runtime", reason: NOT_RUN });
  });
  it("keeps the generic reason when the caller did not look for expired rows", () => {
    const result = evaluate({ registeredRuntimes: [] });
    expect(result).toMatchObject({ ok: false, scope: "runtime" });
    expect(!result.ok && result.reason).toMatch(/runtime of profile .* is READY/);
  });
  it("keeps the expiry reason when a row expired, and the generic one when other kinds have rows (a filtered list is not 'no runner')", () => {
    const expired = evaluate({ registeredRuntimes: [], expiredRuntimes: [{ kind: "web", profileId: webApiRow("web").profileId, expiresAt: "2026-01-01T00:00:00.000Z" }] });
    expect(!expired.ok && expired.reason).toContain("runtime-expired");
    const filtered = evaluate({ registeredRuntimes: [], registeredRuntimeCount: 1, expiredRuntimes: [] });
    expect(!filtered.ok && filtered.reason).toMatch(/runtime of profile .* is READY/);
  });
});

describe("the task's block reason when the dispatch ended the checks for want of a browser runner", () => {
  const workflow = WorkflowSnapshotSchema.parse(createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-01T12:00:00.000Z" }));
  it("keeps the words (behind the runtime prefix, so the owner's actions stay as they were) instead of 'verification retry operation ended failed'", () => {
    const reason = blockReasonOfFailedRun("CHECKS", { status: "FAILED", error: WORKER_NOT_RUN }, workflow);
    expect(reason).toBe(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${WORKER_NOT_RUN}`);
    expect(reason.length).toBeLessThanOrEqual(500);
  });
  it("leaves every other failed run as it was", () => {
    expect(blockReasonOfFailedRun("CHECKS", { status: "FAILED", error: TOO_OLD }, workflow)).toBe("verification retry operation ended failed");
  });
});

describe("the task page and chat status of a block that says there is no browser runner", () => {
  const blockedOn = (reason: string) => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-01T12:00:00.000Z" }),
    stage: "VERIFY", state: "BLOCKED", blockReason: reason });
  it("leads with the words, and still names the way on", () => {
    const stage = taskPageStage(blockedOn(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${NOT_RUN}`), false, true);
    expect(stage.status).toBe("Browser checks not run: this install has no browser runner");
    expect(stage.nextStep).toContain("retry the checks, or close the task");
  });
  it("keeps the old words for another runtime block", () => {
    expect(taskPageStage(blockedOn(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}the web runtime expired`), false, true).status).toBe("The browser and API checks can't run on the runtime as it is now");
  });
});

describe("the chat card of a block that says there is no browser runner", () => {
  const blocked = (reason: string) => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-01T12:00:00.000Z" }),
    revision: 7, stage: "VERIFY", state: "BLOCKED", blockReason: reason });
  it("says the browser checks were not run, never the generic 'couldn't run the checks'", () => {
    const message = workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: blocked(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${NOT_RUN}`) })!;
    expect(message.text).toContain(NOT_RUN);
    expect(message.text).not.toMatch(/passed/i);
    expect(message.text).toBe(`The code is written, but I couldn't run the checks. ${NOT_RUN}`);
  });
  it("keeps the generic card for another runtime block", () => {
    const message = workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: blocked(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}the web runtime expired`) })!;
    expect(message.text).not.toContain("Browser checks not run");
  });
});

// workflow-messages.ts says "The checks passed" / "Checks and reviews passed" from the stored verification. A round the plan REQUIRED cannot have been skipped when those lines show: the schema refuses a REVIEW or later stage for a task whose
// required E2E has no qualified round on this code. (A plan with no browser scenario promised none, so those lines are true of it; a plan whose browser targets could not run is refused at approval, see the round admission tests.)
describe("'The checks passed' lines cannot show for a required browser round that did not run", () => {
  it("refuses a REVIEW stage whose required E2E has no qualified round", () => {
    const base = createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-01T12:00:00.000Z" });
    const parsed = WorkflowSnapshotSchema.safeParse({ ...base, stage: "REVIEW", state: "WAITING",
      e2e: { required: true, contractDigest: "c".repeat(64), policyDigest: "d".repeat(64), bundleDigest: "e".repeat(64), executionPlanDigest: "f".repeat(64), currentGroupRunIds: [], resultRefs: [] } });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.map((issue) => issue.message)).toContain("required E2E awaits trusted aggregate verification");
  });
});

describe("plan quality: the owner's sentence for a target that cannot run because there is no browser runner", () => {
  it("says the checks will not run, in the plain words, instead of 'wait for the runtime to be qualified'", () => {
    expect(planQualityFinding({ code: "e2e-target-unavailable", targetIds: ["web-1"], targetReason: "no-browser-runner" }).ownerSentence)
      .toBe("Browser checks will not run: this install has no browser runner. The checks planned for web-1 will not run.");
  });
});

describe("planning: a project whose qualified runtime has no READY row at all", () => {
  const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const candidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const manifest = JSON.parse(readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8")) as { name: string; agentx: { e2e: Record<string, unknown> } };
  const files = { "api/package.json": JSON.stringify({ ...manifest, name: "@acme/orders-api", dependencies: { express: "4.0.0" }, agentx: { e2e: { ...manifest.agentx.e2e, targetAccounts: [] } } }) };
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha, treeComplete: true, treePaths: Object.keys(files),
    sources: Object.entries(files).map(([path, text]) => { const bytes = Buffer.from(text); return { path, sha256: sha(bytes), bytes, kind: "blob" as const }; }) };
  const setup = proposeE2ESetup({ inspection: inspectE2ERepository(snapshot, candidate).inspection, snapshot, expectedCandidate: candidate, readyProfiles: [{ kind: "api", profileId: WEB_API_RUNTIME_PROFILE_ID }] });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: setup.targets, defaultSandboxProfileId: "default-sandbox",
    fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const caps = webApiRuntimeCapabilities("api", "a".repeat(64));
  const plan = (readyRuntimes: Array<{ kind: "api" | "web"; profileId: string; supportedSteps: readonly string[]; supportedAssertions: readonly string[] }>) =>
    buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: readyRuntimes as never, accountRegistry: registryFor(snapshot) });
  it("names the missing browser runner as the reason, not 'wait for the runtime to be qualified'", () => {
    const context = plan([]);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(new Set(context.unavailableReasons?.map((item) => item.reason))).toEqual(new Set(["no-browser-runner"]));
  });
  it("keeps 'runtime-not-ready' when the project has some other READY runtime", () => {
    const web = { kind: "web" as const, profileId: WEB_API_RUNTIME_PROFILE_ID, supportedSteps: caps.supportedSteps, supportedAssertions: caps.supportedAssertions };
    const context = plan([web]);
    if (context.status !== "available") throw new Error("unavailable");
    expect(new Set(context.unavailableReasons?.map((item) => item.reason))).toEqual(new Set(["runtime-not-ready"]));
  });
});

describe("browser evidence asked for by a project's recipe on a machine that cannot take the pictures", () => {
  const SAID = "Browser evidence not run: this install has no browser runner.";
  it("says it was not run when a recipe is configured and there is no way to run it (no executor image)", async () => {
    expect(await browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: true, canRun: undefined })).toEqual([SAID]);
  });
  it("says it too when the machine has the setting but cannot run it now, and when asking fails", async () => {
    expect(await browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: true, canRun: async () => false })).toEqual([SAID]);
    expect(await browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: true, canRun: async () => { throw new Error("docker is down"); } })).toEqual([SAID]);
  });
  it("says nothing without a recipe, nothing extra when the pictures were taken, and nothing when the machine can run it but the pack has no lines yet", async () => {
    expect(await browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: false, canRun: undefined })).toEqual([]);
    expect(await browserEvidenceLinesWithSkip({ existing: ["3 pages shown"], recipeConfigured: true, canRun: undefined })).toEqual(["3 pages shown"]);
    expect(await browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: true, canRun: async () => true })).toEqual([]);
  });
});

describe("browserRunnerMissingWords: only a lack of the browser checks, on a worker that knows them", () => {
  const listed = ["task.workflowE2EApplicationPlan", "task.workflowMode"];
  it("answers for the application check family", () => {
    expect(browserRunnerMissingWords(["task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2"], listed)).toBe(WORKER_NOT_RUN);
  });
  it("answers for nothing else: a lone extra feature, another feature beside the family, or a worker that lacks the application plan feature", () => {
    expect(browserRunnerMissingWords(["task.workflowE2EAgentSteps.v1"], listed)).toBeUndefined();
    expect(browserRunnerMissingWords(["task.workflowE2EApplicationChecks", "task.readiness"], listed)).toBeUndefined();
    expect(browserRunnerMissingWords(["task.workflowE2EApplicationChecks"], ["task.workflowMode"])).toBeUndefined();
  });
});

describe("the laptop's browser evidence seam", () => {
  const task = { project: "demo" } as never;
  const recipe = { start: "npm start" } as never;
  const page = { recipeFor: async () => recipe };
  const SAID = "Browser evidence not run: this install has no browser runner.";
  it("has no seam at all when nothing is configured and nothing can run", () => {
    expect(localBrowserEvidenceDeps({ page: undefined, canRun: undefined, fromConfig: undefined, linesOf: async () => [] })).toBeUndefined();
  });
  it("with a recipe in the owner's config and no way to run it: asks no worker for a recipe, and says it was not run", async () => {
    const seam = localBrowserEvidenceDeps({ page: undefined, canRun: undefined, fromConfig: () => recipe, linesOf: async () => [] })!;
    expect(await seam.recipe(task)).toBeUndefined();
    expect(await seam.linesOf(task, "d")).toEqual([SAID]);
  });
  it("with a way to run it: asks for the recipe only while the machine can run it, and says nothing extra when the pictures were taken", async () => {
    const can = localBrowserEvidenceDeps({ page, canRun: async () => true, fromConfig: () => recipe, linesOf: async () => ["2 pages shown"] })!;
    expect(await can.recipe(task)).toBe(recipe);
    expect(await can.linesOf(task, "d")).toEqual(["2 pages shown"]);
    const cannot = localBrowserEvidenceDeps({ page, canRun: async () => false, fromConfig: () => recipe, linesOf: async () => [] })!;
    expect(await cannot.recipe(task)).toBeUndefined();
    expect(await cannot.linesOf(task, "d")).toEqual([SAID]);
  });
  it("counts a recipe saved on the page as configured too", async () => {
    const seam = localBrowserEvidenceDeps({ page, canRun: async () => false, fromConfig: () => undefined, linesOf: async () => [] })!;
    expect(await seam.linesOf(task, "d")).toEqual([SAID]);
  });
});
