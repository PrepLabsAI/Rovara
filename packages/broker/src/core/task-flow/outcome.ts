// Lane L6a, task flow core: what the worker's terminal result meant, already read. The callback layer reads the worker's artifacts and checks them
// (Cloud's `aws/broker/terminal-result.ts`, not ported here: there is no object-storage port yet) and hands the flow one of these.
import type { WorkflowArtifact, WorkflowCheckProposal, WorkflowReviewBase } from "@agentx/contracts";

export type StepOutcome =
  /** The workspace is prepared; `base` is the commit each repository was checked out at. */
  | { kind: "prepared"; base?: WorkflowReviewBase }
  /** Understand's assessment as the broker checked it; an answer also names the file it was read from. */
  | { kind: "understood"; assessment: unknown; answerArtifact?: { id: string; objectKey: string; createdAt: string } }
  /** A planning run's document. */
  | { kind: "planned"; artifact: WorkflowArtifact; proposal?: WorkflowCheckProposal; noChangeNeeded?: boolean }
  /** A run that needs no workflow move. */
  | { kind: "ended" };

export interface OperationResult {
  workspaceId: string;
  operationId: string;
  /** The fence on the worker's capability; a result for another fence is refused. */
  fence: number;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  error?: string;
  outcome?: StepOutcome;
}
