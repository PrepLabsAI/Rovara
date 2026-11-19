// What counts as a person's send-back in a task's decision history, in ONE place. Both ways of sending a task back to coding count: the plain "send it back" (source SEND_BACK) and a
// resolve-findings decision with at least one finding to fix (source FINDINGS, decision REQUEST_CHANGES; accepting every finding is an approval and returns nothing to coding). Rovara's own sends back (AGENTX actor,
// source AUTO_FIX / AUTO_RETRY / GATE) are never a person's. The announcement's round number (`announceTaskSendBack`) and the reflector's list of send-back requests (`lesson-subject-source.ts`) both use this, so a
// round is never repeated and a send-back whose row was written is the one the reflector reads.
import type { WorkflowSnapshot } from "@agentx/contracts";

type Decision = WorkflowSnapshot["decisions"][number];

export function isHumanSendBack(decision: Pick<Decision, "source" | "decision" | "actorRole">): boolean {
  if (decision.actorRole === "AGENTX") return false;
  return decision.source === "SEND_BACK" || (decision.source === "FINDINGS" && decision.decision === "REQUEST_CHANGES");
}

/** How many human send-backs the task's decisions hold. */
export const humanSendBackCount = (workflow: Pick<WorkflowSnapshot, "decisions">): number => workflow.decisions.filter(isHumanSendBack).length;
