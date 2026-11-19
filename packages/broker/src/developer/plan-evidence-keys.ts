// What a stored plan's cited code needs to be found: where each repository is read from, whether the plan cites code at all, and where the late evidence is recorded. Pure: contracts only, so a Code install
// reads and writes them without loading any cloud client. `plan-evidence-jobs.ts` re-exports them for the hosted product.
import type { PlanClaim, PlanDocument, WorkflowReviewBase } from "@agentx/contracts";

/** Where a task's cited code is read from: the project's repositories and the commit each started at (`reviewBase` once pinned, else the prepared base). */
export const planEvidenceSources = (
  project: { definition: { repositories: ReadonlyArray<{ name: string; path: string; url: string }> } },
  task: { workflow?: { reviewBase?: WorkflowReviewBase | undefined } | undefined; preparedBase?: WorkflowReviewBase | undefined },
) => ({
  repositories: project.definition.repositories.map((repository) => ({ name: repository.name, path: repository.path, url: repository.url })),
  base: task.workflow?.reviewBase ?? task.preparedBase,
});

const flatten = (claims: readonly PlanClaim[]): PlanClaim[] => claims.flatMap((claim) => [claim, ...flatten(claim.children ?? [])]);

/** Whether the plan cites at least one place in the code: only then is there anything to read. */
export const planCitesCode = (plan: PlanDocument): boolean =>
  flatten(plan.claims).some((claim) => (claim.evidence ?? []).some((item) => item.kind === "code"));

/**
 * Where a stored plan's late evidence is recorded. It is its own item beside the task, not part of the workflow map:
 * the workflow is rewritten whole by owner decisions and notices, and a pointer inside it would be lost by any writer
 * that read the task before the attach. Only `attachEvidence` writes this item, and it writes it once.
 */
export interface PlanEvidencePointer {
  pk: string;
  sk: string;
  entityType: "PLAN_EVIDENCE_POINTER";
  artifactId: string;
  artifactSha256: string;
  objectKey: string;
  sha256: string;
  attachedAt: string;
}

export const planEvidencePointerKey = (taskId: string, artifactId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `PLAN_EVIDENCE#${artifactId}` });

