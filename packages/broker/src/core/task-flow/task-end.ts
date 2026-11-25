// The task-end seam: a task ends once, and the host is told once (`TaskFlowDeps.taskEnded`: what a task kept only for its own lifetime, such as live-only source text, goes now).
//
// A task ends in one of two ways: the person closes it, or a merged pull request completes it (every required pull request merged: the workflow reaches MERGED). Either may come first, and the other may follow:
// a merged task can still be closed by the person later, and a redelivered merge is seen again. Both go through `announceTaskEnd`, which keeps one marker row in the task's own partition. The first end writes the
// marker and calls the seam; a later end finds the marker and does not call it again.
//
// "Once" is for a host that took the call. A host whose seam failed (or whose process stopped before it answered) has no confirmed delivery on the marker, so the next end calls it again with the same event
// (`{ orgId, taskId }`); a host's handler is therefore idempotent, as the handlers of Code's local app are (they drop what a task kept, and dropping it twice is the same as once).
import { WORKFLOW_DISPATCH_DUE_INDEX, change, when, type DocumentStore, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { iso, log } from "./support.js";

export type TaskEndCause = "closed" | "merged";

//
// A host that delivers over a network (the hosted install's gateway notice) answers `"pending"` when the notice did not get through: the marker then stays without `notifiedAt`, the seam is never an error, and the
// RECONCILE (`reconcileTaskEnds`) sends it again. A marker that is not yet delivered sits in a sparse due-time index (the dispatch rows' index, a partition of its own) and leaves it when it is delivered.
/** The marker row of a task's end, in the task's own partition. */
export const taskEndKey = (taskId: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: "TASK_END" });

/** The partition of the due-time index that holds the markers whose host has not confirmed the notice. */
export const TASK_END_DUE_PK = "TASK_END_PENDING";
/** A notice is not sent again by the reconcile before this long after the end (the first attempt is still running or has just failed). */
export const TASK_END_FIRST_DUE_MS = 5 * 60_000;
/** The longest wait between two reconcile attempts for one marker. */
export const TASK_END_RETRY_MAX_MS = 60 * 60_000;
/** A notice still undelivered this long after the end is given up on (the marker stays, out of the index): a task that ended a week ago has no call left to stop. */
export const TASK_END_GIVE_UP_MS = 7 * 86_400_000;
/** The most markers one reconcile pass sends. */
export const TASK_END_RECONCILE_ROWS = 12;
/** How long an end waits for the host's first answer. A slower host keeps going in the background and the reconcile covers a notice that never lands: closing and merging never wait longer than this. */
export const TASK_END_WAIT_MS = 2_000;
const SWEEP_PAGES_MAX = 8;

/** What a host's seam answers: nothing (delivered) or `"pending"` (not delivered; the host's own reconcile sends it again). */
export type TaskEndAnswer = void | "pending";

const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");
const dueSk = (time: number, taskId: string): string => `${dueKey(time)}#${taskId}`;

/** The marker row: the cause and time of the end, the company, and the place in the due-time index while the host has not confirmed it (sibling attributes: a release that does not know them ignores them). */
export const taskEndRow = (deps: Pick<TaskFlowDeps, "companyId">, taskId: string, cause: TaskEndCause, at: string): StoredDocument => ({
  ...taskEndKey(taskId), entityType: "TASK_END", taskId, cause, at, orgId: deps.companyId,
  [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: TASK_END_DUE_PK, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: dueSk(Date.parse(at) + TASK_END_FIRST_DUE_MS, taskId),
});

/** Whether a save moved the workflow into the end a merge brings (every required pull request merged), as opposed to a workflow that was already there. */
export const completedByMerge = (before: Pick<WorkflowSnapshot, "stage"> | undefined, after: Pick<WorkflowSnapshot, "stage" | "state" | "outcome">): boolean =>
  after.stage === "MERGED" && after.state === "COMPLETE" && after.outcome === "MERGED" && before?.stage !== "MERGED";

/** Calls the host's seam once. A host that answered (anything but "pending") is recorded as told and the marker leaves the due-time index. A seam that throws throws here. */
export async function callTaskEndSeam(deps: Pick<TaskFlowDeps, "store" | "companyId" | "taskEnded" | "now">, taskId: string): Promise<"delivered" | "pending"> {
  const seam = deps.taskEnded;
  if (seam === undefined) return "pending";
  const answer = await seam({ orgId: deps.companyId, taskId });
  if (answer === "pending") return "pending";
  // The answer is kept, so a later end does not call the host again. A write that fails here only means the next end (or the reconcile) calls it once more.
  await deps.store.update({
    key: taskEndKey(taskId), condition: when.present(),
    ops: [change.set("notifiedAt", iso(deps)), change.remove(WORKFLOW_DISPATCH_DUE_INDEX.partitionKey), change.remove(WORKFLOW_DISPATCH_DUE_INDEX.sortKey)],
  }).catch(() => undefined);
  return "delivered";
}

/** Waits for a call at most `ms`; a call that fails after that is not an unhandled rejection. Resolves `undefined` when the time ran out. */
export async function within<T>(call: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, ms); timer.unref?.(); });
  call.catch(() => undefined);
  try { return await Promise.race([call, gone]); } finally { clearTimeout(timer); }
}

/**
 * Tells the host that a task ended, once. Best effort, like the seam: it never throws and never fails the close or the merge that called it, and it never waits longer than `TASK_END_WAIT_MS` for the host (a slower
 * host finishes in the background; a notice that does not land is sent again by the reconcile). Nothing is written when the host has no seam.
 * Returns whether the host was called by this end.
 */
export async function announceTaskEnd(deps: Pick<TaskFlowDeps, "store" | "companyId" | "taskEnded" | "now" | "log">, taskId: string, cause: TaskEndCause): Promise<boolean> {
  if (deps.taskEnded === undefined) return false;
  try {
    const key = taskEndKey(taskId);
    const first = await deps.store.put({ item: taskEndRow(deps, taskId, cause, iso(deps)), condition: when.absent() });
    if (!first.applied) {
      // An earlier end wrote the marker. If it also got the host's answer, this end has nothing to tell.
      const earlier = await deps.store.get(key);
      if (earlier === undefined || earlier["notifiedAt"] !== undefined) return false;
    }
    const call = callTaskEndSeam(deps, taskId).then((outcome) => {
      if (outcome === "pending") log(deps, { event: "task_flow.task_ended_pending" });
    }, (error: unknown) => {
      log(deps, { event: "task_flow.task_ended_failed", error: error instanceof Error ? error.name : "unknown" });
    });
    await within(call, TASK_END_WAIT_MS);
    return true;
  } catch (error) {
    log(deps, { event: "task_flow.task_end_unrecorded", taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * The reconcile: the markers whose host has not confirmed the notice, from the due-time index, are sent again (at most `limit` a pass, only this company's, none older than `TASK_END_GIVE_UP_MS`). A marker the
 * host still does not take is due again later (twice as long each time, at most an hour); one it takes leaves the index. Never throws; a host's repeats are safe (its notice is idempotent).
 */
export async function reconcileTaskEnds(
  deps: Pick<TaskFlowDeps, "store" | "companyId" | "taskEnded" | "now" | "log">, options: { limit?: number } = {},
): Promise<{ attempted: number; delivered: number }> {
  const none = { attempted: 0, delivered: 0 };
  if (deps.taskEnded === undefined) return none;
  const limit = options.limit ?? TASK_END_RECONCILE_ROWS;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const store: Pick<DocumentStore, "queryIndex" | "update"> = deps.store;
  const own: StoredDocument[] = [];
  try {
    let cursor: string | undefined;
    // The partition is every company's: another company's markers at the head are read past, a bounded number of pages.
    for (let pages = 0; pages < SWEEP_PAGES_MAX && own.length < limit; pages += 1) {
      const page = await store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: TASK_END_DUE_PK, sort: { op: "lte", value: `${dueKey(nowMs)}:` }, limit, ...(cursor === undefined ? {} : { cursor }) });
      own.push(...page.items.filter((row) => row["orgId"] === deps.companyId && typeof row["taskId"] === "string" && row["entityType"] === "TASK_END" && row["notifiedAt"] === undefined));
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
  } catch (error) {
    log(deps, { event: "task_flow.task_end_reconcile_failed", error: error instanceof Error ? error.name : "unknown" });
    return none;
  }
  const leave = (taskId: string) => store.update({ key: taskEndKey(taskId), ops: [change.remove(WORKFLOW_DISPATCH_DUE_INDEX.partitionKey), change.remove(WORKFLOW_DISPATCH_DUE_INDEX.sortKey)], condition: when.present() }).catch(() => undefined);
  let delivered = 0;
  const rows = own.slice(0, limit);
  await Promise.all(rows.map(async (row) => {
    const taskId = row["taskId"] as string;
    const endedAt = Date.parse(typeof row["at"] === "string" ? row["at"] : "");
    if (!Number.isFinite(endedAt) || nowMs - endedAt > TASK_END_GIVE_UP_MS) { log(deps, { event: "task_flow.task_end_given_up" }); await leave(taskId); return; }
    const tries = typeof row["notifyTries"] === "number" && Number.isFinite(row["notifyTries"]) ? Math.min(row["notifyTries"], 16) : 0;
    const outcome = await callTaskEndSeam(deps, taskId).catch((): "pending" => "pending");
    if (outcome === "delivered") { delivered += 1; return; }
    const wait = Math.min(TASK_END_RETRY_MAX_MS, TASK_END_FIRST_DUE_MS * 2 ** (tries + 1));
    await store.update({ key: taskEndKey(taskId), ops: [change.set("notifyTries", tries + 1), change.set(WORKFLOW_DISPATCH_DUE_INDEX.sortKey, dueSk(nowMs + wait, taskId))], condition: when.present() }).catch(() => undefined);
  }));
  return { attempted: rows.length, delivered };
}
