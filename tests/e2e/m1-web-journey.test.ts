import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  E2EApplicationPlanIntentSchema, E2EPolicySchema, WorkerInvocationSchema, createCandidateManifest, workflowSendBackOffered, workspaceSessionKey,
  type E2EScenario, type E2ESourceSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { accountRegistryEntriesFromRows } from "../../packages/broker/src/e2e/application-account-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { createDispatcherHandler, createWorkflowE2EReadinessCompleter, createWorkflowE2EReadinessValidator } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerCli } from "@agentx/verifier";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { workflowE2EApplicationHostDeps, type WorkflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { ciImage } from "../support/ci-images.js";
import { call } from "../support/slack-broker.js";
import { collectOnThisHost } from "../support/linux-web-api-probes.js";
import { createSingleAnswerPlanBroker, MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import type { binding as projectBinding} from "../support/e2e-application-plan-fixtures.js";
import { PROFILE, shaCanonical, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// The whole browser path of an application round, natively: Rovara plans and approves a real web scenario, the worker (the same code the EC2 worker runs) implements it
// into a real git commit, the broker admits a round for that commit, the worker runs it through the production Docker application host (the hardened containers: no
// published ports, no capabilities, internal network, the pinned seccomp profile) with real Chromium, the broker verifies what came back on its own, and a failing round is
// sent back before the passing one lets the task on to review and publication. Nothing here writes a verdict: the broker derives each one from collected evidence.
//
// It needs Docker and the executor image, so it runs where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE) and skips cleanly everywhere else.
// Locally, colima's Docker works too (DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock), with CONTAINED_FOUNDATION_EVIDENCE_DIR pointing at a fresh private
// directory under the home folder, because the run directories are shared with the Docker VM and the VM only sees the home folder.
const dockerReady = process.env.ROVARA_DOCKER === "1";
const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";

const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/e2e-web-api-app");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
/** The process Docker CLI, noting the run label of every command it is given. */
const observedDocker = (cli: DockerCli, seenRuns: Set<string>): DockerCli => ({ run: (args, opts) => {
  for (const value of args) if (value.startsWith("rovara.run=")) seenRuns.add(value.slice("rovara.run=".length));
  return cli.run(args, opts);
} });

/**
 * The worker's collector holds the toolchain the executor reported (a Linux Node in the executor image) against the process reading the result, which is the worker
 * itself on EC2 (same image, same path). On the CI runner only the path differs, and `collectOnThisHost` covers that. On a Mac the executor still runs on Linux, so the
 * platform differs too: only there, and only for the one synchronous `collect` call, the collector is lent the reported platform. Linux takes the plain path.
 */
const collectLikeTheWorker: typeof collectOnThisHost = (input) => {
  if (process.platform === "linux") return collectOnThisHost(input);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: input.actual.runnerToolchain.platform });
  try { return collectOnThisHost(input); } finally { Object.defineProperty(process, "platform", platform); }
};

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

describe.runIf(dockerReady)("M1 native web journey: a failing browser round, send-back, a passing round, publication", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }, 120_000);

  /**
   * One journey, in two shapes. "single-account": one scenario for the owner account, a defective candidate sent back, a fixed one published. "two-accounts": two scenarios
   * for the two accounts (owner and viewer) of the same one application, as a planner writes a multi-role test, on the fixed candidate. Either way the stored plan is the
   * planner's own (what its schema leaves optional is not written), never the parsed intent with empty lists written out.
   */
  async function journey(variant: "single-account" | "two-accounts" | "viewer-refused") {
    const evidenceBase = process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR;
    const base = await realpath(evidenceBase ?? tmpdir());
    const root = await mkdtemp(join(await realpath(tmpdir()), "m1-web-journey-"));
    roots.push(root);
    const runBase = await mkdtemp(join(base, "m1-web-journey-runs-"));
    roots.push(runBase);
    const runRoot = join(runBase, "runs");
    await mkdir(runRoot, { mode: 0o700 });

    // The repository the project is about: one commit holding only the app's project contract (package.json), which is what setup approval reads.
    const workerWorkspace = join(root, "worker-workspace");
    const repository = join(workerWorkspace, "repo", "demo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    await cp(join(FIXTURE_ROOT, "package.json"), join(repository, "package.json"));
    git(repository, "add", "package.json");
    git(repository, "commit", "--quiet", "-m", "project contract");
    git(repository, "remote", "add", "origin", "https://github.com/example/demo.git");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
    const manifestText = await readFile(join(FIXTURE_ROOT, "package.json"), "utf8");
    const snapshot: E2ESourceSnapshot = { candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: baseCommit, treeSha: baseTree }]), commitSha: baseCommit, treeSha: baseTree,
      treeComplete: true, treePaths: ["package.json"], sources: [{ path: "package.json", sha256: createHash("sha256").update(manifestText).digest("hex"), bytes: Buffer.from(manifestText), kind: "blob" }] };
    const candidates = await stageCandidates(root);

    // The broker, with the project registered and its setup approved on the qualified web profile (one admin proposal, approval and registration, as `agentx admin` makes them).
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { projectSetupSource: { capture: async () => snapshot }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const runtimeBinding = projectRow().runtimeBinding as typeof projectBinding;
    const webRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    // The qualified runtime row records the runner it was qualified on: here, the executor image on this Docker host, read from the image itself.
    const runner = JSON.parse(docker("run", "--rm", "--entrypoint", "node", EXECUTOR_IMAGE, "-p",
      "JSON.stringify({ os: process.platform + ' ' + require('os').release(), arch: process.arch, runtime: 'node ' + process.version, execPath: process.execPath, version: process.version, platform: process.platform })")) as
      { os: string; arch: string; runtime: string; execPath: string; version: "v22.23.2"; platform: string };
    const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: runner.os, arch: runner.arch, runtime: runner.runtime };
    const runnerToolchain = { execPath: runner.execPath, version: runner.version, platform: runner.platform, arch: runner.arch };
    harness.db.set({ ...webRowKey, ...webApiRow("web", { runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain) }),
      binding: runtimeBinding, bindingDigest: shaCanonical(runtimeBinding) });
    const admin = { subject: "admin-subject", admin: true };
    const proposalResponse = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposalResponse.status, JSON.stringify(proposalResponse.body)).toBe(200);
    const proposalRef = String(proposalResponse.body.proposalRef);
    const proposalSha256 = String(proposalResponse.body.proposalSha256);
    const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const definition = projectRow().definition as Record<string, unknown> & { revision: number };
    const registration = await call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      // The baseline round (M1.3 Task 3.7b) is on by default and runs right after the coding run, as the first CHECKS operation. This journey's base commit holds the project contract only
      // (the app arrives with the candidate), so a baseline here would run on a repository with no app and be this journey's "round 1". Its round accounting is explicit: no baseline.
      body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy,
        developerTasks: { ...((definition as { developerTasks?: object }).developerTasks ?? {}), e2eBaselineRound: false } }, runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const policy = E2EPolicySchema.parse(proposalResponse.body.policy);

    // Step 1: plan and approve one web scenario for the owner account: open the page, click the download button, and the CSV must hold exactly the owner's tenant's orders.
    const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add an orders CSV export", client: "m1-web-journey", workflow: true, workflowPath: "QUICK" });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const taskId = String((start.body.task as { taskId: string }).taskId);
    const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const workspaceId = String((harness.db.get(taskKey.pk, taskKey.sk) as { workspaceId: string }).workspaceId);
    const operationRows = (match: (row: Record<string, unknown>) => boolean) => harness.db.find((row) => row.pk === `WORKSPACE#${workspaceId}` && row.entityType === "OPERATION" && match(row));
    const preparation = operationRows((row) => row.kind === "prepare")[0]!;
    await harness.finish(workspaceId, String(preparation.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } });
    const planning = operationRows((row) => row.workflowMode === "PLAN")[0]!;
    const readyWeb = { kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
      supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions };
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [readyWeb],
      accountRegistry: accountRegistryEntriesFromRows("payments", harness.db.find((row) => row.pk === "PROJECT#payments")) });
    if (context.status !== "available") throw new Error(context.reason);
    const targetOf = (profileId: string) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId);
    const target = targetOf("orders-owner");
    expect(target, JSON.stringify(context.targets)).toBeDefined();
    const viewerTarget = targetOf("orders-viewer");
    if (variant !== "single-account") expect(viewerTarget, JSON.stringify(context.targets)).toBeDefined();
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
    const accountTargets = variant !== "single-account" ? [target!, viewerTarget!] : [target!];
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: accountTargets.map((item) => item.targetId), portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: accountTargets.flatMap((item) => context.accountContextRefs.filter((ref) => ref.applicationId === item.applicationId && ref.profileId === item.accountProfileId)),
      scenarios: variant !== "single-account" ? [scenario, viewerScenario!] : [scenario], semanticExportDeltas: [],
      applicationRuntimeRefs: accountTargets.flatMap((item) => context.runtimeRefs!.filter((ref) => ref.targetId === item.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
      runtimeAccountRefs: accountTargets.flatMap((item) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === item.applicationId && ref.profileId === item.accountProfileId)), unavailableTargetRefs: [] });
    // The plan is stored the way the planner writes it: what the schema makes optional and the planner has nothing to say about is left out, not written as empty lists.
    const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
    void _portable; void _mocks; void _unavailable;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Add an orders CSV export", claims: [{ id: "1", text: "The orders page exports the owner's orders as CSV." }], e2e: plannerIntent as never })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflowNow = () => (harness.db.get(taskKey.pk, taskKey.sk) as { workflow: { revision: number; stage: string; state: string; blockReason?: string; artifacts: Array<{ sha256: string }>;
      candidate?: { digest: string }; e2e?: Record<string, unknown> } }).workflow;
    const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, decision: "APPROVE",
      reason: "Approve the exact browser scenario", artifactDigest: workflowNow().artifacts.at(-1)!.sha256 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(workflowNow()).toMatchObject({ stage: "IMPLEMENT" });

    // The worker: the real task runner behind the real server, delivery and callbacks. Only the model transport is scripted (it is untrusted by design).
    const workerKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const journal = new OperationJournal(join(root, "worker-journal"));
    const evidenceRoot = join(root, "worker-evidence");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(join(workerWorkspace, ".agentx"), { recursive: true, mode: 0o700 });
    const workerFetch: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const response = await call(harness.handler, { method: init?.method ?? "GET", path: parsed.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(body === undefined ? {} : { body }) });
      if (response.status >= 400) throw new Error(`worker callback ${parsed.pathname} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const sinksFor = (invocation: WorkerInvocation) => createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: workerFetch });
    const { modelRuntime, faux } = await fauxModelRuntime();
    // The production Docker application runtime of the worker, on this machine's Docker: the hardened host, the executor image, and the same collector (it only
    // compares the node path the executor reports with this process's, which differ on a CI runner and a Mac, exactly as the Linux runtime tests handle it).
    /** The runs this journey started, by the labels its host put on their resources: another session's runs on the same Docker are none of this journey's business. */
    const seenRuns = new Set<string>();
    const applicationRuntime: WorkflowE2EApplicationRuntime = { runRoot, collect: collectLikeTheWorker,
      createHost: (input) => createDockerApplicationHost(workflowE2EApplicationHostDeps({ executorImage: EXECUTOR_IMAGE, buildImage: ciImage("node-build", WEB_API_BUILD_IMAGE), runRoot } satisfies WorkflowE2EApplicationRuntimeConfig,
        observedDocker(createProcessDockerCli(), seenRuns), () => Date.now(), input)) };
    const workerState = createWorkerServerState(journal, {
      execute: async (invocation) => {
        const sinks = sinksFor(invocation);
        return runTaskInvocation(invocation, { rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
          eventSink: sinks.eventSink, artifactSink: sinks.artifactSink, workflowE2EAdmissionReader: sinks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: sinks.workflowE2EEvidenceSink,
          workflowE2EEvidenceRoot: evidenceRoot, workflowE2ERuntimeRoot: process.cwd(), workflowE2EApplicationRuntime: applicationRuntime });
      },
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(sinksFor(invocation), result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId, generation: 1 });
    const guard = async (record: Parameters<typeof guardTaskDispatch>[1]) => {
      const admission = createTaskAuthorityAdmission({ now: Date.now, lambdaRemainingMs: 60_000 });
      try { return await guardTaskDispatch({ documentClient: harness.db, tableName: "state", admission }, record); } finally { admission.close(); }
    };
    const delivery = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding,
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => {
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), workerState);
        return { status: response.status, body: await response.text() };
      },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), workerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: guard, validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient: harness.db as never, tableName: "state" }), progress: async () => undefined,
    });
    const dispatcher = createDispatcherHandler({
      guardTaskDispatch: guard,
      markDispatching: async (record) => {
        try {
          await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } }));
          return true;
        } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
      },
      markDelivered: async (id) => { await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: delivery,
      completeWorkflowE2EReadiness: createWorkflowE2EReadinessCompleter({ documentClient: harness.db as never, tableName: "state" }),
    });
    const publisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :queued",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    /** The ordinary route a queued operation takes: publish its outbox row, dispatch it to the worker, and wait for the worker's terminal result. */
    async function runOperation(workflowMode: "IMPLEMENT" | "CHECKS", after?: string) {
      const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId && item.operationId !== after
        && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
        && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === workflowMode
        && item.status === "PENDING").at(-1);
      if (outbox === undefined) throw new Error(`no pending ${workflowMode} outbox: ${JSON.stringify(workflowNow())}`);
      const invocation = WorkerInvocationSchema.parse(outbox.invocation);
      expect((await publisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(outbox) } }] as never })).published).toBe(1);
      const queued = harness.db.get(String(outbox.pk), String(outbox.sk))!;
      const dispatched = await dispatcher({ Records: [{ messageId: String(outbox.id), body: JSON.stringify(queued) }] });
      expect(dispatched.batchItemFailures).toEqual([]);
      for (let index = 0; index < 6_000; index += 1) {
        const operation = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${invocation.operationId}`);
        if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED" || operation?.status === "CANCELLED") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const operation = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${invocation.operationId}`)!;
      return { invocation, operation };
    }
    async function writePreparationManifest(projectRevision: number) {
      await writeFile(join(workerWorkspace, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision,
        repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: baseCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
        completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${taskId}`, complete: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    }
    /** The candidate warm-up the broker waits for before it admits a round, completed as the compute service reports it. */
    async function completeReadiness() {
      await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
      const readiness = harness.db.find((item) => item.entityType === "OPERATION" && item.workflowE2EReadiness !== undefined && (item.workflowE2EReadiness as { taskId?: string }).taskId === taskId
        && (item.workflowE2EReadiness as { workflowRevision?: number }).workflowRevision === workflowNow().revision)[0];
      expect(readiness, JSON.stringify(workflowNow())).toBeDefined();
      const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === readiness!.id)[0]!;
      harness.db.set({ ...readiness!, status: "SUCCEEDED", updatedAt: new Date().toISOString(), workflowE2EReadiness: { ...(readiness!.workflowE2EReadiness as object), readyGeneration: 7 } });
      harness.db.set({ ...outbox, status: "DELIVERED" });
      const workspace = harness.db.get(`WORKSPACE#${workspaceId}`, "META")!;
      const { activeOperationId: _active, ...ready } = workspace;
      void _active;
      harness.db.set({ ...ready, status: "READY", updatedAt: new Date().toISOString() });
      harness.db.set({ ...workspaceSessionKey(workspaceId), entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 7, privateIp: "10.42.128.10", lastActivityAt: new Date().toISOString() });
      await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    }

    /** Nothing of any round is left behind: no container, network or volume still carries the label of a run this journey started, and the run directory is empty. */
    const nothingLeftBehind = async () => {
      expect(seenRuns.size, "the journey's host started at least one run").toBeGreaterThan(0);
      const labelled = (kind: "ps" | "network" | "volume") => [...seenRuns].map((runId) => docker(...(kind === "ps" ? ["ps", "-a", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Names}}"]
        : [kind, "ls", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Name}}"]))).filter((names) => names !== "").join("\n");
      expect({ containers: labelled("ps"), networks: labelled("network"), volumes: labelled("volume") }).toEqual({ containers: "", networks: "", volumes: "" });
      expect(await readdir(runRoot)).toEqual([]);
    };

    // The creator's sign-in record, as the broker reads it before it warms compute for a round.
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });

    if (variant !== "single-account") {
      // The coder implements the export (the fixture app as it ships); the broker admits one round of two cases, one per account; the worker runs both in real Chromium on the
      // Docker host; the broker verifies the evidence itself, case by case, each against its own account.
      faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidates.fixed}/." repo/demo/` })]), fauxAssistantMessage("I added the orders CSV export.")]);
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
      const implemented = await runOperation("IMPLEMENT");
      expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
      expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
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

    // Step 2: the coder implements the export; candidate 1 is the fixture app with its extra-order defect.
    const implementation = (candidate: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]);
    faux.setResponses([implementation(candidates.defective), fauxAssistantMessage("I added the orders CSV export.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const first = await runOperation("IMPLEMENT");
    expect(first.operation.status, JSON.stringify(first.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
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
    const brokerModule = await import("../../packages/broker/src/aws/broker.js");
    const operations = () => operationRows(() => true);
    const presentation = () => brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, harness.db.get(taskKey.pk, taskKey.sk) as never, operations(), "owner");
    const publicationChecks = () => brokerModule.loadWorkflowE2EPublicationChecks(harness.brokerInput as never, harness.db.get(taskKey.pk, taskKey.sk) as never, operations());
    // The failed round is the broker's own finding from the collected evidence; the task shows FAILED and nothing is offered for publication.
    expect((await presentation())?.shared.e2e.status).toBe("FAILED");
    expect(await publicationChecks()).toBeUndefined();

    // Step 4: send it back; the coder fixes the defect, and the broker admits a fresh round for candidate 2 (the fixture app as it ships).
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision,
      instructions: "The exported CSV holds an order that is not the owner's: a3. Export only the owner's tenant's orders." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "IMPLEMENT" });
    faux.setResponses([implementation(candidates.fixed), fauxAssistantMessage("I removed the extra order from the export.")]);
    const second = await runOperation("IMPLEMENT");
    expect(second.operation.status, JSON.stringify(second.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
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
});
