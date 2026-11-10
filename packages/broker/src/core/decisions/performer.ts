// Decision cards: the performer that turns a card's approve, reject or request-changes into a decision and says truthfully what happened: done (the gate decided), or refused (a fixed reason).
// It adds no authority of its own. The approval gate (approval-gate.ts) checks the proof, the revision and the digest again, whatever the card or a client said, and a kind with no handler is refused as
// `unsupported`. The merge, spend, test-environment, environment-change and fix-setup handlers of the hosted product are not here: merge belongs to the merge lane (L7a, which writes its own handler on
// `KindHandler`), and the rest depend on Cloud-only budgets, members and company locks or on later lanes.
import { AgentXError, type DecisionKind, type DecisionRefusalReason } from "@agentx/contracts";
import { WORKFLOW_DOCUMENT_KIND, type WorkflowDecisionDetails } from "./workflow-subject.js";
import type { Credential, DecisionGate, GateRefusalReason } from "./approval-gate.js";
import type { DecisionCaller, DecisionPerformer, PerformInput, PerformOutcome } from "./routes.js";

export type KindHandler<C extends DecisionCaller> = {
  approve(caller: C, input: PerformInput): Promise<PerformOutcome>;
  reject?(caller: C, input: PerformInput & { reason: string }): Promise<PerformOutcome>;
  /** Slice 2: send the document back with the person's reason (the workflow decision's REQUEST_CHANGES). */
  requestChanges?(caller: C, input: PerformInput & { reason: string }): Promise<PerformOutcome>;
};

/** A performer from per-kind handlers. A kind without one, or a reject the kind cannot do, is refused (`unsupported`): the person decides on the page. */
export function createDecisionPerformer<C extends DecisionCaller>(handlers: Partial<Record<DecisionKind, KindHandler<C>>>): DecisionPerformer<C> {
  return {
    async approve(caller, input) {
      const handler = handlers[input.card.kind];
      return handler === undefined ? { kind: "refused", reason: "unsupported" } : handler.approve(caller, input);
    },
    async reject(caller, input) {
      const handler = handlers[input.card.kind];
      return handler?.reject === undefined ? { kind: "refused", reason: "unsupported" } : handler.reject(caller, input);
    },
    async requestChanges(caller, input) {
      const handler = handlers[input.card.kind];
      return handler?.requestChanges === undefined ? { kind: "refused", reason: "unsupported" } : handler.requestChanges(caller, input);
    },
  };
}

/** What an endpoint's own refusal means to the card: only the fixed codes the cards know; anything else is the endpoint's to say and goes on as it is. */
export function refusalOf(error: unknown): DecisionRefusalReason | undefined {
  if (!(error instanceof AgentXError)) return undefined;
  if (error.code === "FORBIDDEN" || error.code === "TASK_ACCESS_DENIED" || error.code === "PROJECT_ACCESS_DENIED") return "forbidden";
  if (error.code === "MERGE_NOT_READY") return /now (low|medium|high)\b/u.test(error.message) || error.message.includes("changed after you confirmed") ? "stale" : "not_ready";
  if (error.code === "CHANGE_STALE" || error.code === "POLICY_STALE") return "stale";
  return undefined;
}

/** Runs an endpoint and maps its refusals; any other error goes on unchanged. */
export async function perform(run: () => Promise<PerformOutcome>): Promise<PerformOutcome> {
  try { return await run(); } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return { kind: "refused", reason };
  }
}

/** What each way the gate refuses means to a card. A proof the adapter will not accept is "forbidden", whoever sent it. */
export const CARD_REFUSAL_OF_GATE: Readonly<Record<GateRefusalReason, DecisionRefusalReason>> = {
  unsupported: "unsupported", invalid: "unsupported", not_found: "stale", not_waiting: "stale", stale: "stale", expired: "stale",
  method_not_allowed: "forbidden", not_approved: "forbidden", not_the_approver: "forbidden", proof_already_used: "forbidden", request_id_reused: "forbidden",
  self_approval_not_allowed: "second_person_required", needs_more_approvers: "second_person_required", invalid_outcome: "not_ready", sign_in_not_fresh: "forbidden",
};

/** The card kinds that `workflowDocumentHandler` decides: the documents a task's workflow waits on. A Code install mounts the card routes with these as `highOnCard` and `evidenceFirstOnHigh` (the gate itself asks for the local session on a high card). */
export const WORKFLOW_DOCUMENT_CARD_KINDS: readonly DecisionKind[] = ["approve_requirements", "approve_plan", "approve_design"];

/** A card's caller in Code: who is asking (as the route knows them) and the proofs the surface collected (the local session's, or a code host comment's). */
export interface ProvingCaller extends DecisionCaller {
  credentials: readonly Credential[];
}

/** The artifact digest a card was drawn from: its content version, up to the colon a design review adds. */
export function cardArtifactDigest(contentVersion: string): string {
  return contentVersion.split(":")[0]!;
}

/**
 * Approve, reject and request changes for a requirements, design or coding plan card, through the approval gate. The card names the digest it was drawn from; the revision is the one its source read when it drew the card (`binding`). The gate checks both against the stored state again, and the write carries the revision as a condition.
 */
export function workflowDocumentHandler<C extends ProvingCaller>(gate: DecisionGate): KindHandler<C> {
  const run = (outcome: "approve" | "reject" | "request_changes") => async (caller: C, input: PerformInput & { reason?: string }): Promise<PerformOutcome> => {
    const taskId = input.item.taskId;
    if (taskId === undefined) return { kind: "refused", reason: "unsupported" };
    // The card must carry what it was drawn from (the revision and the document digest, read by its source). A card without them is refused: a click on an old view must never become a click on the current one.
    const binding = input.item.binding;
    if (binding === undefined || cardArtifactDigest(input.item.contentVersion) !== binding.artifactDigest) return { kind: "refused", reason: "stale" };
    const artifactDigest = binding.artifactDigest;
    const plan = input.plan;
    const details: WorkflowDecisionDetails = {
      ...(plan?.answers === undefined ? {} : { answers: plan.answers }), ...(plan?.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: plan.selectedOptionalCheckIds }),
      ...(plan?.includedCommentIds === undefined ? {} : { includedCommentIds: plan.includedCommentIds }),
      ...(input.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: input.acknowledgedRunLimitUsd }),
    };
    const result = await gate.decide({
      companyId: caller.orgId, kind: WORKFLOW_DOCUMENT_KIND, subjectId: taskId, requestId: input.requestId, outcome,
      seen: { revision: binding.revision, artifactDigest }, credentials: caller.credentials,
      ...((input.reason ?? plan?.note) === undefined ? {} : { reason: (input.reason ?? plan?.note) as string }), details,
    });
    if (result.status === "refused") return { kind: "refused", reason: CARD_REFUSAL_OF_GATE[result.reason] };
    return { kind: "done" };
  };
  return { approve: run("approve"), reject: run("reject"), requestChanges: run("request_changes") };
}
