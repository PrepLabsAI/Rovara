// The hosted afterPlanStored seam uses the laptop's resolver and immutable pointer, held to this company's workspace.
import type { ObjectStorage } from "@agentx/contracts";
import { attachCitedCode, planDocumentPrefix } from "../core/plan/store.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { artifactKeyScopeOf, workspaceHoldingKey } from "./company-artifact-reader.js";

export function hostedPlanEvidence(deps: TaskFlowDeps, blobs: Pick<ObjectStorage, "put" | "get">): NonNullable<TaskFlowDeps["afterPlanStored"]> {
  return async (input) => {
    const prefix = planDocumentPrefix(input.task, input.artifactId);
    const artifact = input.workflow.artifacts.find((entry) => entry.id === input.artifactId);
    if (input.task.companyId !== deps.companyId || input.prefix !== prefix || artifact?.objectKey !== `${prefix}.json`) return;
    const scope = artifactKeyScopeOf(`${prefix}.json`);
    if (scope === undefined || scope.form !== "owner") return;
    if (typeof await workspaceHoldingKey({ store: deps.store, companyId: deps.companyId }, scope) === "string") return;
    await attachCitedCode(deps, blobs, input);
  };
}
