// Which plan is approved. A spec is written only from a plan a person approved, and is judged against the same one.
import type { WorkflowSnapshot } from "@agentx/contracts";

/** The digest of the task's latest plan, when a person's approval names it (the broker's own automatic decisions are never an approval). Undefined otherwise. */
export function approvedPlanDigestOf(task: { workflow?: Pick<WorkflowSnapshot, "artifacts" | "decisions"> | undefined } | undefined): string | undefined {
  const workflow = task?.workflow;
  if (workflow === undefined) return undefined;
  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined) return undefined;
  const decided = workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === plan.sha256 && decision.actorRole !== "AGENTX");
  return decided ? plan.sha256 : undefined;
}
