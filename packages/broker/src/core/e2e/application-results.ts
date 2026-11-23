// Port of the retired broker's presentation/detail, display capture and artifact readers.
// Route callers enforce access; these leaves never write the task or grant a verdict.
import { CandidateManifestSchema, buildE2ESharedView, canonicalJson, type E2EScenarioResults, type E2ESharedView } from "@agentx/contracts";
import type { ApplicationE2ESeams, ApplicationTask } from "./application-seams.js";
import type { E2EVerificationDeps } from "./authority.js";
import type { OperationRecord } from "../task-flow/records.js";
import { verifyWorkflowE2EEvidence, type WorkflowE2EProjection } from "./verification.js";
import { applicationResultsPresentation, closedApplicationResults, unavailableApplicationView } from "../../core-host/e2e-results.js";
import { applicationE2ENotice } from "./application-notices.js";
import { loadStoredScenarioResults, loadStoredWorkflowDisplay, loadWorkflowE2EArtifact, putContentAddressed, resultsWithStoredArtifacts, storeWorkflowE2EArtifacts } from "./artifacts.js";
import { readWorkflowE2EBaseline } from "./baseline.js";
import { createWorkflowE2EDisplayObject } from "../../aws/workflow-e2e-notifier-projection.js";
import { scrubScenarioResults } from "../../e2e/application-display.js";

export interface ApplicationResultsDeps extends E2EVerificationDeps {
  operations(task: ApplicationTask): Promise<readonly OperationRecord[]>;
  /** Bound verifier port; hosted composition uses the production verifier by default. */
  verify?: typeof verifyWorkflowE2EEvidence;
}

function currentOperation(task: ApplicationTask, operation: OperationRecord): boolean {
  const progress = task.workflow.e2e;
  const admission = operation.workflowE2EAdmission;
  return task.closedAt === undefined && task.workflow.stage !== "IMPLEMENT" && progress?.required === true && task.workflow.candidate !== undefined
    && operation.companyId === task.companyId && operation.workspaceId === task.workspaceId && operation.kind === "task" && operation.workflowMode === "CHECKS"
    && admission !== undefined && admission.purpose === undefined
    && admission.taskId === task.taskId && admission.candidateDigest === task.workflow.candidate.digest && admission.roundId === progress.currentRoundId
    && canonicalJson(admission.groupRunIds) === canonicalJson(progress.currentGroupRunIds)
    && (operation.workflowE2EEvidenceRef !== undefined || (operation.workflowE2EGroupEvidenceRefs?.length ?? 0) > 0);
}

async function detailed(deps: ApplicationResultsDeps, task: ApplicationTask, operation: OperationRecord, actor: "owner" | "viewer", status?: "SUCCEEDED" | "FAILED") {
  const candidate = CandidateManifestSchema.safeParse(task.workflow.candidate);
  if (!candidate.success || !currentOperation(task, operation)) return undefined;
  const projection: WorkflowE2EProjection = { results: [] };
  await (deps.verify ?? verifyWorkflowE2EEvidence)(deps, operation, task, candidate.data, projection, undefined, status === undefined ? undefined : { terminalStatus: status });
  if (projection.plan === undefined || projection.round === undefined) return undefined;
  const plan = projection.plan as { digest?: unknown; effectiveTargets?: Array<{ targetId?: unknown }> };
  if (typeof plan.digest !== "string" || !Array.isArray(plan.effectiveTargets) || plan.effectiveTargets.some((target) => typeof target.targetId !== "string")) return undefined;
  const shared = buildE2ESharedView({ plan: projection.plan, currentRound: projection.round, results: projection.results,
    setup: { status: "unavailable", selectedTargetIds: plan.effectiveTargets.map((target) => target.targetId), executionPlanDigest: plan.digest, blockingInputIds: [], mockSubstitutableInputIds: [] },
    actor, control: { policyPresent: true, workflowPhase: "e2e", ownerActionProposals: [] } });
  return { shared, display: projection.display };
}

export function createApplicationResults(deps: ApplicationResultsDeps): ApplicationE2ESeams["results"] {
  const baseline = (task: ApplicationTask) => readWorkflowE2EBaseline(deps.state, task, deps.state.now?.().getTime()).catch(() => undefined);
  const read: ApplicationE2ESeams["results"]["read"] = async (task, actor) => {
    if (task.workflow.e2e?.required !== true) return undefined;
    if (task.closedAt !== undefined) return closedApplicationResults(task.taskId, await loadStoredWorkflowDisplay(deps, task));
    let shared: E2ESharedView = unavailableApplicationView(task.closedAt !== undefined);
    const stored = await loadStoredScenarioResults(deps, task);
    const base = await baseline(task);
    const scenarioResults: E2EScenarioResults | undefined = stored === undefined && base === undefined ? undefined
      : scrubScenarioResults({ scenarios: stored?.scenarios ?? [], ...((base ?? stored?.baseline) === undefined ? {} : { baseline: base ?? stored?.baseline }) });
    for (const operation of await deps.operations(task)) {
      if (!currentOperation(task, operation)) continue;
      const result = await detailed(deps, task, operation, actor);
      if (result !== undefined) shared = result.shared;
      break;
    }
    const presentation = applicationResultsPresentation(task.taskId, shared, scenarioResults);
    return { presentation, ...(scenarioResults === undefined ? {} : { scenarioResults }) };
  };
  return {
    read,
    async project(task, operation, status) {
      if (!currentOperation(task, operation) || operation.workflowE2EEvidenceRef === undefined) return undefined;
      try {
        const result = await detailed(deps, task, operation, "viewer", status);
        if (result === undefined) return undefined;
        const rows = result.display;
        const base = await baseline(task);
        const stored = await storeWorkflowE2EArtifacts(deps, task, rows?.artifacts ?? []).catch(() => new Set<string>());
        const scenarioResults = rows === undefined || rows.scenarios.length === 0 ? undefined
          : { ...resultsWithStoredArtifacts({ scenarios: [...rows.scenarios] }, stored), ...(base === undefined ? {} : { baseline: base }) };
        const admission = operation.workflowE2EAdmission!;
        const display = createWorkflowE2EDisplayObject({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, capturedAt: (deps.state.now?.() ?? new Date()).toISOString(), view: result.shared,
          ...(scenarioResults === undefined ? {} : { scenarioResults }), current: { candidateDigest: task.workflow.candidate!.digest, roundId: admission.roundId,
            groupRunIds: [...admission.groupRunIds], admissionSha256: admission.admissionRef.sha256, evidenceSha256: operation.workflowE2EEvidenceRef.sha256 } });
        if (display === undefined) return undefined;
        const kept = await putContentAddressed(deps.objects, display.ref.key, display.bytes,
          { contentType: "application/json", metadata: { sha256: display.ref.sha256 }, retention: "task-document" });
        return kept ? display.ref : undefined;
      } catch { return undefined; } // Display storage never changes the candidate's verdict.
    },
    async artifact(task, sha256) {
      const base = await baseline(task);
      return loadWorkflowE2EArtifact(deps, task, sha256, base === undefined ? {} : { baseline: base });
    },
    notice: (task, taskPageUrl) => applicationE2ENotice(deps.objects, task, taskPageUrl),
  };
}
