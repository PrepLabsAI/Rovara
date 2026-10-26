import { vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  E2EApplicationPlanIntentSchema, E2EPolicySchema, WorkflowSnapshotSchema, workflowRequestId, workspaceSessionKey,
  type E2EApplicationExecutionAdmission, type E2EScenario, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, E2EWorkflowAdmissionRefSchema,
} from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { accountRegistryEntriesFromRows } from "../../packages/broker/src/e2e/application-account-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { createSingleAnswerPlanBroker, MAYA, type Developer } from "./developer-task-broker.js";
import { createRealCandidate } from "./e2e-application-candidate.js";
import { call, type Handler } from "./slack-broker.js";
import { planAnswer, planDocument } from "./plan-documents.js";
import type { binding} from "./e2e-application-plan-fixtures.js";
import { PROFILE, ordersContractManifest, shaCanonical, snapshotOf, webApiRow } from "./e2e-application-plan-fixtures.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";
import { collectApplicationGroupEvidence, type ApplicationGroupEvidence, type ObservedApiOutcome } from "./e2e-application-evidence-fixture.js";

/**
 * A whole application round on the real broker, short of the worker: a project whose repository holds several API applications that carry the orders project
 * contract, approved on the qualified profile; a v2 plan over all of them; the real dispatch of that plan on a real committed candidate (so the admission is the one the
 * broker builds); and the callbacks the worker makes (group evidence, the aggregate, the result), with genuinely collected evidence. API applications, because API
 * evidence can be collected for real without a browser; the broker's verification does not depend on the kind. A group holds at most three targets, so four
 * applications give two groups of the same kind (three targets and one).
 */
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const CHUNK_BYTES = 64 * 1024;
export const APPLICATION_NAMES = ["a", "b", "c", "d", "e"] as const;

/** One health-check scenario per target; the observed outcome decides whether it holds. */
export const healthScenario = (targetId: string, accountProfileId: string, index: number): E2EScenario => ({ scenarioId: `orders-health-${index}`, requirementId: `orders-api-${index}`,
  requestedTargetIds: [targetId], required: true, accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
  steps: [{ kind: "request", requestId: "health", path: "/health", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/health", method: "GET", equals: 200 }] });

/**
 * `accounts` makes each application's API target available on those account profiles of the project contract (one target per account, as a web target is for the
 * orders fixture), so one application carries several accounts. The first application's base target is `api-1`.
 */
export function apiApplicationsSnapshot(count: number, accounts: readonly string[] = []): { snapshot: E2ESourceSnapshot; tree: Record<string, string> } {
  const manifest = JSON.parse(ordersContractManifest) as { name: string; agentx: { e2e: Record<string, unknown> } };
  const tree: Record<string, string> = {};
  for (const [index, name] of APPLICATION_NAMES.slice(0, count).entries()) {
    tree[`api-${name}/package.json`] = JSON.stringify({ ...manifest, name: `@acme/${name}`, dependencies: { express: "4.0.0" },
      agentx: { e2e: { ...manifest.agentx.e2e, targetAccounts: accounts.map((profileId) => ({ baseTargetId: `api-${index + 1}`, profileId })) } } });
  }
  return { snapshot: snapshotOf(tree), tree };
}

/** The parts of the broker harness a round's tests use, named here so this module's declared types do not depend on the harness's own (unexported) ones. */
export interface RoundBrokerHarness {
  db: { get(pk: string, sk: string): Record<string, unknown> | undefined; set(item: Record<string, unknown>): void; delete(pk: string, sk: string): void;
    find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>>; send: (command: { constructor: { name: string }; input?: unknown }) => Promise<unknown> };
  s3: { objects: Map<string, string>; send: (command: { constructor: { name: string }; input?: { Key?: string } }) => Promise<unknown> };
  brokerInput: unknown;
  actions: unknown;
  handler: Handler;
  finish(workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED", detail?: { result?: unknown; error?: string }): Promise<Record<string, unknown>>;
  dev(who: Developer, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

export type RoundOptions = {
  /** How many API applications the repository holds, one target each (1 to 5). */
  applications?: number;
  /** Seeds the CHECKS dispatch with the compute warm-up already done (the default). */
  seedReadiness?: boolean;
  /**
   * How the approved plan stores its intent. "planner" (the default) is the plan as the real planner writes it: the members the schema makes optional and the planner
   * leaves out (`portableOperationRefs`, `mockFixtureRefs`, `unavailableTargetRefs`) are absent. "normalized" stores the parsed intent with those members written out as empty
   * lists, which no planner does and which hides every comparison of a stored intent with a derived one.
   */
  storedIntent?: "planner" | "normalized";
  /** Account profiles of the one application's project contract, each with its own target and scenario (needs `applications` of 1). Without it, the application has one account. */
  accounts?: readonly string[];
  /** Spread into the broker's dependencies last. */
  brokerExtra?: Record<string, unknown>;
  /**
   * The baseline round (Task 3.7b, owner decision D2). Absent or "off": the project switched it off (so the rounds of the other tests are what they were). "source": it is on
   * and the coding run exported the unchanged code (a real base commit under the candidate). "missing": on, but the worker exported nothing. "refused": on, and the export is a refusal.
   */
  baseline?: "off" | "source" | "missing" | "refused";
  /** With the baseline's source exported: "other" pins a base commit that is not the exported one. */
  baselinePin?: "other";
  /** What GitHub says the tree of the pinned base commit is (the broker holds the exported tree to it): the exported one, another, or nothing (GitHub cannot be asked). Absent: GitHub is not consulted. */
  githubBaseTree?: "match" | "mismatch" | "unreachable";
  /** Edits the files of the committed candidate before it is exported (the coding round changed the code): for a candidate whose source no longer gives the approved plan what it needs. */
  candidateTree?: (files: Record<string, string>) => Record<string, string>;
  /** Runs once the candidate is committed and exported, just before the first dispatch (to seed a row the dispatch reads, say). */
  beforeDispatch?: (harness: RoundBrokerHarness) => void;
};

const READY_API = { kind: "api" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("api", "a".repeat(64)).supportedSteps,
  supportedAssertions: webApiRuntimeCapabilities("api", "a".repeat(64)).supportedAssertions };
export const apiRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "api");

/** Registers the project against its approved setup and writes the plan a planner would write, up to (not including) the owner's APPROVE. */
async function prepareRound(options: RoundOptions = {}) {
  const applications = options.applications ?? 1;
  const accounts = options.accounts ?? [];
  if (accounts.length > 0 && applications !== 1) throw new Error("accounts need exactly one application");
  const { snapshot, tree } = apiApplicationsSnapshot(applications, accounts);
  const capture = async () => snapshot;
  const github = { baseTree: undefined as string | undefined };
  const githubGateway = options.githubBaseTree === undefined ? {} : { githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(),
    getCommitTree: async (): Promise<string> => {
      if (options.githubBaseTree === "unreachable") throw new Error("GitHub is down");
      return options.githubBaseTree === "mismatch" ? "e".repeat(40) : github.baseTree ?? "0".repeat(40);
    } } };
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { projectSetupSource: { capture }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog", ...githubGateway, ...options.brokerExtra } });
  const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
  const projectBinding = projectRow().runtimeBinding as typeof binding;
  harness.db.set({ ...apiRowKey, ...webApiRow("api"), binding: projectBinding, bindingDigest: shaCanonical(projectBinding) });
  const admin = { subject: "admin-subject", admin: true };
  const proposalResponse = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
  if (proposalResponse.status !== 200) throw new Error(`setup proposal failed: ${JSON.stringify(proposalResponse.body)}`);
  const proposalRef = String(proposalResponse.body.proposalRef);
  const proposalSha256 = String(proposalResponse.body.proposalSha256);
  const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
  if (approval.status !== 200) throw new Error(`setup approval failed: ${JSON.stringify(approval.body)}`);
  const definition = projectRow().definition as Record<string, unknown> & { revision: number };
  const baselineOff = options.baseline === undefined || options.baseline === "off";
  const registration = await call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
    body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy,
      ...(baselineOff ? { developerTasks: { ...((definition as { developerTasks?: object }).developerTasks ?? {}), e2eBaselineRound: false } } : {}) }, runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
  if (registration.status !== 201) throw new Error(`project registration failed: ${JSON.stringify(registration.body)}`);
  const policy = E2EPolicySchema.parse(proposalResponse.body.policy);

  const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Check the orders services", client: "round-test", workflow: true, workflowPath: "QUICK" });
  if (start.status !== 200) throw new Error(`task start failed: ${JSON.stringify(start.body)}`);
  const taskId = String((start.body.task as { taskId: string }).taskId);
  const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" };
  const workspaceId = String((harness.db.get(taskKey.pk, taskKey.sk) as { workspaceId: string }).workspaceId);
  const operationRows = (match: (row: Record<string, unknown>) => boolean) => harness.db.find((row) => row.pk === `WORKSPACE#${workspaceId}` && row.entityType === "OPERATION" && match(row));
  const preparation = operationRows((row) => row.kind === "prepare")[0]!;
  await harness.finish(workspaceId, String(preparation.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: snapshot.commitSha }] } });
  const planning = operationRows((row) => row.workflowMode === "PLAN")[0]!;

  // The accounts the setup approval registered, as the broker shows them to the planner.
  const accountRegistry = accountRegistryEntriesFromRows("payments", harness.db.find((row) => row.pk === "PROJECT#payments"));
  const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [READY_API], accountRegistry });
  if (context.status !== "available") throw new Error(context.reason);
  // (Every qualified web and API target also offers the signed-out visitor as a variant of its own; these rounds run the apps' own accounts.)
  const targets = context.targets.filter((item) => item.kind === "api" && item.accountProfileId !== "rovara-anonymous" && (accounts.length === 0 || accounts.includes(item.accountProfileId)))
    .sort((left, right) => left.accountProfileId.localeCompare(right.accountProfileId) || left.targetId.localeCompare(right.targetId));
  const expectedTargets = accounts.length > 0 ? accounts.length : applications;
  if (targets.length !== expectedTargets) throw new Error(`expected ${expectedTargets} api targets, found ${targets.length}: ${JSON.stringify(context.targets.map((item) => [item.targetId, item.accountProfileId]))}`);
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item.targetId), portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: targets.flatMap((target) => context.accountContextRefs.filter((ref) => ref.applicationId === target.applicationId && ref.profileId === target.accountProfileId)),
    scenarios: targets.map((target, index) => healthScenario(target.targetId, target.accountProfileId, index)), semanticExportDeltas: [],
    applicationRuntimeRefs: targets.flatMap((target) => context.runtimeRefs!.filter((ref) => ref.targetId === target.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
    runtimeAccountRefs: targets.flatMap((target) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === target.applicationId && ref.profileId === target.accountProfileId)),
    unavailableTargetRefs: [] });
  // The planner leaves out what the schema makes optional and it has nothing to say about; the stored plan keeps it out too (see `RoundOptions.storedIntent`).
  const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
  void _portable; void _mocks; void _unavailable;
  const storedIntent = options.storedIntent === "normalized" ? intent : plannerIntent;
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: "Check the orders services", claims: [{ id: "1", text: "The orders services answer their health checks." }], e2e: storedIntent as never })));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });

  const workflowNow = () => (harness.db.get(taskKey.pk, taskKey.sk) as { workflow: { revision: number; stage: string; state: string; blockReason?: string; artifacts: Array<{ sha256: string }>;
    candidate?: { digest: string }; e2e?: Record<string, unknown> } }).workflow;
  /** The owner's APPROVE of the written plan; a test that wants to change something before it (a registry row, say) calls it itself. */
  const approve = () => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, decision: "APPROVE",
    reason: "Approve the exact application intent", artifactDigest: workflowNow().artifacts.at(-1)!.sha256 });
  return { harness, snapshot, tree, taskId, taskKey, workspaceId, operationRows, workflowNow, approve, policy, intent, targets, projectBinding, github };
}

/**
 * A round planned and waiting for the owner's APPROVE: for a test that changes something first (a registry row, say) and then approves (`approve`) or expects it refused.
 */
export async function prepareApplicationRound(options: RoundOptions = {}) {
  const prepared = await prepareRound(options);
  return { harness: prepared.harness as unknown as RoundBrokerHarness, taskId: prepared.taskId, workflowNow: prepared.workflowNow, approve: prepared.approve };
}

/**
 * Plans, approves and dispatches one application round, and returns the handles a test needs. The CHECKS operation it starts is the real one: its admission, round and
 * group run ids are the broker's own; `markRunning` is the only thing the missing worker would have done to it before it uploads.
 */
export async function startApplicationRound(options: RoundOptions = {}) {
  const prepared = await prepareRound(options);
  const { harness, snapshot, tree, taskId, taskKey, workspaceId, operationRows, workflowNow, policy, intent, targets, projectBinding, github } = prepared;
  const approved = await prepared.approve();
  if (approved.status !== 200) throw new Error(`plan approval failed: ${JSON.stringify(approved.body)}`);

  // The candidate is a real commit whose tree holds the approved applications, exported the way the worker exports one at the end of an IMPLEMENT run.
  // With the baseline round's source exported, the repository holds the task's base commit under the candidate, as the worker's repository does.
  const withBase = options.baseline === "source";
  const candidateFiles = { ...tree, "src/orders.js": "export const orders = [];\n" };
  const real = await createRealCandidate(options.candidateTree?.(candidateFiles) ?? candidateFiles,
    withBase ? { repositoryId: "demo", baseTree: tree } : { repositoryId: "demo", baseCommitSha: snapshot.commitSha });
  github.baseTree = real.baseline?.baseTreeSha;
  const task = harness.db.get(taskKey.pk, taskKey.sk)!;
  const approvedWorkflow = WorkflowSnapshotSchema.parse(task.workflow);
  const pinnedBase = real.baseline === undefined ? undefined : [{ repositoryId: "demo", baseCommitSha: options.baselinePin === "other" ? "7".repeat(40) : real.baseline.baseCommitSha }];
  const verifying = WorkflowSnapshotSchema.parse({ ...approvedWorkflow, revision: approvedWorkflow.revision + 1, stage: "VERIFY", state: "WAITING", candidate: real.source.candidate,
    ...(pinnedBase === undefined ? {} : { reviewBase: pinnedBase }) });
  harness.db.set({ ...task, workflow: verifying, ...(pinnedBase === undefined ? {} : { preparedBase: pinnedBase }) });
  const candidate = real.source.candidate;
  const readyOperationId = randomUUID();
  const dispatch = (workflowDispatchItem("state", taskId, verifying.revision, "CHECKS", candidate.digest, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item;
  if (options.seedReadiness !== false) dispatch.readinessOperationId = readyOperationId;
  harness.db.set(dispatch);
  if (options.seedReadiness !== false) {
    const marker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: verifying.revision, candidateDigest: candidate.digest, dispatchSk: dispatch.sk,
      outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, verifying.revision, candidate.digest), readyGeneration: 2 };
    harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readyOperationId}`, entityType: "OPERATION", id: readyOperationId, workspaceId, kind: "resume", status: "SUCCEEDED", fence: 2,
      requestId: readyOperationId, payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workflowE2EReadiness: marker });
  }
  harness.db.set({ ...workspaceSessionKey(workspaceId), workspaceId, state: "READY", generation: 2 });
  const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
  if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });
  // The coding run that produced the candidate is over: its operation is done and the workspace is free for the CHECKS operation.
  for (const operation of operationRows((row) => row.workflowMode === "IMPLEMENT")) harness.db.set({ ...operation, status: "SUCCEEDED" });
  const { activeOperationId: _active, ...freed } = harness.db.get(`WORKSPACE#${workspaceId}`, "META")!;
  void _active;
  harness.db.set({ ...freed, status: "READY" });
  const exportText = JSON.stringify(real.source);
  const exportKey = `workflow-candidate-sources/sha256/${sha(exportText)}.json`;
  harness.s3.objects.set(exportKey, exportText);
  harness.s3.objects.set(real.stored.manifestRef.key, real.manifestBytes.toString("utf8"));
  const exportOperationId = randomUUID();
  const at = new Date(Date.now() + 1000).toISOString();
  harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${exportOperationId}`, entityType: "OPERATION", id: exportOperationId, workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED",
    fence: 1, requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: at, updatedAt: at,
    candidateSourceRef: { key: exportKey, sha256: sha(exportText), byteLength: Buffer.byteLength(exportText), candidateDigest: candidate.digest }, candidateBuildSource: real.stored,
    // What the coding run's baseline-source callback leaves on its operation (Task 3.7b).
    ...(real.baseline !== undefined ? { baselineSource: real.baseline.stored }
      : options.baseline === "refused" ? { baselineSource: { status: "REFUSED", reason: "the worker could not export the unchanged code: the task recorded no base commit" } } : {}) });
  if (real.baseline?.stored.status === "READY") {
    harness.s3.objects.set(real.baseline.stored.sourceRef.key, real.baseline.sourceBytes.toString("utf8"));
    harness.s3.objects.set(real.baseline.stored.buildSource.manifestRef.key, real.baseline.manifestBytes.toString("utf8"));
  }
  harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${exportOperationId}`, entityType: "WORKFLOW_CANDIDATE_EXPORT", schemaVersion: 1, operationId: exportOperationId,
    status: "COMPLETE", createdAt: at, buildSource: real.stored });

  const runDispatch = async () => { await harness.handler({ source: "agentx.workflow-dispatch-recovery" }); };
  options.beforeDispatch?.(harness as unknown as RoundBrokerHarness);
  await runDispatch();
  const checksOperations = () => operationRows((row) => row.workflowMode === "CHECKS");
  const checks = checksOperations();
  if (checks.length !== 1) throw new Error(`the dispatch started ${checks.length} CHECKS operations: ${workflowNow().blockReason ?? workflowNow().state}`);
  /** The handles of one CHECKS operation: the candidate's, or (when the baseline round is on) the baseline's first. */
  const handlesFor = (operationId: string) => {
  const operationNow = () => harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown> & { status: string; fence: number; workflowE2EGroupEvidenceRefs?: unknown[];
    workflowE2EGroupRunIds?: string[]; workflowE2EEvidenceRef?: { key: string; sha256: string; byteLength: number }; workflowE2EAdmission: E2EWorkflowAdmissionRef };
  const admissionRef = E2EWorkflowAdmissionRefSchema.parse(operationNow().workflowE2EAdmission);
  const admissionBytes = harness.s3.objects.get(admissionRef.admissionRef.key)!;
  const admission: E2EApplicationExecutionAdmission = decodeE2EApplicationExecutionAdmission(admissionBytes);
  /** What the worker's first callback does to the operation: it is running. */
  const markRunning = () => harness.db.set({ ...operationNow(), status: "RUNNING" });

  const evidenceCall = (body: unknown, who: { operationId?: string } = {}) => call(harness.handler, {
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${who.operationId ?? operationId}/e2e-evidence`,
    headers: { "x-agentx-callback-capability": capabilityFor(who.operationId ?? operationId) }, body });
  const capabilityFor = (id: string) => String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === id)[0]!.invocation as { callbackCapability: string }).callbackCapability);

  /** The worker's `workflowE2EEvidenceSink`: init, the chunks in order, finalize. `afterInit` runs between them (to move the clock, say). */
  async function upload(object: unknown, input: { groupRunId?: string; afterInit?: () => void | Promise<void>; chunkBytes?: number } = {}) {
    const bytes = Buffer.from(JSON.stringify(object), "utf8");
    const digest = sha(bytes);
    const chunkCount = Math.ceil(bytes.byteLength / CHUNK_BYTES);
    const group = input.groupRunId === undefined ? {} : { groupRunId: input.groupRunId };
    const init = await evidenceCall({ stage: "init", ...group, totalBytes: bytes.byteLength, chunkCount, sha256: digest });
    if (init.status !== 200) return { stage: "init" as const, response: init, digest, bytes };
    const uploadId = String((init.body as { uploadId: string }).uploadId);
    await input.afterInit?.();
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
      const response = await evidenceCall({ stage: "chunk", ...group, uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha(chunk) });
      if (response.status !== 200) return { stage: "chunk" as const, response, digest, bytes };
    }
    const finalized = await evidenceCall({ stage: "finalize", ...group, uploadId, sha256: digest });
    return { stage: "finalize" as const, response: finalized, digest, bytes };
  }
  const groupEnvelope = (groupRun: Record<string, unknown>) => ({ schemaVersion: "workflow-e2e-group-evidence/v1", admissionSha256: admissionRef.admissionRef.sha256, taskId: admission.taskId,
    operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
    round: admission.round, groupRun });
  const aggregateEnvelope = (groupRuns: Record<string, unknown>[]) => ({ schemaVersion: "workflow-e2e-evidence/v1", admissionSha256: admissionRef.admissionRef.sha256, taskId: admission.taskId,
    operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
    round: admission.round, payload: { kind: "application", groupRuns } });
  /** The admission's groups, all of them application groups (the broker builds no other kind in an application round), with their shards. */
  const applicationGroups = admission.groups.flatMap((group) => (group.protocol === "trusted-e2e-application/v1" ? [group] : []));
  if (applicationGroups.length !== admission.groups.length) throw new Error("an application round holds only application groups");
  const groupIds = applicationGroups.map((group) => group.outerBinding.groupId);
  /** The genuinely collected evidence of one group. `observed` is per target of the group, in shard order. */
  const collectGroup = (groupId: string, observed: ObservedApiOutcome | readonly ObservedApiOutcome[], reportEdit?: (report: E2EApplicationReport, shardIndex: number) => void): Promise<ApplicationGroupEvidence> =>
    collectApplicationGroupEvidence({ admission, groupId, observed, ...(reportEdit === undefined ? {} : { reportEdit }) });

  /** The worker's terminal result for the CHECKS operation: it ran, and it names the aggregate evidence it saved. */
  const finishChecks = (aggregate?: { key: string; sha256: string }) => harness.finish(workspaceId, operationId, "SUCCEEDED", { result: {
    status: "SUCCEEDED", workflowMode: "CHECKS", workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories,
    checks: { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" },
    ...(aggregate === undefined ? {} : { workflowE2EEvidenceRef: aggregate }) } });
  const uploadKey = (groupRunId?: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operationId}${groupRunId === undefined ? "" : `#${groupRunId}`}` });
  const uploadRow = (groupRunId: string) => harness.db.get(uploadKey(groupRunId).pk, uploadKey(groupRunId).sk);
  /** Forgets an upload that was refused at its finalize (the worker uploads each object once; a test that tries several variants of one starts each afresh). */
  const clearUpload = (groupRunId?: string) => harness.db.delete(uploadKey(groupRunId).pk, uploadKey(groupRunId).sk);

  /** Marks the compute warm-up done for the task's current dispatch row, as it is for the first one by default (a retry writes a fresh row that would warm up again). */
  const reseedReadiness = () => {
    for (const row of harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId) as Array<Record<string, unknown> & { sk: string; workflowRevision: number }>) {
      if (row.readinessOperationId !== undefined) continue;
      const id = randomUUID();
      harness.db.set({ ...row, readinessOperationId: id });
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${id}`, entityType: "OPERATION", id, workspaceId, kind: "resume", status: "SUCCEEDED", fence: 2, requestId: id,
        payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        workflowE2EReadiness: { purpose: "workflow-e2e-readiness", taskId, workflowRevision: row.workflowRevision, candidateDigest: candidate.digest, dispatchSk: row.sk,
          outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, row.workflowRevision, candidate.digest), readyGeneration: 2 } });
    }
  };

  return { reseedReadiness, harness: harness as unknown as RoundBrokerHarness, taskId, workspaceId, operationId, snapshot, policy, intent, targets, real, candidate, admission, admissionRef, admissionBytes, applicationGroups, groupIds, projectBinding,
    workflowNow, taskNow: () => harness.db.get(taskKey.pk, taskKey.sk)!, operationNow, markRunning, upload, evidenceCall, groupEnvelope, aggregateEnvelope, collectGroup, finishChecks, uploadRow, clearUpload,
    runDispatch, checksOperations, operationRows, capabilityFor };
  };
  const first = handlesFor(String(checks[0]!.id));
  return { ...first,
    /** Runs the dispatch once more and returns the handles of the CHECKS operation it starts next (the candidate's, after a baseline round has been recorded). */
    nextRound: async () => {
      await runDispatch();
      const started = checksOperations().filter((row) => row.id !== first.operationId);
      if (started.length !== 1) throw new Error(`the dispatch started ${started.length} further CHECKS operations: ${workflowNow().blockReason ?? workflowNow().state}`);
      return handlesFor(String(started[0]!.id));
    } };
}
export type ApplicationRound = Awaited<ReturnType<typeof startApplicationRound>>;
/** The handles of one round (its operation, admission and callbacks), without the means of running the dispatch on to the next: what the round helpers need. */
export type RoundCore = Omit<ApplicationRound, "nextRound">;
