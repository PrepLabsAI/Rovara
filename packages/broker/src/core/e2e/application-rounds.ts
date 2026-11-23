// Core port of application CHECKS admission. Stored canonical approval, source, live selection and creator authority
// are checked before an operation is accepted. The host supplies the atomic operation adapter; no worker claim grants a round.
import { createHash } from "node:crypto";
import {
  E2EApplicationBuildSourceManifestSchema, E2EApplicationSelectionRecordSchema, E2EWorkflowAdmissionRefSchema, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES,
  E2E_AGENT_STEPS_FEATURE, E2E_MODEL_FREE_LIMITS_FEATURE, WorkflowSnapshotSchema, blockWorkflow, canonicalJson, e2eApplicationAccountChanges,
  e2eApplicationSelectionFingerprint, queryAll, when, workflowApplicationRetryOffered, workflowRequestId, workflowSelectedChecks,
  type E2EApplicationPlanIntent, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, type TransactItem,
} from "@agentx/contracts";
import { buildApplicationExecutionAdmission, applicationApprovedPlanDigest, type ApplicationAdmissionInput, type ApplicationRoundApproval } from "../../e2e/application-admission.js";
import { ApplicationDispatchRefusal, applicationRoundRefusal } from "../../e2e/application-dispatch-check.js";
import { StoredCandidateBuildSourceSchema, candidateBuildSourceAdmissionReference } from "../../aws/candidate-build-source.js";
import { StoredBaselineSourceSchema } from "../../aws/baseline-source.js";
import { resolveWorkflowE2ECanonicalApproval } from "../../aws/workflow-e2e-current-authority.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { resolveRowItem } from "../task-flow/dispatch-rows.js";
import { OPERATION_SK_PREFIX } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { fromDocument, toDocument, type OperationRecord, type TaskRecord } from "../task-flow/records.js";
import { commitWorkflow, readWorkspace, type StepInput, type StepStart } from "../task-flow/stage-machine.js";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import { iso, newId } from "../task-flow/support.js";
import { baseOf, uuidFrom } from "../build-step/start.js";
import { baselineStartItem, E2E_BASELINE_ATTEMPT, readWorkflowE2EBaselineRecord } from "./baseline.js";
import { readWorkflowE2EReplayRecord } from "./replay.js";
import { readWorkflowE2EGroundingRecord } from "./grounding.js";
import { storeE2EAdmission, type RoundRecordReaders } from "./callbacks.js";
import { readCandidateSourceExport, type CandidateSourceRef } from "./uploads.js";
import { type UploadStores } from "./uploads-chunks.js";
import { BASELINE_STOPPED_REASON, BASELINE_STUCK_REASON, runBaselineRoundFirst } from "./application-baseline-dispatch.js";
import type { ApplicationE2ESeams, ApplicationTask } from "./application-seams.js";
import type { CurrentApplicationSelection, createApplicationSelectionReader } from "./application-readiness.js";
import type { HostedCreatorAuthority } from "./hosted-authority.js";
import type { E2EVerificationDeps } from "./authority.js";
import { settleNonCandidateRound } from "./verification.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export type ManagedApplicationAdmissionInput = Omit<ApplicationAdmissionInput, "planDigest"> & { approval: ApplicationRoundApproval };

/** Build and store the same immutable v2 admission the worker decodes. Plan identity is server-derived. */
export async function prepareApplicationAdmission(stores: UploadStores, input: ManagedApplicationAdmissionInput) {
  const { approval, ...rest } = input;
  const planDigest = input.baseline === undefined ? applicationApprovedPlanDigest(input.taskId, approval) : sha(canonicalJson({
    domain: "workflow-application-e2e-baseline-plan/v1", taskId: input.taskId, artifactId: approval.artifactId, artifactSha256: approval.artifactDigest,
    graphDigest: approval.graphDigest, graphRunId: approval.runId, workflowRevision: approval.workflowRevision, actorId: approval.actorId, baseCommitSha: input.baseline.baseCommitSha,
  }));
  const built = buildApplicationExecutionAdmission({ ...rest, planDigest });
  const reference = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, kind: "application", taskId: input.taskId, workflowRevision: input.workflowRevision,
    candidateDigest: built.admission.candidateDigest, roundId: built.roundId, groupRunIds: built.groupRunIds,
    ...(input.baseline === undefined ? {} : { purpose: "baseline", ...input.baseline }),
    ...(built.admission.groups.some((group) => group.outerBinding.modelRouteRevision !== null) && input.intent.scenarios.some((scenario) => scenario.steps.some((step) => step.kind === "agent")) ? { agentSteps: true } : {}),
    ...(built.admission.policy.capture.screenshots || built.admission.policy.capture.traces || built.admission.policy.capture.video || built.admission.policy.capture.downloads ? { captureExtras: true } : {}),
    admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength } });
  await storeE2EAdmission(stores, { key: reference.admissionRef.key, sha256: built.sha256, bytes: built.bytes, taskId: input.taskId, candidateDigest: built.admission.candidateDigest });
  return { built, reference };
}

/** Adapter extends the existing acceptStep input, so the admission lands on operation and payload in the SAME transaction. WIRING owns that adapter. */
export interface ApplicationStepInput extends StepInput { workflowE2EAdmission: E2EWorkflowAdmissionRef }
export interface ApplicationRoundsDeps {
  flow: TaskFlowDeps;
  checksRow(taskId: string, revision: number, at: string): TransactItem;
  objects: E2EVerificationDeps["objects"];
  selection: ReturnType<typeof createApplicationSelectionReader>;
  creator(task: TaskRecord): Promise<HostedCreatorAuthority | undefined>;
  accept(input: ApplicationStepInput): Promise<{ result: StepStart; operation?: OperationRecord }>;
  verification: E2EVerificationDeps;
  /** Existing gateway route/cap admission. Mandatory for an agent scenario, checked before compute can wake. */
  agentRoute?: (task: ApplicationTask, intent: E2EApplicationPlanIntent, policy: unknown) => Promise<readonly TransactItem[]>;
  cancelBaseline(task: ApplicationTask, operationId: string): Promise<void>;
  /** Optional code-host verification of the informational baseline's exported tree. */
  baseTree?: (task: ApplicationTask, repositoryId: string, commitSha: string) => Promise<string | undefined>;
}

type SourceOperation = OperationRecord & { candidateSourceRef?: CandidateSourceRef; candidateBuildSource?: unknown; baselineSource?: unknown };
export async function applicationSourceOperation(flow: TaskFlowDeps, task: TaskRecord, digest: string): Promise<SourceOperation | undefined> {
  const location = await workspaceKeys(flow, task.workspaceId);
  return (await queryAll(flow.store, { pk: location.workspaceKey.pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX } }))
    .map((item) => fromDocument<SourceOperation>(item)!)
    .filter((operation) => operation.kind === "task" && operation.workflowMode === "IMPLEMENT" && operation.candidateSourceRef?.candidateDigest === digest)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

async function buildSourceOf(stores: UploadStores, stored: Extract<ReturnType<typeof StoredCandidateBuildSourceSchema.parse>, { status: "READY" }>) {
  const bytes = await stores.objects.get(stored.manifestRef.key, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES);
  if (bytes === undefined || bytes.byteLength !== stored.manifestRef.byteLength || sha(bytes) !== stored.manifestRef.sha256) throw applicationRoundRefusal("The exported build source manifest is missing or changed.");
  const manifest = E2EApplicationBuildSourceManifestSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (manifest.manifestDigest !== stored.manifestDigest) throw applicationRoundRefusal("The build source manifest is not the one the record names.");
  return { manifest, reference: candidateBuildSourceAdmissionReference(stored) };
}

/** Read both upload records and their immutable objects, never just the worker's result manifest. */
export async function readApplicationCandidateSource(deps: Pick<ApplicationRoundsDeps, "flow" | "objects">, task: ApplicationTask) {
  const candidate = task.workflow.candidate;
  if (candidate === undefined) throw applicationRoundRefusal("The task has no committed candidate.");
  const operation = await applicationSourceOperation(deps.flow, task, candidate.digest);
  if (operation?.candidateSourceRef === undefined) throw applicationRoundRefusal("The candidate has no committed source export.");
  const stored = StoredCandidateBuildSourceSchema.safeParse(operation.candidateBuildSource);
  if (!stored.success || stored.data.status !== "READY" || stored.data.candidateDigest !== candidate.digest) throw applicationRoundRefusal("No usable build source was exported for this candidate.");
  const exportKey = { pk: operation.pk, sk: `CANDIDATE_EXPORT#${operation.id}` };
  const exported = await deps.flow.store.get(exportKey);
  if (exported?.["status"] !== "COMPLETE" || exported["operationId"] !== operation.id || exported["fence"] !== operation.fence
    || canonicalJson(exported["buildSource"]) !== canonicalJson(stored.data)) throw applicationRoundRefusal("The candidate export and its operation disagree about the build source.");
  const source = await readCandidateSourceExport({ objects: deps.objects }, operation.candidateSourceRef);
  if (source === undefined || source.repositories.length !== 1 || canonicalJson(source.candidate) !== canonicalJson(candidate)) throw applicationRoundRefusal("The committed candidate export is unavailable or ambiguous.");
  const repository = source.repositories[0]!;
  if (stored.data.repositoryId !== repository.repositoryId || stored.data.commitSha !== repository.commitSha || stored.data.treeSha !== repository.treeSha) throw applicationRoundRefusal("The build source names another commit or tree.");
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map(({ bytesBase64, ...source }) => ({ ...source, bytes: Buffer.from(bytesBase64, "base64") })) };
  const items: TransactItem[] = [
    { kind: "check", key: { pk: operation.pk, sk: operation.sk }, condition: when.and(when.eq("fence", operation.fence), when.eq("candidateSourceRef", toDocument(operation.candidateSourceRef)), when.eq("candidateBuildSource", toDocument(stored.data))) },
    { kind: "check", key: exportKey, condition: when.and(when.eq("status", "COMPLETE"), when.eq("fence", operation.fence), when.eq("buildSource", toDocument(stored.data))) },
  ];
  return { operation, snapshot, items, buildSource: await buildSourceOf({ store: deps.flow.store, objects: deps.objects }, stored.data) };
}

async function approvedPlan(deps: ApplicationRoundsDeps, task: ApplicationTask) {
  const artifact = task.workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || task.workflow.e2e?.contractDigest !== artifact.sha256) throw applicationRoundRefusal("The current canonical plan is unavailable.");
  const document = await loadWorkflowDocument(async (key, maxBytes) => { const bytes = await deps.objects.get(key, maxBytes); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); }, artifact, {});
  const approval = document?.format !== "structured" ? undefined : resolveWorkflowE2ECanonicalApproval({ taskId: task.taskId, workflow: task.workflow as Parameters<typeof resolveWorkflowE2ECanonicalApproval>[0]["workflow"] & typeof task.workflow, artifact, plan: document.plan });
  if (document?.format !== "structured" || document.plan.e2e?.schemaVersion !== 2 || approval === undefined) throw applicationRoundRefusal("The exact canonical application plan has no current owner approval.");
  return { intent: document.plan.e2e, artifact, approval };
}

async function creatorOf(deps: ApplicationRoundsDeps, task: ApplicationTask) {
  const access = await deps.flow.access.checkStep(task);
  const creator = access.allowed ? await deps.creator(task) : undefined;
  if (creator === undefined || creator.companyId !== task.companyId || task.companyId !== deps.flow.companyId || creator.proof.developerId !== task.developerId
    || creator.proof.project !== task.project || creator.items.length === 0 || creator.items.some((item) => item.kind !== "check")) throw applicationRoundRefusal("The original creator has no current company and project authority.");
  return { ...creator, items: [...creator.items, ...(access.allowed ? access.items ?? [] : [])] };
}

async function baselineSourceOf(deps: ApplicationRoundsDeps, task: ApplicationTask, operation: SourceOperation) {
  const parsed = StoredBaselineSourceSchema.safeParse(operation.baselineSource);
  if (!parsed.success || parsed.data.status !== "READY") throw applicationRoundRefusal("The unchanged code was not exported.");
  const stored = parsed.data;
  const candidate = task.workflow.candidate;
  const pinned = (task.workflow.reviewBase ?? task.preparedBase)?.find((base) => base.repositoryId === stored.repositoryId)?.baseCommitSha
    ?? candidate?.repositories.find((repository) => repository.repositoryId === stored.repositoryId)?.baseCommitSha;
  if (pinned === undefined || stored.baseCommitSha !== pinned || stored.buildSource.commitSha !== pinned || stored.buildSource.treeSha !== stored.baseTreeSha) throw applicationRoundRefusal("The unchanged source is not the task's pinned base.");
  if (deps.baseTree !== undefined && await deps.baseTree(task, stored.repositoryId, pinned) !== stored.baseTreeSha) throw applicationRoundRefusal("The code host did not confirm the baseline tree.");
  const exported = await readCandidateSourceExport({ objects: deps.objects }, stored.sourceRef);
  const repository = exported?.repositories.length === 1 ? exported.repositories[0] : undefined;
  if (exported === undefined || exported.candidate.digest !== stored.sourceRef.candidateDigest || repository?.commitSha !== pinned || repository.treeSha !== stored.baseTreeSha) throw applicationRoundRefusal("The unchanged source object is missing or changed.");
  return { snapshot: { candidate: exported.candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map(({ bytesBase64, ...source }) => ({ ...source, bytes: Buffer.from(bytesBase64, "base64") })) } satisfies E2ESourceSnapshot,
  buildSource: await buildSourceOf({ store: deps.flow.store, objects: deps.objects }, stored.buildSource), baseline: { baseCommitSha: pinned, attempt: E2E_BASELINE_ATTEMPT } };
}

async function applicationAgentRoute(deps: ApplicationRoundsDeps, task: ApplicationTask, intent: E2EApplicationPlanIntent, policy: CurrentApplicationSelection["inputs"]["policy"], baseline: boolean) {
  const agent = !baseline && intent.scenarios.some((scenario) => scenario.steps.some((step) => step.kind === "agent"));
  if (agent && deps.agentRoute === undefined) throw applicationRoundRefusal("The approved AI navigation route cannot be admitted.");
  const routeItems = agent ? await deps.agentRoute!(task, intent, policy) : [];
  return { agent, routeItems };
}

function applicationChecksFeatures(commands: readonly unknown[], baseline: boolean, agent: boolean): string[] {
  return ["task.workflowMode", "task.workflowE2EAdmission", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", ...(commands.length === 0 ? [] : ["task.readiness"]),
    ...(baseline ? ["task.workflowE2EBaselineChecks"] : []), ...(agent ? [E2E_AGENT_STEPS_FEATURE] : [E2E_MODEL_FREE_LIMITS_FEATURE])];
}

export function createApplicationRounds(deps: ApplicationRoundsDeps): ApplicationE2ESeams["rounds"] {
  const state = { store: deps.flow.store, ...(deps.flow.now === undefined ? {} : { now: deps.flow.now }) };
  const stores = { ...state, objects: deps.objects };
  const records: RoundRecordReaders = {
    task: (id) => readTask(deps.flow, id),
    baseline: async (task) => { const actual = await readTask(deps.flow, task.taskId); return actual === undefined ? undefined : readWorkflowE2EBaselineRecord(state, actual); },
    replay: (taskId, round) => readWorkflowE2EReplayRecord(state, taskId, round), grounding: (ref) => readWorkflowE2EGroundingRecord(state, ref),
  };
  const start = async (task: ApplicationTask, current: CurrentApplicationSelection, plan: Awaited<ReturnType<typeof approvedPlan>>, source: Awaited<ReturnType<typeof readApplicationCandidateSource>>, baseline = false): Promise<StepStart> => {
    const workspace = await readWorkspace(deps.flow, task.workspaceId);
    if (workspace === undefined || workspace.status === "CLOSED") return "STALE";
    if (workspace.status !== "READY" || workspace.activeOperationId !== null) return "WAITING";
    const creator = await creatorOf(deps, task);
    const { agent, routeItems } = await applicationAgentRoute(deps, task, plan.intent, current.inputs.policy, baseline);
    const selected = E2EApplicationSelectionRecordSchema.parse(task.workflow.e2e?.applicationSelection);
    const operationId = newId(deps.flow);
    const base = baseline ? await baselineSourceOf(deps, task, source.operation) : { snapshot: source.snapshot, buildSource: source.buildSource };
    const prepared = await prepareApplicationAdmission(stores, { ...current.inputs, ...base, ...plan, recordedSelection: selected,
      taskId: task.taskId, operationId, operationFence: workspace.fence + 1, workflowRevision: task.workflow.revision + (baseline ? 0 : 1),
      roundId: newId(deps.flow), runId: () => newId(deps.flow), now: (deps.flow.now?.() ?? new Date()).getTime(), creatorAuthority: creator.proof });
    const { reference, built } = prepared;
    const now = iso(deps.flow);
    const extra: TransactItem[] = [...current.items, ...creator.items, ...source.items, ...routeItems];
    const next = baseline ? undefined : WorkflowSnapshotSchema.parse({ ...task.workflow, revision: task.workflow.revision + 1, state: "RUNNING", updatedAt: now,
      e2e: { ...task.workflow.e2e, currentRoundId: built.roundId, currentGroupRunIds: built.groupRunIds } });
    if (baseline) extra.push(baselineStartItem(task, { baseCommitSha: reference.baseCommitSha!, operationId, roundId: built.roundId, admissionSha256: built.sha256, startedAt: now,
      deadlineAt: built.admission.round.deadlineAt, skippedAiScenarios: [...built.skippedAiScenarios] }),
      { kind: "check", key: { pk: task.pk, sk: task.sk }, condition: when.and(when.notExists("closedAt"), when.eq(["workflow", "revision"], task.workflow.revision), when.eq(["workflow", "state"], "WAITING")) });
    else extra.push(resolveRowItem(deps.flow, task.taskId, task.workflow.revision));
    const commands = workflowSelectedChecks(task.workflow.checkPolicy).map((check) => check.command);
    const payload = toDocument({ ...baseOf(task, task.workflow), ...(commands.length === 0 ? {} : { readiness: commands }), workflowE2EAdmission: reference });
    const accepted = await deps.accept({ task, workspace, operationId, workflowMode: "CHECKS", prompt: "Run the admitted application scenarios on the committed source. Do not edit files.",
      requestId: workflowRequestId(baseline ? "agentx-core-e2e-baseline" : "agentx-core-e2e-checks", task.taskId, task.workflow.revision, task.workflow.candidate!.digest),
      ...(next === undefined ? {} : { workflow: { current: task.workflow, next } }), extra, payload, workflowE2EAdmission: reference,
      requires: applicationChecksFeatures(commands, baseline, agent), extraActions: ["e2e-admission", "e2e-evidence"] });
    return accepted.result;
  };
  const runRow: ApplicationE2ESeams["rounds"]["runRow"] = async (row) => {
    const task = await readTask(deps.flow, row.taskId);
    if (task?.companyId !== deps.flow.companyId || task.closedAt !== undefined || task.workflow?.revision !== row.workflowRevision
      || task.workflow.stage !== "VERIFY" || task.workflow.state !== "WAITING" || task.workflow.e2e?.required !== true) return "STALE";
    const applicationTask = task as ApplicationTask;
    try {
      await creatorOf(deps, applicationTask);
      const plan = await approvedPlan(deps, applicationTask);
      const current = await deps.selection.current(applicationTask, plan.intent, plan.artifact);
      // All deterministic refusals happen before accept queues anything that could warm a worker.
      const source = await readApplicationCandidateSource(deps, applicationTask);
      const baseline = await runBaselineRoundFirst(state, applicationTask, {
        start: () => start(applicationTask, current, plan, source, true),
        operation: async (id) => { const location = await workspaceKeys(deps.flow, task.workspaceId); return fromDocument<OperationRecord>(await deps.flow.store.get(location.operationKey(id))); },
        activeOperationId: async () => (await readWorkspace(deps.flow, task.workspaceId))?.activeOperationId,
        cancel: (id) => deps.cancelBaseline(applicationTask, id),
        settle: async (id) => { const location = await workspaceKeys(deps.flow, task.workspaceId); const operation = fromDocument<OperationRecord>(await deps.flow.store.get(location.operationKey(id))); if (operation !== undefined) await settleNonCandidateRound(deps.verification, operation, operation.status); },
      });
      if (baseline === "WAIT") return "WAITING";
      if (baseline === "STOPPED" || baseline === "STUCK") {
        await commitWorkflow(deps.flow, task, blockWorkflow(task.workflow, baseline === "STOPPED" ? BASELINE_STOPPED_REASON : BASELINE_STUCK_REASON, iso(deps.flow)), [resolveRowItem(deps.flow, task.taskId, row.workflowRevision)]);
        return "STALE";
      }
      return await start(applicationTask, current, plan, source);
    } catch (error) {
      if (!(error instanceof ApplicationDispatchRefusal)) throw error;
      await commitWorkflow(deps.flow, task, blockWorkflow(task.workflow, error.message.slice(0, 500), iso(deps.flow)), [resolveRowItem(deps.flow, task.taskId, row.workflowRevision)]);
      return "STALE";
    }
  };
  const retry: ApplicationE2ESeams["rounds"]["retry"] = async (task, input) => {
    const fresh = await readTask(deps.flow, task.taskId);
    const requestId = uuidFrom(input.requestId);
    if (fresh?.workflow?.verificationRetries?.some((retry) => retry.requestId === requestId)) return "DUPLICATE";
    if (fresh?.companyId !== deps.flow.companyId || fresh.closedAt !== undefined || fresh.workflow?.revision !== task.workflow.revision || fresh.workflow.stage !== "VERIFY" || fresh.workflow.state !== "BLOCKED" || fresh.workflow.e2e?.required !== true) return "STALE";
    const actual = fresh as ApplicationTask;
    const plan = await approvedPlan(deps, actual);
    const creator = await creatorOf(deps, actual);
    const recorded = E2EApplicationSelectionRecordSchema.parse(fresh.workflow.e2e.applicationSelection);
    const reapprove = workflowApplicationRetryOffered(fresh.workflow);
    const current = reapprove ? await deps.selection.selection(actual, plan.intent, plan.artifact, { mode: "reapprove", pinned: [] }) : await deps.selection.current(actual, plan.intent, plan.artifact);
    const { blockReason: _reason, ...workflow } = fresh.workflow; void _reason;
    const { qualifiedRound: _qualified, failedRound: _failed, displayRef: _display, currentRoundId: _round, ...e2e } = workflow.e2e!;
    void _qualified; void _failed; void _display; void _round;
    const at = iso(deps.flow);
    const next = WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, state: "WAITING", updatedAt: at,
      e2e: { ...e2e, currentGroupRunIds: [], applicationSelection: current.selection,
        ...(reapprove ? { applicationReapprovals: [...(e2e.applicationReapprovals ?? []), { requestId, actorId: input.actorId, reason: "Owner retried the application checks.", at,
          previous: e2eApplicationSelectionFingerprint(recorded), current: e2eApplicationSelectionFingerprint(current.selection), accounts: e2eApplicationAccountChanges(recorded, current.selection) }].slice(-20) } : {}) },
      verificationRetries: [...(workflow.verificationRetries ?? []), { requestId, actorId: input.actorId, at, selectedOptionalCheckIds: workflow.checkPolicy?.selectedOptionalIds ?? [], selectedProposedCheckIds: workflow.checkPolicy?.selectedProposedIds ?? [] }] });
    if (!await commitWorkflow(deps.flow, fresh, next, [...current.items, ...creator.items, deps.checksRow(task.taskId, next.revision, at)])) return "STALE";
    return runRow({ taskId: task.taskId, workflowRevision: next.revision });
  };
  return { selection: deps.selection.selection, runRow, retry, records, verification: deps.verification };
}
