// The ticket thread (design B2, B3, B6; owner decision 254z d): above `status_only`, what Rovara writes on the ticket that started a task is ONE thread. A ROOT comment is posted once and EDITED IN PLACE (an edit
// notifies nobody); REPLIES in that thread are written only when a person must act or a decision was made. Both are drawn from the task log (`core/task-log`), so what the ticket says is what the Slack thread and the
// web page can say too (`thread-render.ts` has the words and the level's gate).
//
// Every rule of the one-shot comments holds here and none is loosened:
//   - ONLY the ticket intake started this task from (`originTicketOf`); a ticket linked by hand is never written to;
//   - the level is the project's choice, narrowed to what the tracker and the task allow (`effectiveLevel`): a tracker without the thread methods stays at `status_only`, and so does a task only its owner can see on a tracker
//     that cannot make an internal comment;
//   - each write is claimed once, and keeps its idempotency key (`ticket_update:<task>:<key>`), so two deliveries are one comment and the same root text again is no edit;
//   - the tracker's refusal is fixed words and a note for the settings page; a fault that may pass gives the claim back and throws; nothing here ever fails the task.
// Limits (design B6), none queued: 20 replies a task with 5 kept for a question or the plan ready; at most one root edit a minute (later edits merge: the newest text wins) and 60 in all a task; 120 new comments an hour
// per company and tracker (the one-shot comments' own counter) and 240 root edits.
import { createHash } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, change, ticketUpdateCallsKey, when,
  type CodeMilestone, type DocumentKey, type OrgId, type TaskLogEntry, type Tracker, type TicketUpdateLevel, type TicketUpdateMoment, type TicketUpdatesSettings,
} from "@agentx/contracts";
import { noteOwnWrite } from "../intake/own-writes.js";
import { recordMilestoneInLog } from "../task-log/milestones.js";
import { readTaskLog } from "../task-log/store.js";
import { taskKey } from "../task-flow/keys.js";
import { KEPT_SECONDS, claim, claimKey, scopeCoversCompany, countWithin, giveBack, hourOf, isFinal, refusalOf, release, settle } from "./claims.js";
import type { TicketRef, TicketUpdatesDependencies } from "./handler.js";
import { noteWriteAccessMissing, noteWriteAccessOk } from "./settings.js";
import { renderReplies, renderRoot, visibleEntries } from "./thread-render.js";

export const THREAD_REPLIES_PER_TASK = 20;
/** Of the replies a task may have, this many may only be a question or the plan ready, so a status line never uses the last of them. */
export const THREAD_REPLIES_RESERVED = 5;
export const THREAD_ROOT_EDIT_GAP_MS = 60_000;
export const THREAD_ROOT_EDITS_PER_TASK = 60;
export const THREAD_ROOT_EDITS_PER_HOUR = 240;
const COMMENTS_PER_HOUR = 120;
const LEASE_MS = 60_000;

const threadKey = (taskId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: "TICKET_THREAD" });
const repliesKey = (taskId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: "TICKET_THREAD_REPLIES" });
const sha = (text: string, length = 24): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);

/** What of the project's level this tracker and this task allow. Fail closed: anything not shown to be allowed is `status_only`. */
export async function effectiveLevel(
  deps: Pick<TicketUpdatesDependencies, "taskShared">, input: { tracker: Tracker; orgId: OrgId; taskId: string; level: TicketUpdateLevel },
): Promise<TicketUpdateLevel> {
  if (input.level === "status_only") return "status_only";
  // An adapter without the thread methods (a comment that answers an id, an edit) stays on one-shot comments.
  if (input.tracker.comment === undefined || input.tracker.updateComment === undefined) return "status_only";
  const shared = deps.taskShared === undefined ? false : await deps.taskShared(input.orgId, input.taskId).then((answer) => answer === true, () => false);
  // A task only its owner can see writes above `status_only` only where the tracker can say "internal" (Jira Service Management): a Linear comment is seen by everyone who can see the ticket.
  if (!shared && input.tracker.capabilities.internalComments !== true) return "status_only";
  return input.level;
}

interface ThreadState { commentId?: string; tracker: string; ticket: string; rootHash?: string; rootEditedAt: number; rootEdits: number; editLease?: number; noId?: boolean }

async function readState(deps: TicketUpdatesDependencies, orgId: OrgId, taskId: string): Promise<ThreadState | undefined> {
  const row = await deps.store.get(threadKey(taskId));
  if (row === undefined || row["orgId"] !== orgId || typeof row["tracker"] !== "string" || typeof row["ticket"] !== "string") return undefined;
  return {
    tracker: row["tracker"], ticket: row["ticket"], rootEditedAt: typeof row["rootEditedAt"] === "number" ? row["rootEditedAt"] : 0, rootEdits: typeof row["rootEdits"] === "number" ? row["rootEdits"] : 0,
    ...(typeof row["commentId"] === "string" ? { commentId: row["commentId"] } : {}), ...(typeof row["rootHash"] === "string" ? { rootHash: row["rootHash"] } : {}),
    ...(typeof row["editLease"] === "number" ? { editLease: row["editLease"] } : {}), ...(row["noId"] === true ? { noId: true } : {}),
  };
}

export interface ThreadContext {
  orgId: OrgId;
  taskId: string;
  title: string;
  ticket: TicketRef;
  tracker: Tracker;
  level: TicketUpdateLevel;
  /** When the project chose this level (its settings were saved): entries before it are not put on the ticket. Absent: the defaults, so none is held back. */
  since?: string | undefined;
  /** "milestone": a refusal to edit too soon is thrown, so the milestone is told again after the gap. "hook": it is reported, and the caller keeps the task to try again. */
  mode: "milestone" | "hook";
}

/** What a thread refresh did, in fixed words. `too_soon` and `busy` mean the root was not brought up to date yet. */
export type ThreadOutcome = "posted" | "edited" | "unchanged" | "too_soon" | "busy" | "rate_limited" | "edit_limit" | "no_comment_id" | "thread_elsewhere" | "needs_write_access" | "not_found" | "not_connected" | "refused";

/**
 * Brings the ticket's thread up to date with the task's log: the root (created once, then edited when its words changed) and the replies the log calls for that were not written yet. Throws only a fault that may pass
 * (and, in `milestone` mode, a root edit that came too soon), so the milestone is delivered again.
 */
export async function refreshThread(deps: TicketUpdatesDependencies, input: ThreadContext): Promise<ThreadOutcome> {
  const { orgId, taskId, ticket } = input;
  const ref = { tracker: ticket.tracker, id: ticket.id, url: ticket.url };
  const log = await readTaskLog(deps.store, orgId, taskId);
  const entries = visibleEntries(input.level, log, input.since);
  const taskUrl = deps.taskUrl?.(taskId);
  const text = renderRoot({ title: input.title, level: input.level, entries, taskUrl });
  const state = await readState(deps, orgId, taskId);
  // A thread another ticket began is never written to from this one (the ticket a task started from does not change; a row that says otherwise is not trusted).
  if (state !== undefined && (state.tracker !== ticket.tracker || state.ticket !== ticket.id)) return "thread_elsewhere";
  const note = (): Promise<void> => noteOwnWrite(deps, orgId, { system: ticket.tracker, ticket: ticket.id, touch: true }, deps.log);

  // ---- the root: posted once, then edited in place
  let root: ThreadOutcome;
  let commentId = state?.commentId;
  if (commentId === undefined) {
    const created = await createRoot(deps, { ...input, ref, text, note });
    if (typeof created !== "string") commentId = created.commentId;
    root = typeof created === "string" ? created : "posted";
  } else {
    root = await editRoot(deps, { ...input, ref, text, commentId, state: state!, note });
  }
  if (commentId === undefined) return root;

  // ---- the replies: each once, within the task's budget
  const replied = await postReplies(deps, { ...input, ref, entries, taskUrl, commentId, note });
  if (replied === "rate_limited" && root !== "too_soon" && root !== "busy") return "rate_limited";
  if ((root === "too_soon" || root === "busy") && input.mode === "milestone") throw agentXError("TOO_MANY_REQUESTS", "the ticket's root comment was edited a moment ago");
  return root;
}

async function createRoot(
  deps: TicketUpdatesDependencies, input: ThreadContext & { ref: { tracker: string; id: string; url: string }; text: string; note: () => Promise<void> },
): Promise<{ commentId: string } | ThreadOutcome> {
  const { orgId, taskId, ticket, tracker } = input;
  const claimed = await claim(deps, taskId, "thread_root");
  if (claimed === "busy") return "busy";
  if (claimed === "done") {
    // An earlier delivery posted it (or was refused): the row it left says which.
    const state = await readState(deps, orgId, taskId);
    if (state?.commentId !== undefined) return { commentId: state.commentId };
    const seen = (await deps.store.get(claimKey(taskId, "thread_root")))?.["outcome"];
    return seen === "needs_write_access" || seen === "not_found" || seen === "not_connected" || seen === "no_comment_id" ? seen : "refused";
  }
  const now = deps.now();
  const hour = ticketUpdateCallsKey(orgId, ticket.tracker, hourOf(now));
  let spent = false;
  try {
    if (!(await countWithin(deps, hour, COMMENTS_PER_HOUR, Math.floor(now / 1000) + 2 * 3600))) {
      deps.log?.("ticket_thread.rate_limited", { orgId, taskId, tracker: ticket.tracker, what: "root" });
      await release(deps, taskId, "thread_root");
      return "rate_limited";
    }
    spent = true;
    await input.note();
    const posted = await tracker.comment!(input.ref, input.text, deps.scope, { key: `ticket_update:${taskId}:thread_root`, requirePrivate: true })
      .then((answer) => ({ ok: true as const, answer }), (error: unknown) => { if (isFinal(error)) return { ok: false as const, reason: refusalOf(error) }; throw error; });
    if (!posted.ok) {
      await giveBack(deps, hour).catch(() => undefined);
      spent = false;
      if (posted.reason === "needs_write_access") await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
      await settle(deps, taskId, "thread_root", posted.reason);
      return fixed(posted.reason);
    }
    const commentId = posted.answer === undefined ? undefined : posted.answer.commentId;
    await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
    if (commentId === undefined) {
      // The tracker took the comment and gave no id: it cannot be edited, so the thread stays one comment.
      await deps.store.put({ item: { ...threadKey(taskId), entityType: "TICKET_THREAD", orgId, tracker: ticket.tracker, ticket: ticket.id, noId: true, rootEditedAt: now, rootEdits: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + KEPT_SECONDS } });
      await settle(deps, taskId, "thread_root", "no_comment_id");
      return "no_comment_id";
    }
    await deps.store.put({
      item: { ...threadKey(taskId), entityType: "TICKET_THREAD", orgId, tracker: ticket.tracker, ticket: ticket.id, commentId, rootHash: sha(input.text), rootEditedAt: now, rootEdits: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + KEPT_SECONDS },
    });
    await settle(deps, taskId, "thread_root", "posted");
    deps.log?.("ticket_thread.root_posted", { orgId, taskId, tracker: ticket.tracker });
    return { commentId };
  } catch (error) {
    if (spent) await giveBack(deps, hour).catch(() => undefined);
    await release(deps, taskId, "thread_root");
    throw error;
  }
}

const fixed = (reason: string): ThreadOutcome => (reason === "needs_write_access" || reason === "not_found" || reason === "not_connected" ? reason : "refused");

async function editRoot(
  deps: TicketUpdatesDependencies, input: ThreadContext & { ref: { tracker: string; id: string; url: string }; text: string; commentId: string; state: ThreadState; note: () => Promise<void> },
): Promise<ThreadOutcome> {
  const { orgId, taskId, ticket, tracker, state } = input;
  const hash = sha(input.text);
  // The same words again is no edit (two deliveries, or a refresh that changed nothing).
  if (state.rootHash === hash) return "unchanged";
  const now = deps.now();
  if (state.rootEdits >= THREAD_ROOT_EDITS_PER_TASK) return "edit_limit";
  if (now - state.rootEditedAt < THREAD_ROOT_EDIT_GAP_MS) return "too_soon";
  // One edit at a time: a lease on the thread row, so two refreshes that meet do not write over each other.
  // The gap and the cap are part of the lease's own condition, so two refreshes that meet cannot both edit inside the gap or past the cap.
  const myLease = now + LEASE_MS;
  const leased = await deps.store.update({
    key: threadKey(taskId), ops: [change.set("editLease", myLease)],
    condition: when.and(when.present(), when.or(when.notExists("editLease"), when.lt("editLease", now)), when.lt("rootEditedAt", now - THREAD_ROOT_EDIT_GAP_MS + 1), when.lt("rootEdits", THREAD_ROOT_EDITS_PER_TASK)),
  });
  if (!leased.applied) return "busy";
  const hour = ticketUpdateCallsKey(orgId, `${ticket.tracker}-edits`, hourOf(now));
  let spent = false;
  try {
    if (!(await countWithin(deps, hour, THREAD_ROOT_EDITS_PER_HOUR, Math.floor(now / 1000) + 2 * 3600))) {
      deps.log?.("ticket_thread.rate_limited", { orgId, taskId, tracker: ticket.tracker, what: "root_edit" });
      return "rate_limited";
    }
    spent = true;
    await input.note();
    const written = await tracker.updateComment!(input.ref, input.commentId, input.text, deps.scope).then(() => ({ ok: true as const }), (error: unknown) => { if (isFinal(error)) return { ok: false as const, reason: refusalOf(error) }; throw error; });
    if (!written.ok) {
      await giveBack(deps, hour).catch(() => undefined);
      spent = false;
      if (written.reason === "needs_write_access") await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
      return fixed(written.reason);
    }
    await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
    await deps.store.update({ key: threadKey(taskId), ops: [change.set("rootHash", hash), change.set("rootEditedAt", now), change.add("rootEdits", 1)], condition: when.present() });
    deps.log?.("ticket_thread.root_edited", { orgId, taskId, tracker: ticket.tracker });
    return "edited";
  } catch (error) {
    if (spent) await giveBack(deps, hour).catch(() => undefined);
    throw error;
  } finally {
    await deps.store.update({ key: threadKey(taskId), ops: [change.remove("editLease")], condition: when.eq("editLease", myLease) }).catch(() => undefined);
  }
}

async function postReplies(
  deps: TicketUpdatesDependencies,
  input: ThreadContext & { ref: { tracker: string; id: string; url: string }; entries: readonly TaskLogEntry[]; taskUrl: string | undefined; commentId: string; note: () => Promise<void> },
): Promise<"ok" | "rate_limited"> {
  const { orgId, taskId, ticket, tracker } = input;
  const drafts = renderReplies({ title: input.title, level: input.level, entries: input.entries, taskUrl: input.taskUrl }).filter((draft) => input.since === undefined || draft.at >= input.since);
  for (const draft of drafts) {
    const name = `reply#${sha(draft.key)}`;
    const claimed = await claim(deps, taskId, name);
    if (claimed === "done") continue;
    if (claimed === "busy") throw new Error("ticket thread reply in flight");
    const now = deps.now();
    const hour = ticketUpdateCallsKey(orgId, ticket.tracker, hourOf(now));
    const spent: DocumentKey[] = [];
    const refund = async (): Promise<void> => { for (const counter of spent.splice(0)) await giveBack(deps, counter).catch(() => undefined); };
    try {
      // The task's budget: a status line may not use the replies kept for a question or the plan ready.
      if (!(await countWithin(deps, repliesKey(taskId), draft.reserved ? THREAD_REPLIES_PER_TASK : THREAD_REPLIES_PER_TASK - THREAD_REPLIES_RESERVED, Math.floor(now / 1000) + KEPT_SECONDS))) {
        // Over the task's budget: this entry stays in the root only (the root says more is on the task page).
        deps.log?.("ticket_thread.reply_limit", { orgId, taskId, tracker: ticket.tracker, reserved: draft.reserved });
        await settle(deps, taskId, name, "rate_limited");
        continue;
      }
      spent.push(repliesKey(taskId));
      if (!(await countWithin(deps, hour, COMMENTS_PER_HOUR, Math.floor(now / 1000) + 2 * 3600))) {
        deps.log?.("ticket_thread.rate_limited", { orgId, taskId, tracker: ticket.tracker, what: "reply" });
        await refund();
        await release(deps, taskId, name);
        return "rate_limited";
      }
      spent.push(hour);
      await input.note();
      const posted = await tracker.comment!(input.ref, draft.text, deps.scope, { key: `ticket_update:${taskId}:${name}`, requirePrivate: true, parentId: input.commentId })
        .then(() => "posted", (error: unknown) => { if (isFinal(error)) return refusalOf(error); throw error; });
      if (posted !== "posted") await refund();
      if (posted === "needs_write_access") await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
      else if (posted === "posted") await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
      await settle(deps, taskId, name, posted);
      if (posted === "needs_write_access") return "ok";
    } catch (error) {
      await refund();
      await release(deps, taskId, name);
      throw error;
    }
  }
  return "ok";
}

/** What `sendTicketUpdate` hands over for a milestone at a level above `status_only`. */
export interface ThreadMilestone {
  milestone: CodeMilestone;
  moment: TicketUpdateMoment;
  task: Record<string, unknown>;
  ticket: TicketRef;
  tracker: Tracker;
  orgId: OrgId;
  project: string;
  settings: TicketUpdatesSettings;
  settingsAt?: string | undefined;
  level: TicketUpdateLevel;
  /** The status the project moves the ticket to at this moment (when it moves it). */
  status: string | undefined;
  /** The moment's claim name (one status move per moment). */
  key: string;
}

/** A milestone at a thread level: it is put in the task log, the ticket's status is moved if the project asks, and the thread is brought up to date. */
export async function sendThreadMilestone(deps: TicketUpdatesDependencies, input: ThreadMilestone): Promise<string> {
  const { milestone, orgId, ticket, tracker } = input;
  await recordMilestoneInLog({ store: deps.store, planSummaryOf: deps.planSummaryOf, log: deps.log }, milestone);
  // The status move is the one-shot code's: once per moment, counted against the hourly limit, noted before it is written.
  if (input.status !== undefined && tracker.setStatusByName !== undefined) {
    const name = `status#${input.key}`;
    const claimed = await claim(deps, milestone.taskId, name);
    if (claimed === "busy") throw new Error("ticket update in flight");
    if (claimed === "claimed") {
      const now = deps.now();
      const hour = ticketUpdateCallsKey(orgId, ticket.tracker, hourOf(now));
      let spent = false;
      try {
        if (!(await countWithin(deps, hour, COMMENTS_PER_HOUR, Math.floor(now / 1000) + 2 * 3600))) {
          await settle(deps, milestone.taskId, name, "rate_limited");
        } else {
          spent = true;
          await noteOwnWrite(deps, orgId, { system: ticket.tracker, ticket: ticket.id, touch: true }, deps.log);
          const answer = await tracker.setStatusByName(ticket, input.status, deps.scope).catch((error: unknown) => { if (isFinal(error)) return refusalOf(error); throw error; });
          if (answer !== "moved") { await giveBack(deps, hour).catch(() => undefined); spent = false; }
          if (answer === "needs_write_access") await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
          else if (answer === "moved") await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
          await settle(deps, milestone.taskId, name, answer);
        }
      } catch (error) {
        if (spent) await giveBack(deps, hour).catch(() => undefined);
        await release(deps, milestone.taskId, name);
        throw error;
      }
    }
  }
  return refreshThread(deps, {
    orgId, taskId: milestone.taskId, title: typeof input.task["title"] === "string" ? input.task["title"] : "", ticket, tracker, level: input.level, since: input.settingsAt, mode: "milestone",
  });
}

/**
 * The task log gained entries that are not a milestone (an answer, a decision, a question asked): the thread is brought up to date from the log. Reads the task, its origin ticket and the project's level afresh and
 * writes nothing when the task did not start from a ticket Rovara writes to, or the level (as narrowed) is `status_only`. Returns the outcome in fixed words, or undefined when there was nothing to write.
 */
export async function refreshThreadOfTask(
  deps: TicketUpdatesDependencies,
  input: {
    taskId: string;
    originTicketOf(task: { orgId: OrgId; project: string; taskId: string; sessionId: string }): Promise<TicketRef | undefined>;
    levelOf(orgId: OrgId, project: string): Promise<{ level: TicketUpdateLevel; comments: boolean; since?: string | undefined }>;
  },
): Promise<ThreadOutcome | undefined> {
  const task = await deps.store.get(taskKey(input.taskId)) as Record<string, unknown> | undefined;
  const taskOrg = task?.["orgId"] ?? task?.["companyId"];
  if (task === undefined || typeof taskOrg !== "string" || typeof task["project"] !== "string" || typeof task["sessionId"] !== "string") return undefined;
  const orgId = taskOrg;
  // The task's own record names its company; a handler scoped to another company never writes for it (a task id is not company-scoped, so a hook told of another company's task is refused here).
  if (!scopeCoversCompany(deps.scope, orgId)) return undefined;
  const ticket = await input.originTicketOf({ orgId, project: task["project"], taskId: input.taskId, sessionId: task["sessionId"] });
  if (ticket === undefined) return undefined;
  const chosen = await input.levelOf(orgId, task["project"]);
  if (!chosen.comments) return undefined;
  const tracker = deps.trackerFor(ticket.tracker);
  if (tracker === undefined) return undefined;
  const level = await effectiveLevel(deps, { tracker, orgId, taskId: input.taskId, level: chosen.level });
  if (level === "status_only") return undefined;
  return refreshThread(deps, { orgId, taskId: input.taskId, title: typeof task["title"] === "string" ? task["title"] : "", ticket, tracker, level, since: chosen.since, mode: "hook" });
}
