// Publication uses the current CHECKS evidence and live authority, never a rendered PASS.
import { createHash } from "node:crypto";
import { CandidateManifestSchema, agentXError, canonicalJson, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { taskKey } from "../task-flow/keys.js";
import { workspaceOperations } from "../task-flow/reads.js";
import { toDocument } from "../task-flow/records.js";
import type { TaskRecord } from "../task-flow/records.js";
import type { ApplicationE2ESeams, ApplicationTask } from "./application-seams.js";
import type { E2EVerificationDiagnostic } from "./authority.js";
import { verifyWorkflowE2EEvidence } from "./verification.js";

type Publication = NonNullable<Awaited<ReturnType<ApplicationE2ESeams["publication"]>>>;
type PublicationDeps = Pick<TaskFlowDeps, "companyId" | "applicationE2E">;
/** Internal operation binding. WIRING also carries this to push-credential authorization. */
export interface PublicationFenceBinding {
  publicationMode?: "CHECKED_TREE" | "COMMITTED_HEAD";
  expectedCommitSha?: string;
  admittedE2EAuthorityDigest?: string;
}

function approvedPlan(task: ApplicationTask) {
  const artifact = task.workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  const approval = artifact === undefined ? undefined : task.workflow.decisions.filter((entry) => entry.decision === "APPROVE" && entry.artifactDigest === artifact.sha256
    && (entry.actorRole === "TASK_OWNER" || entry.actorRole === "PROJECT_ADMIN") && (entry.source ?? "GATE") === "GATE").at(-1);
  return artifact === undefined || approval === undefined || artifact.sha256 !== task.workflow.e2e?.contractDigest ? undefined : { artifact, approval };
}

/** Recollect the qualified round through the same verifier Q2 uses at its result callback. */
export function createApplicationPublicationFence(deps: Pick<TaskFlowDeps, "store" | "companyId" | "e2e">): ApplicationE2ESeams["publication"] {
  return async (task) => {
    if (task.closedAt !== undefined || task.companyId !== deps.companyId) return undefined;
    const e2e = task.workflow.e2e;
    if (e2e?.required !== true) return { mode: "CHECKED_TREE", items: [] };
    const candidate = CandidateManifestSchema.safeParse(task.workflow.candidate);
    const qualified = e2e.qualifiedRound;
    if (deps.e2e === undefined || !candidate.success || qualified === undefined || approvedPlan(task) === undefined
      || qualified.candidateDigest !== candidate.data.digest || qualified.roundId !== e2e.currentRoundId
      || canonicalJson(qualified.groupRunIds) !== canonicalJson(e2e.currentGroupRunIds)
      || qualified.contractDigest !== e2e.contractDigest || qualified.policyDigest !== e2e.policyDigest
      || qualified.bundleDigest !== e2e.bundleDigest || qualified.executionPlanDigest !== e2e.executionPlanDigest) return undefined;
    const operations = await workspaceOperations(deps, task.workspaceId);
    const operation = operations.filter((entry) => entry.entityType === "OPERATION" && entry.companyId === deps.companyId && entry.workspaceId === task.workspaceId
      && entry.kind === "task" && entry.workflowMode === "CHECKS" && entry.status === "SUCCEEDED" && entry.workflowE2EAdmission !== undefined && entry.workflowE2EAdmission.purpose === undefined
      && entry.workflowE2EAdmission.taskId === task.taskId && entry.workflowE2EAdmission.roundId === qualified.roundId
      && entry.workflowE2EAdmission.candidateDigest === candidate.data.digest && entry.workflowE2EAdmission.admissionRef.sha256 === qualified.admissionSha256
      && entry.workflowE2EEvidenceRef?.sha256 === qualified.evidenceSha256).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (operation === undefined) return undefined;
    const diagnostic: E2EVerificationDiagnostic = {};
    if (await verifyWorkflowE2EEvidence(deps.e2e, operation, task, candidate.data, undefined, diagnostic) !== "PASS" || !diagnostic.authorityChecks?.length) return undefined;
    // Evidence is content addressed; also hold the mutable operation pointers and fence to what was re-read.
    return { mode: "COMMITTED_HEAD", items: [...diagnostic.authorityChecks, { kind: "check", key: { pk: operation.pk, sk: operation.sk }, condition: when.and(
      when.eq("status", "SUCCEEDED"), when.eq("fence", operation.fence), when.eq("workflowE2EAdmission", toDocument(operation.workflowE2EAdmission!)),
      when.eq("workflowE2EEvidenceRef", toDocument(operation.workflowE2EEvidenceRef!)),
    ) }] };
  };
}

/** A missing required port or empty authority cannot select ordinary checked-tree publication. */
export async function currentPublicationFence(deps: PublicationDeps, task: ApplicationTask): Promise<Publication | undefined> {
  if (task.closedAt !== undefined || task.companyId !== deps.companyId) return undefined;
  if (task.workflow.e2e?.required !== true) return { mode: "CHECKED_TREE", items: [] };
  const result = await deps.applicationE2E?.publication(task);
  return result?.mode === "COMMITTED_HEAD" && result.items.length > 0 && approvedPlan(task) !== undefined ? result : undefined;
}

function authorityDigest(task: ApplicationTask): string {
  const workflow = task.workflow;
  const e2e = workflow.e2e!;
  return createHash("sha256").update(canonicalJson({ domain: "core-e2e-publication/v1", companyId: task.companyId, developerId: task.developerId,
    taskId: task.taskId, workspaceId: task.workspaceId, project: task.project, startingRevision: task.startingRevision,
    approvedPlan: approvedPlan(task), graphApproval: workflow.workflowDependenciesApproval ?? null, candidate: workflow.candidate,
    base: workflow.reviewBase ?? task.preparedBase ?? null,
    e2e: { required: e2e.required, contractDigest: e2e.contractDigest, policyDigest: e2e.policyDigest, bundleDigest: e2e.bundleDigest, executionPlanDigest: e2e.executionPlanDigest,
      selection: e2e.applicationSelection ?? null, qualifiedRound: e2e.qualifiedRound ?? null, roundId: e2e.currentRoundId ?? null, groupRunIds: e2e.currentGroupRunIds },
  })).digest("hex");
}

export function publicationFenceBinding(task: ApplicationTask, fence: Publication, repositoryId: string): PublicationFenceBinding {
  if (fence.mode === "CHECKED_TREE") return { publicationMode: fence.mode };
  const repository = task.workflow.candidate?.repositories.find((entry) => entry.repositoryId === repositoryId);
  if (repository === undefined) throw agentXError("STALE_FENCE", "the committed publication candidate is missing");
  return { publicationMode: fence.mode, expectedCommitSha: repository.commitSha, admittedE2EAuthorityDigest: authorityDigest(task) };
}

/** Re-read before the code-host effect, and return the very same conditions for the final recording transaction. */
export async function assertCurrentPublicationFence(deps: PublicationDeps, task: ApplicationTask, expected: PublicationFenceBinding, repositoryId: string, commit?: string): Promise<readonly TransactItem[]> {
  const current = await currentPublicationFence(deps, task);
  if (current === undefined || (expected.publicationMode !== undefined && current.mode !== expected.publicationMode)) throw agentXError("STALE_FENCE", "publication authority is no longer current");
  if (current.mode === "COMMITTED_HEAD") {
    const binding = publicationFenceBinding(task, current, repositoryId);
    if (expected.publicationMode !== "COMMITTED_HEAD" || expected.expectedCommitSha !== binding.expectedCommitSha || expected.admittedE2EAuthorityDigest !== binding.admittedE2EAuthorityDigest
      || (commit !== undefined && commit !== binding.expectedCommitSha)) throw agentXError("STALE_FENCE", "the approved plan or committed publication changed");
  } else if (expected.expectedCommitSha !== undefined || expected.admittedE2EAuthorityDigest !== undefined) throw agentXError("STALE_FENCE", "publication authority changed");
  return current.items;
}

/** A callback has no workflow write of its own; hold the exact current task beside its authority conditions. */
export function publicationTaskCheck(task: TaskRecord): TransactItem {
  return { kind: "check", key: taskKey(task.taskId), condition: when.and(when.notExists("closedAt"), when.notExists("closeOperationId"), task.workflow === undefined ? when.notExists("workflow") : when.eq("workflow", toDocument(task.workflow)), when.eq("companyId", task.companyId), when.eq("workspaceId", task.workspaceId)) };
}
