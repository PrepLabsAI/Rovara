// The three moments the milestone hook does not write for any task, written as milestones so the ticket updates handler hears them with the hook's own claims and retries:
//   - `started`: intake started a task from a ticket (called after the start, by the intake wiring);
//   - `plan_ready`: the task's plan waits for review (PLAN_REVIEW / WAITING), read from the task after its session's summary changed; one per workflow revision;
//   - `closed`: the task ended without a merge (a merge has its own `merged` milestone).
// Each is written only for a task whose session follows a ticket (a `tracker_item` binding), so no other task gains an item. The milestone names no session, so nothing is added to the session's
// timeline. Every function here is best effort and never throws: the work it follows stands without it.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import type { CodeMilestones } from "../merge/seams.js";
import { sessionBindingsOf } from "../sessions/bindings.js";
import type { SessionChange } from "../sessions/summary.js";

export interface MomentTable {
  store: Pick<DocumentStore, "get" | "getMany" | "transact">;
  milestones: Pick<CodeMilestones, "items" | "deliver">;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /**
   * Another reason to write these moments for a session besides a ticket: a chat thread the task was started from, which is told the plan, the pull request and the end (`core/channel/thread-notices.ts`). Absent: only a ticket
   * counts. A failure is a failure of the best-effort write, which is logged and never thrown.
   */
  follows?: ((orgId: OrgId, sessionId: string) => Promise<boolean>) | undefined;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const log = (table: MomentTable, event: string, fields: Record<string, unknown>): void => table.log?.(event, fields);

async function followsTicket(table: MomentTable, orgId: OrgId, sessionId: string | undefined): Promise<boolean> {
  if ((await sessionBindingsOf(table.store, orgId, sessionId)).some((binding) => binding.kind === "tracker_item")) return true;
  return sessionId !== undefined && table.follows !== undefined && (await table.follows(orgId, sessionId)) === true;
}

async function writeMoment(table: MomentTable, input: { kind: "started" | "plan_ready" | "closed"; orgId: OrgId; taskId: string; n: number; text: string; definitionVersion?: string }): Promise<void> {
  const items = table.milestones.items({ kind: input.kind, orgId: input.orgId, taskId: input.taskId, at: new Date(table.now()).toISOString(), text: input.text }, input.n,
    input.definitionVersion === undefined ? {} : { definitionVersion: input.definitionVersion });
  if (items.length === 0) return;
  // Already written (the same moment again): nothing more to write, and the delivery below tells whoever has not heard it.
  await table.store.transact(items);
  await table.milestones.deliver(input.taskId);
}

/** Intake started a task from a ticket. */
export async function noteTicketTaskStarted(table: MomentTable, input: { orgId: OrgId; taskId: string; sessionId?: string | undefined }): Promise<void> {
  try {
    if (!await followsTicket(table, input.orgId, input.sessionId)) return;
    await writeMoment(table, { kind: "started", orgId: input.orgId, taskId: input.taskId, n: 1, text: "Rovara started work from the ticket." });
  } catch (error) {
    log(table, "ticket_update.started_not_noted", { taskId: input.taskId, error: errorName(error) });
  }
}

/** After a session's summary changed: a task whose plan now waits for review gets its `plan_ready` moment (one per workflow revision). */
export async function noteTicketPlanReady(table: MomentTable, taskId: string): Promise<void> {
  try {
    const task = await table.store.get(taskKey(taskId));
    const workflow = task?.["workflow"] as { stage?: unknown; state?: unknown; revision?: unknown; definitionVersion?: unknown } | undefined;
    const orgId = task?.["orgId"] ?? task?.["companyId"];
    if (typeof orgId !== "string" || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || typeof workflow.revision !== "number" || typeof workflow.definitionVersion !== "string" || task?.["closedAt"] !== undefined) return;
    if (!await followsTicket(table, orgId, typeof task?.["sessionId"] === "string" ? task["sessionId"] : undefined)) return;
    await writeMoment(table, { kind: "plan_ready", orgId: orgId, taskId, n: workflow.revision, text: "The plan is ready for review.", definitionVersion: workflow.definitionVersion });
  } catch (error) {
    log(table, "ticket_update.plan_not_noted", { taskId, error: errorName(error) });
  }
}

/** A task that ended without a merge is the `closed` moment. Never throws. */
export async function noteTicketTaskClosed(table: MomentTable, input: { orgId: OrgId; taskId: string; sessionId: string }): Promise<void> {
  try {
    if (!await followsTicket(table, input.orgId, input.sessionId)) return;
    await writeMoment(table, { kind: "closed", orgId: input.orgId, taskId: input.taskId, n: 1, text: "The task was closed." });
  } catch (error) {
    log(table, "ticket_update.closed_not_noted", { taskId: input.taskId, error: errorName(error) });
  }
}

/**
 * The hook for a committed session summary change (`SummaryDependencies.onChange`): a task session that follows a ticket, whose plan now waits, or that ended closed, gets that moment. A session of no task
 * or of no ticket costs one read and writes nothing.
 */
export function ticketMomentsOnChange(table: MomentTable): (change: SessionChange) => Promise<void> {
  return async (committed) => {
    const subject = committed.session.subject;
    if (subject.kind !== "task") return;
    const state = committed.summary.display?.state;
    if (state === "needs_you") await noteTicketPlanReady(table, subject.taskId);
    // A merge has its own milestone; a session that ended as `closed` was closed by its owner or by a run's own end.
    else if (state === "closed" && committed.ended) await noteTicketTaskClosed(table, { orgId: committed.orgId, taskId: subject.taskId, sessionId: committed.sessionId });
  };
}
