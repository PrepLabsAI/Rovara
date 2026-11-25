import { taskGraphDigest } from "@agentx/contracts";

export interface WorkflowE2ECanonicalPlanInput {
  taskId: string;
  workflow: {
    e2e?: { contractDigest?: string } | undefined;
    artifacts: Array<{ id: string; type: string; sha256: string }>;
    decisions: Array<{ decision: string; actorId: string; actorRole?: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }>;
    workflowDependenciesApproval?: { artifactDigest: string; graphDigest: string; runId: string; workflowRevision: number; actorId: string } | undefined;
  };
  artifact: { id: string; type: string; sha256: string };
  plan: { e2e?: unknown; workBreakdown?: unknown };
}

export interface WorkflowE2ECanonicalApproval {
  artifactId: string;
  artifactDigest: string;
  graphDigest: string | null;
  runId: string | null;
  workflowRevision: number;
  actorId: string;
}

/** Resolves only the latest canonical plan artifact and its exact normal owner decision. */
export function resolveWorkflowE2ECanonicalApproval(input: WorkflowE2ECanonicalPlanInput): WorkflowE2ECanonicalApproval | undefined {
  const { taskId, workflow, artifact, plan } = input;
  const plans = workflow.artifacts.filter((entry) => entry.type === "plan");
  const latest = plans.at(-1);
  if (latest === undefined || latest.id !== artifact.id || latest.sha256 !== artifact.sha256
    || workflow.e2e?.contractDigest !== artifact.sha256 || artifact.type !== "plan" || plan.e2e === undefined) return undefined;
  if (plan.workBreakdown === undefined) {
    const eligible = workflow.decisions.filter((entry) => entry.decision === "APPROVE" && entry.artifactDigest === artifact.sha256
      && entry.workBreakdownDigest === undefined && ["TASK_OWNER", "PROJECT_ADMIN"].includes(entry.actorRole ?? ""));
    const latestRevision = eligible.reduce((latest, entry) => Math.max(latest, entry.workflowRevision), -1);
    const latest = eligible.filter((entry) => entry.workflowRevision === latestRevision);
    if (latest.length !== 1) return undefined;
    const decision = latest[0]!;
    if (workflow.workflowDependenciesApproval !== undefined || decision.workBreakdownDigest !== undefined) return undefined;
    return { artifactId: artifact.id, artifactDigest: artifact.sha256, graphDigest: null, runId: null,
      workflowRevision: decision.workflowRevision, actorId: decision.actorId };
  }
  const stored = workflow.workflowDependenciesApproval;
  if (stored === undefined || stored.artifactDigest !== artifact.sha256) return undefined;
  const matchingDecisions = workflow.decisions.filter((entry) => entry.decision === "APPROVE" && entry.actorId === stored.actorId
    && entry.artifactDigest === artifact.sha256 && entry.workBreakdownDigest === stored.graphDigest
    && entry.workflowRevision === stored.workflowRevision && ["TASK_OWNER", "PROJECT_ADMIN"].includes(entry.actorRole ?? ""));
  if (matchingDecisions.length !== 1) return undefined;
  const decision = matchingDecisions[0]!;
  let graphDigest: string;
  if (typeof plan.workBreakdown !== "object" || plan.workBreakdown === null
    || (plan.workBreakdown as { taskId?: unknown }).taskId !== taskId) return undefined;
  try { graphDigest = taskGraphDigest(plan.workBreakdown as never); } catch { return undefined; }
  if (stored.graphDigest !== graphDigest
    || stored.actorId !== decision.actorId || stored.workflowRevision !== decision.workflowRevision
    || decision.workBreakdownDigest !== graphDigest || !stored.runId) return undefined;
  return { artifactId: artifact.id, artifactDigest: artifact.sha256, graphDigest, runId: stored.runId,
    workflowRevision: decision.workflowRevision, actorId: decision.actorId };
}


