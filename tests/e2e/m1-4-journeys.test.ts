import { createHash } from "node:crypto";
import { chmodSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { E2EAgentActionLedgerSchema, WorkerInvocationSchema, e2eAgentValueKeyId, parseVerifiedE2EAgentActionLedger, type E2EModelDayBudgetRequest } from "@agentx/contracts";
import { encodeE2EApplicationExecutionAdmission, e2eApplicationGroupAgentSteps } from "../../packages/verifier/src/application-scenarios.js";
import { createProcessDockerCli, createDockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { agentCaseDirectoryName } from "../../packages/verifier/src/executor/evidence-paths.js";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { createScriptedE2EInvoke, type ScriptedTurn } from "../../packages/worker/src/e2e-model-scripted.js";
import { workflowE2EApplicationHostDeps, type WorkflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { ciImage } from "../support/ci-images.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { AGENT_GOAL, ORDERS_M14_APP_FILES, ORDERS_M14_ROOT, createOrdersM14AgentPlan, sha256Hex } from "../support/orders-m14-agent.js";

// M1.4 native journeys (Task 4.3b). Each is a whole path of an application round that has an `agent` step, through the worker's own check path (`executeWorkflowE2EChecks`): the admission
// is read and held to the signed invocation, the worker re-derives the route from its settings, opens the model channel for the group, the production Docker host runs the m14 orders app
// and the real executor image, and the scripted model answers. They need Docker and the executor image, so they run where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1,
// ROVARA_EXECUTOR_IMAGE) and skip cleanly everywhere else.
//
// What they assert is what the executor and the worker leave: the download, the action ledger and the worker's receipts. The verdict of the round (PASS, FAILED or UNKNOWN, and what the
// owner sees) is Task 4.4's: the broker refuses receipts until it reads them (Ruling DB-3), and the catalog still has no `agent` step, so no route here is one a customer's plan can reach.
const dockerReady = process.env.ROVARA_DOCKER === "1";
const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
const TASK_ID = "55555555-5555-4555-8555-555555555555";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.runIf(dockerReady)("M1.4 native journeys: AI navigation steps", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }, 120_000);

  /** One round with one group whose case has an agent step, run through the worker's checks on a real Docker host. */
  async function journey(script: readonly ScriptedTurn[]) {
    const fixture = createOrdersM14AgentPlan({ mock: true, taskId: TASK_ID });
    const admission = fixture.plan.admission;
    const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
    const admissionSha = sha(admissionBytes);
    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1, kind: "task", operationId: admission.operationId, workspaceId: "22222222-2222-4222-8222-222222222222", fence: admission.operationFence,
      projectRevision: 1, callbackCapability: "c".repeat(32),
      payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Run the approved E2E checks.", workflowMode: "CHECKS",
        readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }],
        workflowE2EAdmission: { schemaVersion: 1, kind: "application", taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
          roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId),
          admissionRef: { key: `workflow-e2e-admissions/sha256/${admissionSha}.json`, sha256: admissionSha, byteLength: admissionBytes.byteLength }, agentSteps: true } },
    });
    if (invocation.kind !== "task") throw new Error("fixture invocation must be a task");
    const base = realpathSync(await mkdtemp(join(tmpdir(), "m1-4-journey-")));
    dirs.push(base);
    // A short run root: the model socket path must fit a unix socket's 103 bytes (production's bounded in tests/unit/worker-e2e-application-runtime.test.ts).
    const runRoot = realpathSync(await mkdtemp("/tmp/rvj-"));
    dirs.push(runRoot);
    const evidenceRoot = join(base, "evidence");
    await mkdir(evidenceRoot, { mode: 0o700 });
    const repositoryRoot = join(base, "repo");
    await mkdir(repositoryRoot);
    // The worker stages exactly the build source the admission approves (the plan's snapshot holds the app's package.json and its mock files, as a plan builder writes them); the
    // git archive is the one thing not exercised here. The host is given the whole app instead of that staged copy (below), because the plan's snapshot is not a whole repository.
    const git: CandidateGit = { treeOf: async () => admission.candidateTreeSha,
      materializeInto: async (_root, _commit, destination) => {
        for (const source of admission.sourceSnapshot.sources) { const path = join(destination, source.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(source.bytesBase64, "base64")); }
        return [];
      } };
    const appCopy = join(base, "app");
    for (const file of ORDERS_M14_APP_FILES) await cp(join(ORDERS_M14_ROOT, file), join(appCopy, file), { recursive: true });
    const outputs: Array<{ actual: Record<string, unknown> | null }> = [];
    const hosts: Array<ReturnType<typeof createDockerApplicationHost>> = [];
    const config = { executorImage: EXECUTOR_IMAGE, buildImage: ciImage("node-build", WEB_API_BUILD_IMAGE), runRoot } satisfies WorkflowE2EApplicationRuntimeConfig;
    const application: WorkflowE2EApplicationRuntime = { runRoot, git,
      createHost: (input) => {
        const deps = workflowE2EApplicationHostDeps(config, createProcessDockerCli(), () => Date.now(), { ...input, candidateSourceDir: appCopy });
        const channel = deps.modelChannel;
        // The worker hands the socket to the executor's user (1000) only when it runs as root, as the EC2 worker does; a CI runner is not root, so the journey opens the socket file to
        // every local user for this run, as tests/support/linux-agent.ts does (the socket sits in a 0700 directory of the run that nothing else can enter).
        const host = createDockerApplicationHost({ ...deps, ...(channel === undefined ? {} : { modelChannel: { async open(open) {
          const session = await channel.open(open);
          chmodSync(open.socketPath, 0o666);
          return session;
        } } }) });
        hosts.push(host);
        return host;
      },
      // The collector's verdict is Task 4.4's; what the host handed it is what these journeys read.
      collect: ((input: { actual: Record<string, unknown> | null }) => { outputs.push({ actual: input.actual });
        return { collection: { marker: "journey" }, oracle: {}, unavailableReason: null, qualification: { status: "PASS", reason: "all cases passed", runId: null, rawReportSha256: null, result: null } }; }) as never };
    const sent: E2EModelDayBudgetRequest[] = [];
    const post = vi.fn(async (body: E2EModelDayBudgetRequest) => { sent.push(body); return { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: body.reservationId,
      status: body.stage === "reserve" ? "reserved" : body.stage === "settle" ? "settled" : "released" }; });
    const closed: Array<{ groupRunId: string; receipts: number; outcomes: Record<string, number>; valueKey: string }> = [];
    const saved: Array<{ bytes: Buffer; groupRunId: string | undefined }> = [];
    const result = await executeWorkflowE2EChecks({
      invocation, sourceRoot: "/workspace/runtime", evidenceRoot, candidateRepositoryRoot: () => repositoryRoot, application,
      readAdmission: async (offset: number) => ({ totalBytes: admissionBytes.byteLength, chunkBase64: admissionBytes.subarray(offset, offset + 64 * 1024).toString("base64"), sha256: admissionSha }),
      saveEvidence: async (bytes: Uint8Array, digest: string, _max: number, groupRunId?: string) => { saved.push({ bytes: Buffer.from(bytes), groupRunId });
        return { key: `workflow-e2e-${groupRunId === undefined ? "evidence" : "group-evidence"}/sha256/${digest}.json`, sha256: digest }; },
      modelBudget: post, modelChannel: { environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" }, policyScope: "standard", onClosed: (summary: (typeof closed)[number]) => closed.push(summary),
        invoke: createScriptedE2EInvoke({ scripts: { [sha256Hex(AGENT_GOAL)]: script } }) },
    } as never);
    const caseId = fixture.compiled.expectedCases[0]!.caseId;
    const agent = (outputs[0]?.actual as { executorEvidence?: { agent?: { ledgers: Array<{ caseDirectory: string; bytes: Uint8Array }>; dropped: number } } } | null | undefined)?.executorEvidence?.agent;
    const ledgerBytes = agent?.ledgers.find((item) => item.caseDirectory === agentCaseDirectoryName(caseId))?.bytes;
    const ledger = ledgerBytes === undefined ? null : E2EAgentActionLedgerSchema.parse(JSON.parse(Buffer.from(ledgerBytes).toString("utf8")));
    const runId = admission.groups[0]!.outerBinding.runId;
    // Everything a failing journey left to explain it: the worker's result and the host's logs.
    const why = (() => { const logs = hosts[0]?.readDiagnostics(runId);
      return `result: ${JSON.stringify(result).slice(0, 2000)}\nbuild log: ${logs?.buildLogTail || "(empty)"}\napp log: ${logs?.appLogTail || "(empty)"}\nexecutor log: ${logs?.executorLogTail || "(empty)"}`; })();
    return { fixture, result, closed, sent, caseId, ledger, agent, outputs, saved, runId, why, steps: e2eApplicationGroupAgentSteps(fixture.compiled) };
  }

  it("agent-renamed-export: the worker opens the channel, the goal finds 'Download orders', the executor captures one download and the ledger and receipts agree", async () => {
    const j = await journey([{ kind: "tap", name: /Download orders/ }, { kind: "done" }]);
    expect(j.result.processStatus, j.why).toBe("SUCCEEDED");
    expect(j.steps).toEqual([{ caseId: j.caseId, stepIndex: 1 }]);
    expect(j.ledger, "the host handed the executor's ledger back as operator evidence").not.toBeNull();
    const step = j.ledger!.steps[0]!;
    expect(step).toMatchObject({ stepIndex: 1, verdict: "concluded", stopCode: null });
    expect(step.actions.map((action) => [action.tool, action.outcome, action.node?.testId])).toEqual([["tap", "ok", "download-orders"]]);
    expect(j.agent!.dropped).toBe(0);
    // The worker's receipts: two calls, both ok; its day budget was charged and settled through the callback; and the key it kept is the one the ledger was written under.
    expect(j.closed).toHaveLength(1);
    expect(j.closed[0]).toMatchObject({ groupRunId: j.runId, receipts: 2, outcomes: { ok: 2 } });
    expect(step.receiptIds).toHaveLength(2);
    expect(j.ledger!.valueKeyId).toBe(e2eAgentValueKeyId(j.closed[0]!.valueKey));
    expect(parseVerifiedE2EAgentActionLedger(j.ledger, { goals: new Map([[1, AGENT_GOAL]]), valueKey: j.closed[0]!.valueKey, runId: j.runId, caseId: j.caseId }).ok).toBe(true);
    expect(j.sent.map((body) => body.stage)).toEqual(["reserve", "settle", "reserve", "settle"]);
  }, 500_000);

  it("agent-wrong-action: the model taps the decoy 'Download invoices'; the ledger says so and the executor completes the run with failures", async () => {
    const j = await journey([{ kind: "tap", name: /Download invoices/ }, { kind: "done" }]);
    expect(j.result.processStatus, j.why).toBe("FAILED");
    expect(j.ledger, j.why).not.toBeNull();
    const step = j.ledger!.steps[0]!;
    expect(step.verdict).toBe("concluded");
    expect(step.actions.map((action) => [action.tool, action.outcome, action.node?.testId])).toEqual([["tap", "ok", "download-invoices"]]);
    expect(j.closed[0]).toMatchObject({ receipts: 2, outcomes: { ok: 2 } });
  }, 500_000);

  it("agent-model-outage: the provider fails; the receipt is provider-error, the ledger verdict is failed with MODEL_PROVIDER_FAILED, and nothing was downloaded", async () => {
    const j = await journey([{ kind: "fail", message: "provider down" }]);
    expect(j.result.processStatus, j.why).toBe("FAILED");
    expect(j.ledger, j.why).not.toBeNull();
    const step = j.ledger!.steps[0]!;
    expect(step).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", actions: [] });
    expect(j.closed[0]).toMatchObject({ receipts: 1, outcomes: { "provider-error": 1 } });
    expect(step.receiptIds).toHaveLength(1);
  }, 500_000);
});

