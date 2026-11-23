// Required-E2E begins with approval of the stored plan. This leaf returns conditions; it never writes a task or patches an approval afterwards.
import { E2EApplicationSelectionRecordSchema, E2EPolicySchema, WorkflowSnapshotSchema, agentXError, canonicalJson, e2ePolicyDigest, e2eScenarioBundleDigest, type E2EApplicationSelectionRecord } from "@agentx/contracts";
import { applicationIntentDigest } from "../../e2e/application-plan-approval.js";
import { loadPlanDocument } from "../plan/document.js";
import type { ArtifactReader, ProjectSource } from "../task-flow/deps.js";
import { sha256Of } from "../plan/store.js";
import type { ApplicationE2ESeams } from "./application-seams.js";

export interface ApplicationApprovalPorts {
  artifacts?: ArtifactReader | undefined;
  projects: Pick<ProjectSource, "revision">;
  selection?: ApplicationE2ESeams["rounds"]["selection"] | undefined;
}

export function createApplicationApproval(deps: ApplicationApprovalPorts): ApplicationE2ESeams["planning"]["approve"] {
  return async ({ task, before, after, artifact }) => {
    if (artifact.type !== "plan" || after.stage !== "IMPLEMENT") return { workflow: after, items: [] };
    const approved = after.decisions.at(-1);
    if (approved?.decision !== "APPROVE" || approved.artifactDigest !== artifact.sha256
      || !before.artifacts.some((entry) => entry.id === artifact.id && entry.sha256 === artifact.sha256)) {
      throw agentXError("CONFIG_INVALID", "the E2E obligation must bind the plan the owner approved");
    }
    if (artifact.format !== "structured") return { workflow: after, items: [] };
    const loaded = await loadPlanDocument(deps.artifacts, artifact);
    if (loaded.kind !== "structured") throw agentXError("RUNTIME_UNAVAILABLE", "the approved plan could not be read and checked; nothing was approved");
    const intent = loaded.plan.e2e;
    if (intent === undefined) return { workflow: after, items: [] };
    const project = await deps.projects.revision(task.project, task.startingRevision);
    const policy = E2EPolicySchema.safeParse(project?.definition.e2e);
    if (!policy.success) throw agentXError("RUNTIME_UNAVAILABLE", "the approved feature E2E intent has no pinned project policy");
    let applicationSelection: E2EApplicationSelectionRecord | undefined;
    let items: Awaited<ReturnType<NonNullable<ApplicationApprovalPorts["selection"]>>>["items"] = [];
    if (intent.schemaVersion === 2) {
      if (deps.selection === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the application E2E plan cannot be checked for approval; nothing was approved");
      const selected = await deps.selection(task, intent, { id: artifact.id, sha256: artifact.sha256 }, { mode: "approve", pinned: [] });
      applicationSelection = E2EApplicationSelectionRecordSchema.parse(selected.selection);
      if (selected.items.length === 0 || applicationSelection.semanticApproval.artifactId !== artifact.id
        || applicationSelection.semanticApproval.digest !== artifact.sha256 || applicationSelection.intentDigest !== applicationIntentDigest(intent)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "the application E2E selection is not bound to the approved plan and current authority");
      }
      items = selected.items;
    }
    const bundleDigest = e2eScenarioBundleDigest({ schemaVersion: 1, planDigest: artifact.sha256, templateVersion: "trusted-e2e/v1", scenarios: intent.scenarios, bundleDigest: "0".repeat(64) });
    const executionPlanDigest = sha256Of(canonicalJson({ domain: "workflow-e2e-approved-intent/v1", artifactDigest: artifact.sha256, intent }));
    const workflow = WorkflowSnapshotSchema.parse({ ...after, e2e: { required: true, contractDigest: artifact.sha256, policyDigest: e2ePolicyDigest(policy.data),
      bundleDigest, executionPlanDigest, currentGroupRunIds: [], resultRefs: [], ...(applicationSelection === undefined ? {} : { applicationSelection }) } });
    return { workflow, items };
  };
}
