// Live steer: "Revise the plan with this change" (the hosted product's `agent-sessions/live-steer-revise.ts`). Coding stopped because the owner's live message asked for a change outside the approved
// plan (blocked with `liveSteerReapprovalRevise`, and the stop kept the owner's message ids with the blocked revision: `live-steer-reapproval.ts`). The owner's one press does this and nothing else:
//   - reads those messages (they must be steer messages of this task's session, written by the task's owner, still marked "needs re-approval"),
//   - moves the workflow from coding back to PLANNING with the owner's request for changes recorded (`revisePlanWithLiveChange`), writes the owner's words as the change to make (the same item a request for changes writes, so the
//     planner reads them as it reads any), and makes the planning step due, all in ONE transaction that is conditional on the blocked revision (a double press, or a press after anything moved, commits once or not at all),
//   - leaves everything after that to the existing machinery: the plan check, the plan waiting for the owner, and the owner's approval on the page, which alone starts coding again from the revised plan.
// Only the owner may press; the request id makes a repeat the same press; every unusual input is refused with fixed words and writes nothing. The message's text goes into the planning prompt only: never into a log, an event, an
// error, a decision or the workflow. The press changes no budget, tool or permission: it starts a planning run as a person's Retry starts one.
import { z } from "zod";
import {
  LIVE_STEER_REAPPROVAL_REASON, LIVE_STEER_TEXT_MAX_CHARS, WORKFLOW_REVISE_PLAN_DECISION_REASON, WorkflowTransitionError, agentXError, change, redactText, revisePlanWithLiveChange, when, workflowReviseOffered,
  type OrgId, type SessionId, type TransactItem,
} from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import { readTask } from "../task-flow/reads.js";
import { commitWorkflow, planFeedbackKey, runDispatchRow } from "../task-flow/stage-machine.js";
import { iso } from "../task-flow/support.js";
import { liveSteerChangeKey } from "./live-steer-reapproval.js";
import { markSteerRevised, readSteerMessage } from "./steer.js";

/** What a press carries: the same two values every owner button sends (the request's id, the revision the owner saw). Nothing else rides along. */
export const RevisePlanRequestSchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();

/** The words of a refusal (fixed; nothing from a message). */
export const REVISE_PLAN_REFUSALS = Object.freeze({
  invalid: "the request to revise the plan is not valid",
  notOffered: "this task did not stop for a change the plan can take in, so its plan cannot be revised with it",
  noChange: "the message that asked for the change can no longer be found, so the plan cannot be revised with it; retry coding or close the task",
  stale: "this action is out of date; refresh the task and try again",
});

const oneLine = (text: string): string => redactText(text).replace(/\s+/gu, " ").trim().slice(0, LIVE_STEER_TEXT_MAX_CHARS).trim();

/**
 * The owner's press of "Revise the plan". Answers when planning is running with the owner's change (or, for a repeat of the same request, as it already was). Throws, writing nothing, when the press is out of date or the task is
 * not stopped for a change the plan can take in.
 */
export async function revisePlanWithLiveMessage(deps: TaskFlowDeps, orgId: OrgId, sessionId: SessionId, input: { taskId: string; ownerDeveloperId: string }, value: unknown): Promise<"started" | "repeated"> {
  const { taskId } = input;
  const parsed = RevisePlanRequestSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.invalid);
  const request = parsed.data;
  const task = await readTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  const record = await deps.store.get(liveSteerChangeKey(taskId));
  const ids = Array.isArray(record?.["messageIds"]) ? (record["messageIds"] as unknown[]).filter((id): id is string => typeof id === "string") : [];
  // A repeat of a press that was taken is that press: it answers as it did and starts nothing. If the first answer lost the messages' own mark, the repeat makes it (it is idempotent).
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.reason !== WORKFLOW_REVISE_PLAN_DECISION_REASON || prior.decision !== "REQUEST_CHANGES") throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    if (record?.["usedBy"] === request.requestId) for (const id of ids) await markSteerRevised({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }) }, orgId, sessionId, id);
    return "repeated";
  }
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
  if (!workflowReviseOffered(workflow)) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.notOffered);
  if (record === undefined || record["workflowRevision"] !== workflow.revision || record["usedBy"] !== undefined || ids.length === 0 || ids.some((id) => !/^msg_[0-9a-z]{20}$/u.test(id))) {
    throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
  }
  // The text of the requested change, one line per message; every message must be the owner's, delivered, and still marked "needs re-approval".
  const parts: string[] = [];
  for (const id of ids) {
    const message = await readSteerMessage(deps.store, orgId, sessionId, id);
    if (message === undefined || message.author.developerId !== input.ownerDeveloperId || message.deletedAt !== undefined || message.delivery?.state !== "delivered" || message.delivery.reason !== LIVE_STEER_REAPPROVAL_REASON) {
      throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
    }
    const text = oneLine(message.text);
    if (text === "") throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
    parts.push(text);
  }
  const at = iso(deps);
  let next;
  try {
    next = revisePlanWithLiveChange(workflow, { requestId: request.requestId, actorId: workflow.ownerId, now: at });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  const items: TransactItem[] = [
    // The owner's words as the change to make: the same item a request for changes writes, which the planner's prompt reads under the owner's asks.
    { kind: "put", item: { ...planFeedbackKey(taskId, next.revision), entityType: "PLAN_FEEDBACK", text: parts.length === 1 ? parts[0]! : parts.map((part) => `- ${part}`).join(" "), createdAt: at } },
    dispatchRowItem(deps, taskId, next.revision, "PLAN", at),
    // The record is spent by this press (and only by it): a second press, even a newer request, finds it used.
    { kind: "update", key: liveSteerChangeKey(taskId), ops: [change.set("usedBy", request.requestId)], condition: when.and(when.eq("workflowRevision", workflow.revision), when.notExists("usedBy")) },
  ];
  if (!(await commitWorkflow(deps, task, next, items))) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
  // The messages say what became of them (best effort and after the commit: the revised plan is already being written whatever happens here; a repeat of this request makes the mark again).
  for (const id of ids) await markSteerRevised({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }) }, orgId, sessionId, id);
  await runDispatchRow(deps, { taskId, workflowRevision: next.revision, kind: "PLAN" }).catch((error: unknown) => deps.log?.({ component: "live-steer", event: "revise_plan_start_failed", error: error instanceof Error ? error.name : "unknown" }));
  return "started";
}
