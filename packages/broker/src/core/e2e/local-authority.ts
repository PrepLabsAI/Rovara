// The current authority of an application round on Code's own records (the `E2EAuthority` seam of the verification), Cloud's `workflowE2EApplicationAuthorityIsValid` with its sources named:
// the task's approved plan comes from the object store, the project from the `ProjectSource`, the creator from the install's `TaskAccess` (Code's default is the one local owner), the
// candidate's source from the stored export, and the runtime rows, the test accounts and the setup approval from one seam, `currentSelection`, because they belong to the install's runtime
// registration (Cloud: the project's E2E setup and the qualified runtime catalog). An install that gives no `currentSelection` can judge no round: every verdict is UNKNOWN.
//
// A `currentSelection` must return only attested rows: runtime rows that passed their qualification and are READY now, and the account entries as registered now. The worker produces the evidence
// of a round, and it is trustworthy only from such a runtime; this module fences the rows it is given (the catalog, the project's revision, every runtime row the round ran on, the accounts), but
// it cannot tell an attested row from one that is not.
import {
  E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2EPolicySchema, E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, canonicalJson, e2eAnonymousTargetId, e2eAnonymousVariantOf,
  orgProjectCatalogKey, projectRevisionKey, when,
  type E2EApplicationExecutionAdmission, type E2EApplicationSelectionRecord, type E2ECreatorAuthority, type E2ERegisteredRuntime, type E2ESourceSnapshot, type JsonValue, type ObjectStorage,
  type OrgId, type TransactItem,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { applicationSelectionStillCurrent } from "../../e2e/application-dispatch-check.js";
import type { E2EAccountRegistryEntry } from "../../e2e/application-account-registry.js";
import { applicationIntentDigest, applicationIntentWithAccountRefs, applicationRoundIntent } from "../../e2e/application-plan-approval.js";
import { resolveWorkflowE2ECanonicalApproval } from "../../aws/workflow-e2e-current-authority.js";
import type { ProjectSource, TaskAccess } from "../task-flow/deps.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import type { E2EAuthority, E2EVerificationDiagnostic, VerifiedCandidate } from "./authority.js";
import type { E2EStateStore } from "./state.js";
import { accountRegistryFences } from "./account-registry.js";
import { applicationRuntimeRowFences } from "./runtime-readiness.js";
import { readCandidateSourceExport, type CandidateSourceRef } from "./uploads.js";

/** The source reference a coding run's operation row carries once its export was accepted. */
const sourceRefOf = (operation: OperationRecord): CandidateSourceRef | undefined => (operation as OperationRecord & { candidateSourceRef?: CandidateSourceRef }).candidateSourceRef;

/** What the install's runtime registration says is true of the plan right now (Cloud's `evaluateWorkflowE2EApplicationSelectionNow`). */
export type CurrentSelection =
  | { ok: true; selection: E2EApplicationSelectionRecord; rows: readonly E2ERegisteredRuntime[]; accountEntries: readonly E2EAccountRegistryEntry[] }
  | { ok: false; kind: "refused" | "unevaluable"; reason: string; scope?: "runtime" | "accounts" | undefined };

export interface LocalAuthorityDeps {
  companyId: OrgId;
  state: E2EStateStore;
  objects: ObjectStorage;
  projects: ProjectSource;
  access: Pick<TaskAccess, "checkStep">;
  /** The task's operations in its workspace, newest first is not required; the IMPLEMENT run that exported the candidate is found among them. */
  operationsOf(task: TaskRecord): Promise<readonly OperationRecord[]>;
  /** Absent: no round can be judged (fail closed). */
  currentSelection?: ((input: { task: TaskRecord; intent: ReturnType<typeof E2EApplicationPlanIntentSchema.parse>; artifact: { id: string; sha256: string }; pinned: E2EApplicationSelectionRecord["accountRefs"] }) => Promise<CurrentSelection>) | undefined;
}

/** The proof Code records for its one local owner: a direct grant of the administrator role under a fixed grant id. */
export function localOwnerAuthority(developerId: string, project: string): Extract<E2ECreatorAuthority, { kind: "direct-membership" }> {
  return { kind: "direct-membership", developerId, project, role: "administrator", grantId: "local-owner" };
}

const sameSnapshot = (left: E2ESourceSnapshot, right: E2ESourceSnapshot): boolean => {
  if (canonicalJson(left.candidate) !== canonicalJson(right.candidate) || left.commitSha !== right.commitSha || left.treeSha !== right.treeSha || left.treeComplete !== right.treeComplete
    || canonicalJson(left.treePaths) !== canonicalJson(right.treePaths) || left.sources.length !== right.sources.length) return false;
  const byPath = new Map(right.sources.map((source) => [source.path, source]));
  return left.sources.every((source) => {
    const actual = byPath.get(source.path);
    return actual !== undefined && source.sha256 === actual.sha256 && source.kind === actual.kind && Buffer.from(source.bytes).equals(Buffer.from(actual.bytes));
  });
};

function changedRuntimeFields(now: E2ERegisteredRuntime, admitted: E2ERegisteredRuntime): string {
  const moved = (["generation", "expiresAt", "qualifiedAt"] as const).find((field) => now[field] !== admitted[field]);
  if (moved === undefined) return "another field of its record changed";
  return moved === "generation" ? `generation ${String(now.generation)} now, ${String(admitted.generation)} when admitted` : `${moved} now ${String(now[moved])}, ${String(admitted[moved])} when admitted`;
}

export function createLocalE2EAuthority(deps: LocalAuthorityDeps): E2EAuthority {
  const application = async (input: { task: TaskRecord; candidate: VerifiedCandidate; admission: E2EApplicationExecutionAdmission }, diagnostic?: E2EVerificationDiagnostic): Promise<boolean> => {
    const reject = (reason: string): false => { if (diagnostic !== undefined) diagnostic.reason = reason; return false; };
    if (diagnostic !== undefined) diagnostic.authorityEvaluated = true;
    const { task, candidate, admission } = input;
    let stage = "workflow";
    try {
      // The task is open, on this candidate, with required checks; its latest plan is the one the contract was approved for, and the owner's approval of exactly that plan resolves.
      const workflow = task.workflow;
      if (workflow === undefined || workflow.e2e?.required !== true || workflow.candidate?.digest !== candidate.digest || task.closedAt !== undefined) return reject("current-task-or-approval-missing");
      const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
      if (artifact === undefined || workflow.e2e.contractDigest !== artifact.sha256) return reject("current-canonical-plan-missing-or-stale");
      stage = "canonical-artifact";
      const approved = await loadWorkflowDocument(async (key, maxBytes) => { const bytes = await deps.objects.get(key, maxBytes); return bytes === undefined ? undefined : new TextDecoder().decode(bytes); }, artifact, {});
      if (approved?.format !== "structured") return reject("canonical-artifact-or-owner-decision-mismatch");
      const approval = resolveWorkflowE2ECanonicalApproval({ taskId: task.taskId,
        workflow: workflow as typeof workflow & { artifacts: Array<{ id: string; type: string; sha256: string }>; decisions: Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }> },
        artifact, plan: approved.plan });
      if (approval === undefined) return reject("canonical-artifact-or-owner-decision-mismatch");
      // The admission is only ever for an approved application plan, the intent it carries and the selection recorded for it.
      const storedIntent = approved.plan.e2e;
      if (storedIntent?.schemaVersion !== 2) return reject("application-admission-needs-application-plan");
      const parsedIntent = E2EApplicationPlanIntentSchema.safeParse(storedIntent);
      if (!parsedIntent.success) return reject("approved-plan-intent-is-not-readable");
      const intent = parsedIntent.data;
      const recorded = E2EApplicationSelectionRecordSchema.safeParse(workflow.e2e.applicationSelection);
      if (!recorded.success) return reject("no-recorded-application-selection");
      if (canonicalJson(applicationRoundIntent(applicationIntentWithAccountRefs(intent, recorded.data.accountRefs))) !== canonicalJson(admission.intent)) return reject("approved-plan-is-not-the-admitted-intent");
      // The project: the pinned revision and the latest one hold the same policy, and the round's policy is the project's with the signed-out variants derived from its base targets.
      stage = "project-record";
      const pinned = await deps.projects.revision(task.project, task.startingRevision);
      const latest = await deps.projects.latest(task.project);
      if (pinned === undefined || latest === undefined) return reject("current-project-latest-revision-unavailable");
      // The rows the project's authority stands on, read as they are: the latest revision must be the one the catalog names, it must hold the approved setup, and the pinned and latest
      // revisions must hold the same policy and the same runtime binding.
      const catalogKey = orgProjectCatalogKey(deps.companyId, task.project);
      const catalogRow = await deps.state.store.get(catalogKey);
      if (catalogRow?.["entityType"] !== "PROJECT_CATALOG" || catalogRow["name"] !== task.project || catalogRow["latestRevision"] !== latest.definition.revision) return reject("current-project-latest-revision-unavailable");
      const latestKey = projectRevisionKey(deps.companyId, task.project, latest.definition.revision);
      const latestRow = await deps.state.store.get(latestKey);
      const pinnedRow = await deps.state.store.get(projectRevisionKey(deps.companyId, task.project, task.startingRevision));
      if (latestRow === undefined || pinnedRow === undefined) return reject("current-project-latest-revision-unavailable");
      if (latestRow["setupApproval"] === undefined) return reject("current-project-setup-approval-unavailable");
      const policy = E2EPolicySchema.parse(latest.definition.e2e);
      if (canonicalJson(policy) !== canonicalJson(E2EPolicySchema.parse(pinned.definition.e2e)) || canonicalJson(latestRow["runtimeBinding"] ?? null) !== canonicalJson(pinnedRow["runtimeBinding"] ?? null)) {
        return reject("current-project-policy-or-runtime-changed");
      }
      const admittedPolicy = E2EPolicySchema.parse(admission.policy);
      const derivedVariant = (target: (typeof policy)["targets"][number]) => target.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID
        && policy.targets.some((base) => base.kind === target.kind && e2eAnonymousTargetId(base.targetId) === target.targetId && canonicalJson(e2eAnonymousVariantOf(base)) === canonicalJson(target));
      if (canonicalJson(policy) !== canonicalJson({ ...admittedPolicy, targets: admittedPolicy.targets.filter((target) => !derivedVariant(target)) })) return reject("current-project-policy-or-runtime-changed");
      // The creator: the person the task runs for may still start it, and holds exactly the proof the round was admitted under.
      stage = "creator-project-access";
      const verdict = await deps.access.checkStep({ taskId: task.taskId, developerId: task.developerId, project: task.project });
      if (!verdict.allowed) return reject("current-creator-can-only-view-project");
      if (admission.creatorAuthority === undefined || canonicalJson(admission.creatorAuthority) !== canonicalJson(localOwnerAuthority(task.developerId, task.project))) return reject("creator-membership-proof-changed-or-unavailable");
      // The candidate's source: the stored export is exactly what the round was admitted with.
      stage = "candidate-source-export";
      const operations = await deps.operationsOf(task);
      const sourceOperation = operations.filter((item) => item.kind === "task" && item.workflowMode === "IMPLEMENT" && sourceRefOf(item)?.candidateDigest === candidate.digest)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const sourceRef = sourceOperation === undefined ? undefined : sourceRefOf(sourceOperation);
      if (sourceRef === undefined) return reject("candidate-source-operation-missing");
      const sourceExport = await readCandidateSourceExport({ objects: deps.objects }, sourceRef);
      if (sourceExport === undefined || sourceExport.repositories.length !== 1) return reject("candidate-source-export-missing-or-ambiguous");
      const repository = sourceExport.repositories[0]!;
      const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
        sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
      const admittedSnapshot: E2ESourceSnapshot = { ...admission.sourceSnapshot, sources: admission.sourceSnapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
      if (!sameSnapshot(admittedSnapshot, snapshot) || admission.candidateCommitSha !== snapshot.commitSha || admission.candidateTreeSha !== snapshot.treeSha) return reject("current-admission-runtime-plan-or-source-mismatch");
      // The runtime rows, the accounts and the setup, read now.
      stage = "current-runtime-rows";
      if (deps.currentSelection === undefined) return reject("no-current-authority-source");
      const current = await deps.currentSelection({ task, intent, artifact: { id: artifact.id, sha256: artifact.sha256 }, pinned: recorded.data.accountRefs });
      if (!current.ok) {
        if (current.kind === "refused" && current.scope === "runtime" && diagnostic !== undefined) diagnostic.runtimeChange = "unusable";
        if (current.kind === "refused" && current.scope === "accounts" && diagnostic !== undefined) diagnostic.runtimeChange = "accounts";
        return reject(`${current.kind === "unevaluable" ? "application-selection-unavailable" : "application-selection-refused"}: ${current.reason}`);
      }
      for (const { value: admitted } of admission.runtimeBindings) {
        const row = current.rows.find((item) => item.capabilities.kind === admitted.capabilities.kind && item.profileId === admitted.profileId);
        const label = `${admitted.capabilities.kind} runtime ${admitted.profileId}`;
        if (row === undefined) { if (diagnostic !== undefined) diagnostic.runtimeChange = "unusable"; return reject(`the ${label} this round was admitted on is not ready now`); }
        if (canonicalJson(row) !== canonicalJson(admitted)) { if (diagnostic !== undefined) diagnostic.runtimeChange = "requalified"; return reject(`the ${label} was requalified during the round (${changedRuntimeFields(row, admitted)})`); }
      }
      const unchanged = applicationSelectionStillCurrent(recorded.data, current.selection);
      if (!unchanged.ok) return reject(`application-selection-changed: ${unchanged.reason}`);
      if (canonicalJson(admission.selectionInput.approvedSemanticApproval) !== canonicalJson(recorded.data.semanticApproval)
        || canonicalJson(admission.selectionInput.setupApproval) !== canonicalJson(recorded.data.setupApproval)
        || applicationIntentDigest(intent) !== recorded.data.intentDigest
        || admission.intentDigest !== createHash("sha256").update(canonicalJson(admission.intent)).digest("hex")) return reject("canonical-approval-binding-mismatch");
      // The rows the verdict stands on, as conditions for the transaction that records it (the task's own row is held by that transaction): the catalog, the project's revision as it was read
      // (what the policy, the setup approval and the runtime binding are), every runtime row the round ran on, exactly as read, and the accounts it ran as.
      const revisionCondition = when.and(when.eq("entityType", latestRow["entityType"] ?? null), when.eq(["definition", "e2e"], policy as unknown as JsonValue), when.eq("setupApproval", latestRow["setupApproval"]),
        ...(latestRow["registeredBy"] === undefined ? [] : [when.eq("registeredBy", latestRow["registeredBy"])]),
        latestRow["runtimeBinding"] === undefined ? when.notExists("runtimeBinding") : when.eq("runtimeBinding", latestRow["runtimeBinding"]));
      const base: TransactItem[] = [
        { kind: "check", key: catalogKey, condition: when.and(when.eq("entityType", "PROJECT_CATALOG"), when.eq("latestRevision", latest.definition.revision)) },
        { kind: "check", key: latestKey, condition: revisionCondition },
      ];
      let runtimeFences: TransactItem[];
      try {
        const selected = admission.runtimeBindings.map(({ value }) => {
          const kind = value.capabilities.kind;
          if (kind !== "web" && kind !== "api") throw new Error("a runtime of a kind this install does not run");
          return { kind, profileId: value.profileId };
        });
        runtimeFences = applicationRuntimeRowFences({ rows: current.rows, selected });
      } catch { return reject("the runtime rows this round was admitted on are not among the rows read now"); }
      const accountFences = accountRegistryFences({ orgId: deps.companyId, projectId: task.project, refs: current.selection.accountRefs, entries: [...current.accountEntries] });
      const checks: TransactItem[] = [...base, ...runtimeFences, ...accountFences];
      if (diagnostic !== undefined) diagnostic.authorityChecks = checks;
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _./:-]/gu, "?").slice(0, 120) : "unknown-error";
      return reject(`current-authority-loader-exception:${stage}:${detail || "empty-error"}`);
    }
  };
  return {
    // A portable feature round runs on a qualified runtime this install does not have; it is judged unverifiable.
    async portable(_input, diagnostic) { if (diagnostic !== undefined) diagnostic.reason = "no-current-authority-source"; return false; },
    application,
  };
}
