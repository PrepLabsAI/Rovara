import { createHash } from "node:crypto";
import { TaskClosePreviewSchema, type TaskClosePreview } from "@agentx/contracts";

export type TaskClosePreviewFacts = Omit<TaskClosePreview, "digest"> & { companyId: string; workspaceId: string; actorId: string };
const REASONS = ["worktree_changes", "untracked_files", "unpushed_head", "unpushed_branch"] as const;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function canonical(facts: TaskClosePreviewFacts): Omit<TaskClosePreview, "digest"> {
  const parsed = TaskClosePreviewSchema.parse({
    action: facts.action, taskId: facts.taskId, digest: "0".repeat(64), taskStatus: facts.taskStatus,
    workflow: facts.workflow, workspace: facts.workspace, unpublished: facts.unpublished, inspection: facts.inspection,
  });
  return {
    action: parsed.action, taskId: parsed.taskId, taskStatus: parsed.taskStatus,
    workflow: parsed.workflow === null ? null : { revision: parsed.workflow.revision, stage: parsed.workflow.stage, state: parsed.workflow.state },
    workspace: { status: parsed.workspace.status, fence: parsed.workspace.fence, activeOperationId: parsed.workspace.activeOperationId },
    unpublished: [...parsed.unpublished].sort((a, b) => compare(a.repository, b.repository)).map((r) => ({ repository: r.repository, reasons: [...r.reasons].sort((a, b) => REASONS.indexOf(a) - REASONS.indexOf(b)) })),
    inspection: parsed.inspection === null ? null : { operationId: parsed.inspection.operationId, workspaceFence: parsed.inspection.workspaceFence, contentDigest: parsed.inspection.contentDigest },
  };
}

export function taskClosePreviewDigest(facts: TaskClosePreviewFacts): string {
  for (const scope of [facts.companyId, facts.workspaceId, facts.actorId]) if (typeof scope !== "string" || scope.length === 0) throw new Error("close preview scope is required");
  return createHash("sha256").update(JSON.stringify({ companyId: facts.companyId, workspaceId: facts.workspaceId, actorId: facts.actorId, ...canonical(facts) })).digest("hex");
}

export function buildTaskClosePreview(facts: TaskClosePreviewFacts): TaskClosePreview {
  return { ...canonical(facts), digest: taskClosePreviewDigest(facts) };
}
