// Second review: the task owner acknowledges that an `on` second review did not run, so the merge may go ahead. Owner only
// (the caller checked who may decide the task), from the owner's own browser session (a token never does it), and audited in the same transaction as the write. The acknowledgement is one key per candidate and
// reason (`secondReviewAcknowledgement`): a new candidate asks again. Rovara opens pull requests as drafts and never marks them ready, so the gate is the merge card (`secondReviewMergeWait`), which refuses a Merge
// until this is done.
import { change, when, type AuditSink, type DocumentStore, type Principal } from "@agentx/contracts";
import { taskKey } from "../../developer/task-records.js";
import { secondReviewAcknowledgement } from "./plan.js";
import { secondOpinionOfTask } from "./store.js";
import { stagedAudit } from "./mode.js";

export type AcknowledgeResult = { ok: true; key: string; already: boolean } | { ok: false; reason: "stale" | "not_required" | "audit_unavailable" };

export interface AcknowledgeDeps { store: Pick<DocumentStore, "transact">; audit: AuditSink; companyId: string; now(): number }

/** The task record as the acknowledgement reads it: the candidate it holds, its opinion and the keys already acknowledged. */
export interface AcknowledgeTask { taskId: string; secondOpinion?: unknown; secondReviewAcknowledged?: string[] | undefined; workflow?: { candidate?: { digest: string } | undefined } | undefined; closedAt?: string | undefined }

export async function acknowledgeSecondReview(deps: AcknowledgeDeps, task: AcknowledgeTask, input: { candidateDigest: string; by: Principal }): Promise<AcknowledgeResult> {
  const digest = task.workflow?.candidate?.digest;
  if (digest === undefined || digest !== input.candidateDigest || task.closedAt !== undefined) return { ok: false, reason: "stale" };
  const opinion = secondOpinionOfTask(task, digest);
  const ack = opinion === undefined ? { required: false as const } : secondReviewAcknowledgement(opinion, digest);
  if (!ack.required) return { ok: false, reason: "not_required" };
  const given = task.secondReviewAcknowledged;
  if ((given ?? []).includes(ack.key)) return { ok: true, key: ack.key, already: true };
  const at = deps.now();
  const audit = stagedAudit(deps, { action: "task.second_review_acknowledged", subject: { type: "task", id: task.taskId }, details: { cause: opinion?.unavailableReason ?? "no-answer" } }, input.by.personId, at);
  // With nothing to record it in, the acknowledgement is refused: it is never written without its record.
  if (audit.length === 0) return { ok: false, reason: "audit_unavailable" };
  const applied = await deps.store.transact([
    {
      kind: "update", key: taskKey(task.taskId), ops: [change.set("secondReviewAcknowledged", [...(given ?? []), ack.key]), change.set("updatedAt", new Date(at).toISOString())],
      condition: when.and(
        when.eq(["workflow", "candidate", "digest"], digest), when.eq(["secondOpinion", "candidateDigest"], digest), when.notExists("closedAt"),
        given === undefined ? when.notExists("secondReviewAcknowledged") : when.eq("secondReviewAcknowledged", [...given]),
      ),
    },
    ...audit,
  ]);
  return applied.applied ? { ok: true, key: ack.key, already: false } : { ok: false, reason: "stale" };
}
