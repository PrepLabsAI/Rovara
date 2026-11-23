// Port of the application selection/readiness half of the retired broker. All reads are scoped to the task's company;
// selection is read-only and returns conditions for the caller's approval/admission transaction.
import { createHash } from "node:crypto";
import {
  E2EApplicationSelectionRecordSchema, E2EPolicySchema, E2ESetupProposalSchema, Ec2RuntimeBindingSchema, ProjectDefinitionSchema, WEB_API_RUNTIME_PROFILE_ID,
  WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, agentXError, canonicalJson, projectRevisionKey, verifyE2ESetupProposal, when,
  type E2EPolicy, type E2ESetupProposal, type E2ESourceSnapshot, type ObjectStorage, type OrgId, type PlanApprovalRef, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import { isExactFeatureE2ESourceSnapshot } from "../../e2e/feature-plan-planning-context.js";
import { evaluateApplicationPlanApproval, type ApplicationAccountsInput, type ApplicationPlanApprovalInput } from "../../e2e/application-plan-approval.js";
import { ApplicationDispatchRefusal, ApplicationPlanDefect, applicationAccountsRefusal, applicationRoundRefusal, applicationRuntimeRefusal, applicationSelectionStillCurrent } from "../../e2e/application-dispatch-check.js";
import { accountRegistryFences, readAccountRegistryEntries } from "./account-registry.js";
import { applicationRuntimeRowFences, readExpiredE2ERuntimes, readProjectAdmittedE2ERuntimes, runtimeRowReader } from "./runtime-readiness.js";
import { projectE2EBaselineWanted } from "./baseline.js";
import type { ApplicationE2ESeams, ApplicationTask } from "./application-seams.js";
import type { E2EStateStore } from "./state.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SETUP_MAX_BYTES = 24 * 1024 * 1024;
export interface ApplicationSelectionDeps { companyId: OrgId; state: E2EStateStore; objects: ObjectStorage; runtimeCatalogId: string }
export type ApplicationSelectionInputs = Pick<ApplicationPlanApprovalInput, "snapshot" | "setupProposal" | "setupApproval" | "policy" | "registeredRuntimes" | "runtimeCatalogId" | "runtimeBinding"> & {
  accountEntries: ApplicationAccountsInput["entries"];
};
export type CurrentApplicationSelection = Awaited<ReturnType<ApplicationE2ESeams["rounds"]["selection"]>> & { inputs: ApplicationSelectionInputs };

/** Decode the immutable setup artifact and reverify it against the exact registered project, policy and source identity. */
export async function readApprovedApplicationSetup(objects: ObjectStorage, project: StoredDocument, policy: E2EPolicy): Promise<{
  snapshot: E2ESourceSnapshot; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef;
}> {
  const refuse = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "The approved application setup source is unavailable or changed."); };
  const definition = ProjectDefinitionSchema.parse(project["definition"]);
  const repository = definition.repositories.length === 1 ? definition.repositories[0] : undefined;
  const approval = project["setupApproval"] as { decision?: unknown; proposalRef?: unknown; proposalSha256?: unknown; candidateDigest?: unknown } | undefined;
  if (repository === undefined || approval?.decision !== "approve" || typeof approval.proposalRef !== "string") return refuse();
  const bytes = await objects.get(approval.proposalRef, SETUP_MAX_BYTES);
  if (bytes === undefined || sha(bytes) !== approval.proposalSha256) return refuse();
  try {
    const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      schemaVersion?: unknown; issuerOwnerKey?: unknown; repositoryUrl?: unknown; policy?: unknown; identityMapping?: { registeredRepositoryId?: unknown };
      snapshot: Omit<E2ESourceSnapshot, "sources"> & { sources: Array<{ path: string; sha256: string; bytesBase64: string; kind: "blob" }> }; proposal?: unknown;
    };
    if (record.schemaVersion !== "project-setup-source-proposal/v1" || record.issuerOwnerKey !== project["registeredBy"] || record.repositoryUrl !== repository.url
      || canonicalJson(record.policy) !== canonicalJson(policy) || record.identityMapping?.registeredRepositoryId !== repository.name) return refuse();
    const snapshot: E2ESourceSnapshot = { ...record.snapshot, sources: record.snapshot.sources.map(({ bytesBase64, ...source }) => ({ ...source, bytes: Buffer.from(bytesBase64, "base64") })) };
    const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record.proposal), snapshot, snapshot.candidate);
    const parts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(repository.url);
    const repositoryId = parts?.[1] && parts[2] ? `${parts[1]}/${parts[2]}` : undefined;
    if (repositoryId === undefined || !isExactFeatureE2ESourceSnapshot(snapshot, repositoryId, snapshot.commitSha)
      || snapshot.candidate.digest !== approval.candidateDigest || proposal.candidateDigest !== approval.candidateDigest) return refuse();
    return { snapshot, setupProposal: proposal, setupApproval: { artifactId: `setup-proposal-${String(approval.proposalSha256)}`, digest: sha(Buffer.from(canonicalJson(proposal))) } };
  } catch { return refuse(); }
}

function refuseApplicationSelection(evaluation: Extract<ReturnType<typeof evaluateApplicationPlanApproval>, { ok: false }>, mode: ApplicationAccountsInput["mode"]): never {
  if (mode === "current") {
    if (evaluation.scope === "runtime") throw applicationRuntimeRefusal(evaluation.reason);
    if (evaluation.scope === "accounts") throw applicationAccountsRefusal(evaluation.reason);
    if (evaluation.scope === "plan") throw new ApplicationPlanDefect(evaluation.reason);
    throw new ApplicationDispatchRefusal(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}${evaluation.reason}`);
  }
  throw agentXError("CONFIG_INVALID", `The application E2E plan cannot be approved: ${evaluation.reason}`);
}

/** Q1's approval and Q2's dispatch use the same live evaluator. No task or selection is written here. */
export function createApplicationSelectionReader(deps: ApplicationSelectionDeps) {
  const selection = async (...[task, intent, artifact, accounts]: Parameters<ApplicationE2ESeams["rounds"]["selection"]>): Promise<CurrentApplicationSelection> => {
    if (task.companyId !== deps.companyId) throw agentXError("RUNTIME_UNAVAILABLE", "The application project is unavailable in this company.");
    const key = projectRevisionKey(deps.companyId, task.project, task.startingRevision);
    const project = await deps.state.store.get(key);
    const definition = ProjectDefinitionSchema.safeParse(project?.["definition"]);
    if (project === undefined || !definition.success || definition.data.name !== task.project || definition.data.revision !== task.startingRevision) {
      throw agentXError("RUNTIME_UNAVAILABLE", "The pinned application project revision is unavailable.");
    }
    const policy = E2EPolicySchema.parse(definition.data.e2e);
    const runtimeBinding = Ec2RuntimeBindingSchema.parse(project["runtimeBinding"]);
    const setup = await readApprovedApplicationSetup(deps.objects, project, policy);
    const now = (deps.state.now?.() ?? new Date()).getTime();
    const runtimeInput = { runtimeCatalogId: deps.runtimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, binding: runtimeBinding, now, read: runtimeRowReader(deps.state.store) };
    const rows = await readProjectAdmittedE2ERuntimes(runtimeInput);
    const expiredRuntimes = rows.length >= 2 ? [] : await readExpiredE2ERuntimes(runtimeInput);
    const accountsRead = await readAccountRegistryEntries(deps.state, deps.companyId, task.project,
      intent.applicationRuntimeRefs.map((ref) => ({ applicationId: ref.applicationId, profileId: ref.accountProfileId })));
    if (accountsRead.corrupt.length > 0) throw applicationAccountsRefusal("The registered test accounts cannot be read; register the project's setup again.");
    const evaluation = evaluateApplicationPlanApproval({ intent, taskId: task.taskId, artifact, ...setup, policy, registeredRuntimes: rows,
      runtimeCatalogId: deps.runtimeCatalogId, runtimeBinding, now, expiredRuntimes, accounts: { ...accounts, entries: accountsRead.entries } });
    if (!evaluation.ok) refuseApplicationSelection(evaluation, accounts.mode);
    const items: TransactItem[] = [
      { kind: "check", key, condition: when.and(when.eq("definition", project["definition"]!), when.eq("setupApproval", project["setupApproval"]!),
        when.eq("runtimeBinding", project["runtimeBinding"]!), when.eq("registeredBy", project["registeredBy"]!)) },
      ...applicationRuntimeRowFences({ rows, selected: evaluation.selection.runtimeRows }),
      ...accountRegistryFences({ orgId: deps.companyId, projectId: task.project, refs: evaluation.accountRefs, entries: accountsRead.entries }),
    ];
    return { selection: evaluation.selection, items, baselineWanted: projectE2EBaselineWanted({ definition: definition.data }),
      inputs: { ...setup, policy, registeredRuntimes: rows, runtimeCatalogId: deps.runtimeCatalogId, runtimeBinding, accountEntries: accountsRead.entries } };
  };
  const current = async (task: ApplicationTask, intent: ApplicationPlanApprovalInput["intent"], artifact: ApplicationPlanApprovalInput["artifact"]): Promise<CurrentApplicationSelection> => {
    const recorded = E2EApplicationSelectionRecordSchema.safeParse(task.workflow.e2e?.applicationSelection);
    if (!recorded.success) throw applicationRoundRefusal("The approved plan has no recorded application selection.");
    const result = await selection(task, intent, artifact, { mode: "current", pinned: recorded.data.accountRefs });
    const unchanged = applicationSelectionStillCurrent(recorded.data, result.selection);
    if (!unchanged.ok) throw new ApplicationDispatchRefusal(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}${unchanged.reason}`);
    return result;
  };
  return { selection, current };
}
