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
  E2EApplicationPlanIntentSchema, E2EPolicySchema, WorkerInvocationSchema, createCandidateManifest, e2eApiSchemaComponentId, workspaceSessionKey,
  type E2EScenario, type E2ESourceSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { createDispatcherHandler, createWorkflowE2EReadinessCompleter, createWorkflowE2EReadinessValidator } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createDockerApplicationHost, createProcessDockerCli } from "@agentx/verifier";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { workflowE2EApplicationHostDeps, type WorkflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { call } from "../support/slack-broker.js";
import { collectOnThisHost } from "../support/linux-web-api-probes.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import type { binding as projectBinding} from "../support/e2e-application-plan-fixtures.js";
import { PROFILE, shaCanonical, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// M1.3 native journeys. Each case is a whole path of an application round on a real Docker host, gated like `m1-web-journey.test.ts`: it needs Docker and the executor image, so it runs
// where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE) and skips cleanly everywhere else. Locally, colima's Docker works too
// (DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock), with TMPDIR and CONTAINED_FOUNDATION_EVIDENCE_DIR under the home folder, because the run directories are shared with the VM.
const dockerReady = process.env.ROVARA_DOCKER === "1";
const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/e2e-web-api-app");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** The collector compares the toolchain the executor reported (a Linux Node) with the process reading the result; a Mac differs in platform as well as path, a CI runner only in path. */
const collectLikeTheWorker: typeof collectOnThisHost = (input) => {
  if (process.platform === "linux") return collectOnThisHost(input);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: input.actual.runnerToolchain.platform });
  try { return collectOnThisHost(input); } finally { Object.defineProperty(process, "platform", platform); }
};

/** The files of the fixture app a candidate carries: the app itself, and the inventory service's OpenAPI document and mock fixture that the project approves. */
const APP_FILES = ["package.json", "server.mjs", "public", "fixtures", "defects", "inventory", "e2e"];
async function stageCandidate(root: string, name: string, edit?: (server: string) => string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const file of APP_FILES) await cp(join(FIXTURE_ROOT, file), join(dir, file), { recursive: true });
  if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
  return dir;
}

describe.runIf(dockerReady)("M1.3 native journeys", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }, 120_000);

  /**
   * One planned scenario on the owner account of the fixture app, whose inventory service is an external origin: the plan approves the app's own OpenAPI document and mock fixture for
   * that service, the coder's candidate is the fixture app (optionally with a defect in the call it makes to the service), the broker admits one round, the worker runs it on the
   * production Docker host with the approved mock and the sinkhole, and the broker verifies what came back on its own.
   */
  async function inventoryJourney(variant: "mocked-origin" | "unmocked-call") {
    const base = await realpath(process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR ?? tmpdir());
    const root = await mkdtemp(join(await realpath(tmpdir()), "m1-3-journey-"));
    roots.push(root);
    const runBase = await mkdtemp(join(base, "m1-3-journey-runs-"));
    roots.push(runBase);
    const runRoot = join(runBase, "runs");
    await mkdir(runRoot, { mode: 0o700 });

    // The repository the project is about: one commit holding the app's project contract and the inventory service's OpenAPI document and mock fixture, which setup approval reads.
    const workerWorkspace = join(root, "worker-workspace");
    const repository = join(workerWorkspace, "repo", "demo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    const planningFiles = ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"];
    for (const file of planningFiles) { await mkdir(join(repository, file, ".."), { recursive: true }); await cp(join(FIXTURE_ROOT, file), join(repository, file)); }
    git(repository, "add", ...planningFiles);
    git(repository, "commit", "--quiet", "-m", "project contract and inventory contract");
    git(repository, "remote", "add", "origin", "https://github.com/example/demo.git");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
    const sources = await Promise.all(planningFiles.map(async (path) => { const text = await readFile(join(FIXTURE_ROOT, path), "utf8");
      return { path, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.from(text), kind: "blob" as const }; }));
    const snapshot: E2ESourceSnapshot = { candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: baseCommit, treeSha: baseTree }]), commitSha: baseCommit, treeSha: baseTree,
      treeComplete: true, treePaths: [...planningFiles].sort(), sources };
    const candidate = variant === "mocked-origin" ? await stageCandidate(root, "candidate")
      // The coder's call to the inventory service goes to a path that service's contract does not have (the fixture app's own dependency-route defect, as its default).
      : await stageCandidate(root, "candidate", (server) => server.replace('const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE);',
        'const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE) ?? JSON.parse(readFileSync(join(root, "defects/dependency-route.json"), "utf8"));'));
    if (variant === "unmocked-call") expect(await readFile(join(candidate, "server.mjs"), "utf8")).toContain("defects/dependency-route.json");

    // The broker, with the project registered and its setup approved on the qualified web profile (one admin proposal, approval and registration, as `agentx admin` makes them).
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: async () => snapshot }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const runtimeBinding = projectRow().runtimeBinding as typeof projectBinding;
    const webRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
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
      body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy }, runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const policy = E2EPolicySchema.parse(proposalResponse.body.policy);

    // Plan and approve one web scenario for the owner account: open the page, ask for the stock status of an order, and the page must show what the inventory service says.
    const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Show each order's stock status from the inventory service", client: "m1-3-journeys", workflow: true, workflowPath: "QUICK" });
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
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [readyWeb] });
    if (context.status !== "available") throw new Error(context.reason);
    const target = context.targets.find((item) => item.kind === "web" && item.accountProfileId === "orders-owner");
    expect(target, JSON.stringify(context.targets)).toBeDefined();
    // The planner is offered the inventory mock because the app's OpenAPI document and a source-backed fixture for it are in the repository.
    const mock = context.mockFixtures.find((item) => item.requestedTargetId === target!.targetId);
    expect(mock, JSON.stringify(context.mockFixtures)).toMatchObject({ componentId: e2eApiSchemaComponentId("inventory/openapi.json"), contractPath: "inventory/openapi.json", sourcePath: "e2e/mocks/inventory-v1.json" });
    const scenario: E2EScenario = { scenarioId: "show-stock-status", requirementId: "orders-stock-status", requestedTargetIds: [target!.targetId], required: true, accountProfileId: target!.accountProfileId,
      minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "check-inventory" }],
      assertions: [{ kind: "text", testId: "inventory-status", equals: "in-stock" }] };
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target!.targetId], portableOperationRefs: [],
      mockFixtureRefs: [{ componentId: mock!.componentId, requestedTargetId: mock!.requestedTargetId, operationId: mock!.operationId, sourcePath: mock!.sourcePath, sourceSha256: mock!.sourceSha256 }],
      accountContextRefs: context.accountContextRefs.filter((ref) => ref.applicationId === target!.applicationId && ref.profileId === target!.accountProfileId),
      scenarios: [scenario], semanticExportDeltas: [],
      applicationRuntimeRefs: context.runtimeRefs!.filter((ref) => ref.targetId === target!.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! })),
      runtimeAccountRefs: context.runtimeAccountRefs!.filter((ref) => ref.applicationId === target!.applicationId && ref.profileId === target!.accountProfileId), unavailableTargetRefs: [] });
    const { portableOperationRefs: _portable, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
    void _portable; void _unavailable;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Show each order's stock status", claims: [{ id: "1", text: "The orders page shows an order's stock status from the inventory service." }], e2e: plannerIntent as never })));
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
    const applicationRuntime: WorkflowE2EApplicationRuntime = { runRoot, collect: collectLikeTheWorker,
      createHost: (input) => createDockerApplicationHost(workflowE2EApplicationHostDeps({ executorImage: EXECUTOR_IMAGE, buildImage: WEB_API_BUILD_IMAGE, runRoot } satisfies WorkflowE2EApplicationRuntimeConfig,
        createProcessDockerCli(), () => Date.now(), input)) };
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
      applicationPlanNotNegotiated: async () => undefined,
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
    async function runOperation(workflowMode: "IMPLEMENT" | "CHECKS") {
      const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId
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
    /** Nothing of the round is left behind: no container (the mocks and the sinkhole included), network or volume still carries the run label, and the run directory is empty. */
    const nothingLeftBehind = async () => {
      const labelled = (kind: "ps" | "network" | "volume") => docker(...(kind === "ps" ? ["ps", "-a", "--filter", "label=rovara.run", "--format", "{{.Names}}"]
        : [kind, "ls", "--filter", "label=rovara.run", "--format", "{{.Name}}"]));
      expect({ containers: labelled("ps"), networks: labelled("network"), volumes: labelled("volume") }).toEqual({ containers: "", networks: "", volumes: "" });
      expect(await readdir(runRoot)).toEqual([]);
    };
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });

    // The coder implements the feature (the fixture app as it ships, or with its dependency-route defect); the broker admits one round; the worker runs it; the broker verifies the evidence itself.
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the stock status.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const implemented = await runOperation("IMPLEMENT");
    expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    await completeReadiness();
    const checks = await runOperation("CHECKS");
    expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    const refs = checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>;
    const stored = refs.map((ref) => JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { diagnostics: unknown; collection: { result: { status: string; reason: string; mockedOrigins?: string[]; cases: Array<{
      status: string; reason: string; mockedOrigins?: string[]; assertionReceipts: Array<{ assertionIndex: number; status: string }>; coverage: { observedMockedComponentIds: string[] } }> } } } });
    const brokerModule = await import("../../packages/broker/src/aws/broker.js");
    const presentation = () => brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, harness.db.get(taskKey.pk, taskKey.sk) as never, operationRows(() => true), "owner");

    if (variant === "mocked-origin") {
      // PASS: the page showed what the inventory mock answered, the mock is named on the case and on the round, and the broker's own verdict stands on the ledger of the mock itself.
      expect(workflowNow(), JSON.stringify({ blockReason: workflowNow().blockReason, diagnostics: stored.map((item) => item.groupRun.diagnostics) })).toMatchObject({ stage: "REVIEW" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeDefined();
      const result = stored[0]!.groupRun.collection.result;
      expect(result).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "passed"]]);
      const shared = (await presentation())?.shared.e2e;
      expect(shared?.status).toBe("PASS");
      expect(shared?.mockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
      expect(shared?.observedMockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
    } else {
      // UNKNOWN, never PASS and never FAILED: a call that no approved mock matched blocks publication, and names its reason; no round is recorded as failed or as qualified.
      const result = stored[0]!.groupRun.collection.result;
      expect(result.cases[0]).toMatchObject({ status: "unavailable", reason: "unmocked-external-call" });
      expect(workflowNow().blockReason, JSON.stringify(workflowNow())).not.toBe("one or more admitted E2E groups failed");
      expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: unknown }).qualifiedRound).toBeUndefined();
      expect((workflowNow().e2e as { failedRound?: unknown }).failedRound).toBeUndefined();
      expect(JSON.stringify(workflowNow())).toContain("unmocked-external-call");
      expect((await presentation())?.shared.e2e.status).toBe("UNKNOWN");
    }
    await nothingLeftBehind();
  }

  it("mocked-origin: the round is PASS with the inventory origin served by its approved mock, named on the result as mockedOrigins [inventory-v1]", async () => {
    await inventoryJourney("mocked-origin");
  }, 600_000);

  it("unmocked-call: a candidate that calls a path the inventory contract does not have gets UNKNOWN for unmocked-external-call, never PASS", async () => {
    await inventoryJourney("unmocked-call");
  }, 600_000);
});
