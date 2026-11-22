import { agentXError } from "@agentx/contracts";
import { approvedCodingPlan } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";

export async function feedbackRequirements(deps: TaskFlowDeps, task: TaskRecord): Promise<string> {
  const workflow = task.workflow!;
  const plan = workflow.artifacts.filter(a => a.type === "plan").at(-1);
  if (plan === undefined || !plan.objectKey.startsWith(`private/${task.ownerKey}/${task.workspaceId}/`)
    || !workflow.decisions.some(d => d.decision === "APPROVE" && d.artifactDigest === plan.sha256)) throw agentXError("CONFIG_INVALID", "The feedback review needs the task's approved requirements.");
  const approved = await approvedCodingPlan(deps.artifacts, workflow);
  const last = workflow.feedbackReviewHistory?.filter(r => r.status === "COMPLETE").at(-1)?.recordedAt;
  const notes = (workflow.feedbackNotes ?? []).filter(n => last === undefined || n.at > last).map(n => n.text).join("\n");
  const text = `${approved.text}\n\nOwner notes:\n${notes}`;
  if (Buffer.byteLength(text, "utf8") > 200_000) throw agentXError("CONFIG_INVALID", "The feedback requirements exceed their input limit.");
  return text;
}
