// Design review stage: what the broker makes of a design-review operation that SUCCEEDED, and records on the task. The worker's upload is read as DATA:
//
//   - the keys come from the rows the broker wrote when it minted them (`designReviewKeyIds`), never from the worker; a slot with no key, or one asked twice, has no result;
// - `verifyRound` checks each report against the binding's packet digest and the slot's key (`digest_only` until gives the proxy a first-call reader);
//   - `assembleRoundFindings` loops over the BINDING's reviewers (exactly one outcome per role, a matching key slot), counts a reviewer only if it was verified, answered and its answer reads again, and checks every citation
//     against THAT reviewer's own stored packet and the broker's own pins;
//   - the broker adds its own findings (`withOwnFindings`), after dropping a reviewer finding that has the fingerprint of one of them (N6);
//   - each `ReviewerRun` is built from the verified facts and the proxy-MEASURED spend (`recordedReviewerCost`): a slot that was asked again, or whose spend could not be measured, is charged its key's budget, so the cap is
//     never under-counted;
// - every slot key is blocked and finalized FIRST, then the spend is measured ; `submitDesignReview` moves the workflow; the stored packets are removed by Delete items in the caller's commit, so a result that is computed
//     again finds them and records the same round.
//
// The worker's own `findings`, `droppedCitations`, `mergeSource` and `omitted` are display-only early feedback. They are read by the schema and never stored or believed.
import {
  DesignReviewBindingSchema, DesignReviewWorkerResultSchema, PacketDeliverySchema, ReviewerRunSchema, WorkflowTransitionError, closeDesignReview, itemOf, promptDigest, submitDesignReview,
  type CitablePacketItem, type DesignReviewBinding, type DesignReviewWorkerResult, type OrgId, type ReviewerPacketItem, type ReviewerRole, type ReviewerRun, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { DocumentStore, TransactItem } from "@agentx/contracts";
import type { OperationRecord } from "../task-flow/records.js";
import { recordedReviewerCost } from "./estimate.js";
import { bindingMergeProblem } from "./merge-binding.js";
import { lostBlockerFindings, ownDesignFindings, withOwnFindings } from "./own-findings.js";
import { estimateInputTokens } from "./packet.js";
import { packetDeleteItems, readSlotPacket, removeSlotPackets } from "./packet-store.js";
import { reviewerPromptFor, promptRecord } from "./prompts/index.js";
import { assembleRoundFindings, type RoundReviewerState } from "./round-findings.js";
import { requirementIdsOf } from "./round-inputs.js";
import { designReviewKeyIds, type DesignReviewKeyIds } from "./slot-keys.js";
import { verifyRound, type UsageCheck, type VerifyResult } from "./verify.js";

export interface RoundRecordPorts {
  table: Pick<DocumentStore, "get" | "put" | "update" | "query" | "transact">;
  /** The proxy-measured spend of one key, in US dollars. Undefined (or a throw) when the proxy cannot say: the key's budget is charged instead. */
  keySpend(keyIds: readonly string[]): Promise<number | undefined>;
  /** Blocks these keys at the proxy and ends their holds. Never throws (a key that cannot be closed here expires with its life). */
  closeKeys(orgId: OrgId, keyIds: readonly string[]): Promise<void>;
  /** The text of the operation's `design-review.json`, bounded; undefined when there is none. */
  readResult(operation: OperationRecord): Promise<string | undefined>;
  /** The proxy's first-call reader . Absent: every reviewer is `digest_only`, and the card says so. */
  usage?: UsageCheck | undefined;
}

export interface RoundRecordInput {
  /** PLAN_CRITIQUE/RUNNING with the review "running". */
  workflow: WorkflowSnapshot;
  /** The design-review operation, as stored (its `designReview` is the binding the broker wrote). */
  operation: OperationRecord;
  /** The design under review: its text (for the broker's own findings) and its artifact digest. */
  design: { text: string; sha256: string };
  /** The approved requirements' text, for their ids. */
  requirementsText: string;
  /**
   * collects the delete steps that remove the round's stored packets. The caller puts them in the SAME transaction that commits the returned workflow, so the packets are still there if the result is computed again (a
   * refused transaction, a resent upload). Absent: the packets are left to expire (they are unreachable once the round is recorded).
   */
  release?: TransactItem[];
  now: string;
}

const NO_KEY = "none";
const NO_SESSION = "none";

/**
 * What each slot's key cost. The proxy-MEASURED spend of the key is the authority and the worker's own figure is never used (it is untrusted, and could understate). A slot whose spend cannot be measured is charged its key's whole
 * budget, and so is a slot that was ASKED AGAIN (its key was blocked and its spend cannot be told from a re-ask's): the cap is never under-counted. A slot that never had a key cost nothing.
 */
async function slotCosts(ports: Pick<RoundRecordPorts, "keySpend">, keys: DesignReviewKeyIds): Promise<Map<string, { keyId: string; costUsd: number }>> {
  const costs = new Map<string, { keyId: string; costUsd: number }>();
  const charge = (measuredUsd: number | undefined, budgetUsd: number): number => recordedReviewerCost({ measuredUsd, sessionUsd: 0, budgetUsd, usedTokens: true }).costUsd;
  for (const [slot, keyId] of keys.bySlot) {
    let measuredUsd: number | undefined;
    try { measuredUsd = await ports.keySpend([keyId]); } catch { measuredUsd = undefined; }
    costs.set(slot, { keyId, costUsd: charge(measuredUsd, keys.budgetUsdBySlot.get(slot) ?? 0) });
  }
  for (const [slot, keyId] of keys.askedAgain) costs.set(slot, { keyId, costUsd: charge(undefined, keys.budgetUsdBySlot.get(slot) ?? 0) });
  return costs;
}

interface StoredPacket { items: ReviewerPacketItem[]; promptId: string; promptVersion: number; promptDigest: string; estimatedInputTokens: number }

async function storedPacketOf(ports: RoundRecordPorts, orgId: OrgId, operationId: string, binding: DesignReviewBinding, slot: string): Promise<StoredPacket | undefined> {
  try {
    const stored = await readSlotPacket(ports.table, orgId, operationId, binding.round, slot);
    if (stored === undefined) return undefined;
    const delivery = PacketDeliverySchema.safeParse(JSON.parse(stored.text));
    if (!delivery.success) return undefined;
    const { rolePrompt } = delivery.data;
    return {
      items: delivery.data.documents.map((document) => itemOf(document)), promptId: rolePrompt.id, promptVersion: rolePrompt.version, promptDigest: promptDigest(rolePrompt),
      estimatedInputTokens: estimateInputTokens(stored.bytes),
    };
  } catch { return undefined; }
}

function parsedResult(text: string | undefined, binding: DesignReviewBinding): DesignReviewWorkerResult | undefined {
  if (text === undefined) return undefined;
  try {
    const result = DesignReviewWorkerResultSchema.safeParse(JSON.parse(text));
    // A result for another round than the binding's is not this round's.
    return result.success && result.data.round === binding.round ? result.data : undefined;
  } catch { return undefined; }
}

/**
 * A design-review operation ended with no result to read (it failed, was stopped, or was lost): what its keys cost so far, the packets removed and the keys blocked and finalized. The cost is the proxy's measured spend for each slot's key;
 * a slot whose spend cannot be read is charged its key's whole budget (never under-counted). Never throws.
 */
export async function releaseDesignReviewRound(ports: Pick<RoundRecordPorts, "table" | "keySpend" | "closeKeys">, operation: Pick<OperationRecord, "id" | "orgId" | "designReview">): Promise<{ spentUsd: number }> {
  const orgId = operation.orgId;
  if (orgId === undefined) return { spentUsd: 0 };
  let spentUsd = 0;
  // the keys are blocked FIRST and the spend measured after, so a request admitted in between cannot go uncounted.
  try {
    const keys = await designReviewKeyIds(ports.table, operation);
    const keyIds = [...new Set([...keys.bySlot.values(), ...keys.askedAgain.values()])];
    try { await ports.closeKeys(orgId, keyIds); } catch { console.log(JSON.stringify({ component: "broker", event: "design_review.keys_not_closed", operationId: operation.id })); }
    const costs = await slotCosts(ports, keys);
    for (const cost of costs.values()) spentUsd += cost.costUsd;
  } catch { console.log(JSON.stringify({ component: "broker", event: "design_review.spend_not_read", operationId: operation.id })); }
  try { await removeSlotPackets(ports.table, orgId, operation.id); } catch { console.log(JSON.stringify({ component: "broker", event: "design_review.packets_not_removed", operationId: operation.id })); }
  return { spentUsd: Math.round(spentUsd * 1e6) / 1e6 };
}

/**
 * The workflow after a design-review operation's SUCCESSFUL end. Never throws for a result it cannot use: such a round is recorded with no reviewer that counts (the workflow decides what that means), or the review is closed as
 * not run. The caller commits the returned workflow conditionally on the revision it read.
 */
export async function recordDesignReviewRound(ports: RoundRecordPorts, input: RoundRecordInput): Promise<WorkflowSnapshot> {
  const { workflow, operation } = input;
  const review = workflow.designReview;
  const orgId = operation.orgId;
  const parsedBinding = DesignReviewBindingSchema.safeParse(operation.designReview);
  if (review === undefined || orgId === undefined || !parsedBinding.success) return closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: "worker_failed", now: input.now });
  const binding = parsedBinding.data;
  const keys = await designReviewKeyIds(ports.table, operation);
  const allKeyIds = [...new Set([...keys.bySlot.values(), ...keys.askedAgain.values()])];
  // block and finalize every slot key BEFORE the spend is measured (a request admitted in between would go uncounted). Closing is idempotent, so a result that is computed again finds the keys closed and measures the same spend.
  try { await ports.closeKeys(orgId, allKeyIds); } catch { console.log(JSON.stringify({ component: "broker", event: "design_review.keys_not_closed", operationId: operation.id })); }
  const costs = await slotCosts(ports, keys);
  const sourceId = operation.modelSourceId ?? "local";
  const costOf = (slot: string): number => costs.get(slot)?.costUsd ?? 0;
  const totalSpend = (): number => binding.reviewers.reduce((sum, entry) => sum + costOf(entry.keySlot), binding.merge === undefined ? 0 : costOf(binding.merge.keySlot));

  const finish = async (next: () => WorkflowSnapshot): Promise<WorkflowSnapshot> => {
    // the packets are NOT removed here. Their delete steps go to the caller's transaction (`input.release`), so they go with the commit and not before it; the keys were closed above.
    const moved = next();
    if (input.release !== undefined) {
      try { input.release.push(...await packetDeleteItems(ports.table, orgId, operation.id)); } catch { console.log(JSON.stringify({ component: "broker", event: "design_review.packets_not_released", operationId: operation.id })); }
    }
    return moved;
  };
  const closeNotRun = (reason: "worker_failed" | "inputs_unverified") => finish(() => closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: reason, addedSpendUsd: totalSpend(), now: input.now }));

  // A merge prompt that is not the registry's was not made by the broker: nothing is believed.
  if (bindingMergeProblem(binding) !== undefined) return closeNotRun("inputs_unverified");

  const result = parsedResult(await ports.readResult(operation).catch(() => undefined), binding);
  const outcomes = new Map((result?.reviewers ?? []).map((outcome) => [outcome.role, outcome] as const));
  const stored = new Map<ReviewerRole, StoredPacket | undefined>();
  for (const entry of binding.reviewers) stored.set(entry.role, await storedPacketOf(ports, orgId, operation.id, binding, entry.keySlot));

  // Fresh-context verification, with the keys the broker minted (a slot with none gets the empty key, which no check accepts).
  const priorRuns = review.rounds.flatMap((round) => round.reviewers);
  const verdicts = await verifyRound({
    reviewers: binding.reviewers.map((entry) => ({
      role: entry.role, report: outcomes.get(entry.role)?.report, keyId: keys.bySlot.get(entry.keySlot) ?? "",
      packet: { packetDigest: entry.packetDigest, estimatedInputTokens: stored.get(entry.role)?.estimatedInputTokens ?? 1 },
    })),
    priorSessionIds: new Set(priorRuns.map((run) => run.sessionId)), priorKeyIds: new Set(priorRuns.map((run) => run.modelKeyId)),
    operationKeyId: keys.operationKeyId, ...(keys.mergeKeyId === undefined ? {} : { mergeKeyId: keys.mergeKeyId }), usage: ports.usage ?? { kind: "unavailable" },
  });
  const verification = new Map<ReviewerRole, VerifyResult>();
  binding.reviewers.forEach((entry, index) => {
    const verdict = verdicts[index];
    // A reviewer whose stored packet cannot be read again cannot have its citations checked: it does not count.
    verification.set(entry.role, verdict === undefined || stored.get(entry.role) === undefined ? { verified: false, failure: "packet_digest_mismatch" } : verdict);
  });

  const assembled = assembleRoundFindings({
    binding, result: result ?? { reviewers: [], merge: { status: "no_result", tokensIn: 0, tokensOut: 0, costUsd: 0 } }, verification,
    packets: new Map<ReviewerRole, readonly CitablePacketItem[]>(binding.reviewers.map((entry) => [entry.role, stored.get(entry.role)?.items ?? []] as const)),
    pins: binding.baseCommits ?? {}, promptIds: new Map(binding.reviewers.map((entry) => [entry.role, stored.get(entry.role)?.promptId ?? ""] as const)),
  });

  // The broker's own findings are added; a reviewer finding that says the same thing is folded into them (N6, in withOwnFindings): the same fingerprint twice in one round would make the move refuse the whole result.
  const merged = withOwnFindings(assembled.findings, [
    ...ownDesignFindings({ design: input.design.text, requirementIds: requirementIdsOf(input.requirementsText) }),
    // A blocker a reader could not show is an open blocker of its own, so it cannot become a clean review (own-findings.ts).
    ...lostBlockerFindings({ dropped: assembled.readDroppedFindings, unreadableMaybeBlockers: assembled.unreadableMaybeBlockers }),
  ]);

  const stateOf = new Map<ReviewerRole, RoundReviewerState>(assembled.reviewers.map((state) => [state.role, state] as const));
  let runs: ReviewerRun[];
  try {
  runs = binding.reviewers.map((entry) => {
    const outcome = outcomes.get(entry.role);
    const state = stateOf.get(entry.role);
    const packet = stored.get(entry.role);
    const verdict = verification.get(entry.role);
    const registered = promptRecord(reviewerPromptFor(entry.role, review.tier));
    const counted = state?.counted === true && verdict?.verified === true;
    const keyId = keys.bySlot.get(entry.keySlot) ?? keys.askedAgain.get(entry.keySlot) ?? NO_KEY;
    return ReviewerRunSchema.parse({
      role: entry.role, promptId: packet?.promptId ?? registered.promptId, promptVersion: packet?.promptVersion ?? registered.promptVersion, promptDigest: packet?.promptDigest ?? registered.promptDigest,
      model: { provider: entry.model.provider, modelId: entry.model.modelId }, sourceId,
      sessionId: counted && verdict?.verified === true ? verdict.sessionId : NO_SESSION, modelKeyId: keyId, packetDigest: entry.packetDigest, packet: packet?.items ?? [],
      filesRead: counted && verdict?.verified === true ? verdict.filesRead : [], verified: counted,
      ...(counted ? { inputProof: state?.inputProof ?? "digest_only" } : { verifyFailure: state?.verifyFailure ?? "unreadable_output" }),
      tokensIn: outcome?.tokensIn ?? 0, tokensOut: outcome?.tokensOut ?? 0, costUsd: costOf(entry.keySlot),
      startedAt: outcome?.startedAt ?? input.now, endedAt: outcome?.endedAt ?? input.now,
      ...(counted && state?.paraphrase !== undefined ? { paraphrase: state.paraphrase } : {}),
    });
  });
  } catch {
    // A run the record's own schema refuses (a value from the worker that is not in range) is not recorded as read.
    return closeNotRun("inputs_unverified");
  }
  const mergeCostUsd = binding.merge === undefined ? 0 : costOf(binding.merge.keySlot);
  // A reviewer or the merge step that ran into its key's budget means the cap stopped the round.
  const stoppedAtCap = (result?.reviewers.some((outcome) => outcome.failure === "budget_exhausted") ?? false) || result?.merge.failure === "budget_exhausted";

  return finish(() => {
    try {
      return submitDesignReview(workflow, {
        expectedRevision: workflow.revision, designDigest: input.design.sha256, reviewers: runs, findings: merged.findings, mergeCostUsd,
        ...(binding.merge !== undefined && assembled.mergeSource === "model" ? { mergeModel: { provider: binding.merge.model.provider, modelId: binding.merge.model.modelId } } : {}),
        ...(stoppedAtCap ? { stoppedAtCap: true as const } : {}),
        // What was left out for want of a citation, with the blockers among it: the broker's own list, never the worker's.
        droppedFindings: assembled.droppedFindings.map((dropped) => ({ role: dropped.role, severity: dropped.severity, section: dropped.section })),
        unreadableFindings: assembled.unreadableFindings,
        now: input.now,
      });
    } catch (error) {
      if (!(error instanceof WorkflowTransitionError)) throw error;
      // The result broke a rule the move holds (a design that is not the one reviewed, a merge that shared an id): the round is not recorded as read, and what it cost still counts.
      return closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: "inputs_unverified", addedSpendUsd: totalSpend(), now: input.now });
    }
  });
}
