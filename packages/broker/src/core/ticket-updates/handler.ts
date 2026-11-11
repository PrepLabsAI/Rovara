// The milestone handler that writes back to the ticket that started a task. It is told the task's milestones (`core/milestones`) and acts on five: `started`, `plan_ready`, `pr_ready` (the pull request
// opened), `merged` and `closed`. Write-back uses the owner's tracker sign-in, so every rule fails closed:
//   - ONLY the ticket that started the task: a `tracker_item` binding of the task's session that intake itself recorded as started for THIS task (the intake item names the session or the task). A ticket
//     someone linked by hand, or any other place, is never written to;
//   - only fixed words, the task's title (made inert and cut), the status it moved to, and the link to the pull request. No plan, code, comment or summary ever leaves;
//   - a task only its owner can see (every task on a laptop) is written as an internal comment where the tracker can tell, never to customers;
//   - rate limited: at most `TICKET_UPDATES_PER_HOUR` writes per company and tracker an hour, and at most `TICKET_UPDATES_PER_TASK` per task. Over a limit the update is skipped (logged), never queued;
//   - each update is claimed once (a conditional write in the task's partition) before it is sent, so two deliveries send it once; a fault that may pass gives the claim back and throws, so the
//     delivery tries again (bounded by the milestone's attempts). A missing scope is noted for the settings page and the update is skipped: it never fails the task.
// A ticket is written through the Tracker port (`comment`, `setStatusByName`), so Linear and Jira (or any tracker that registers) are the same code here.
import { createHash } from "node:crypto";
import {
  AgentXError, INDEX_EXPIRY_ATTRIBUTE, TICKET_MOMENT_WORDS, TrackerWriteRefusedError, change, intakeItemIdOf, ticketUpdateCallsKey, when,
  type CodeMilestone, type CodeMilestoneKind, type DocumentKey, type DocumentStore, type HostScope, type OrgId, type Tracker, type TicketUpdateMoment,
} from "@agentx/contracts";
import { readIntakeItem } from "../intake/store.js";
import { noteOwnWrite } from "../intake/own-writes.js";
import type { CodeMilestoneHandler } from "../milestones/milestones.js";
import { taskKey } from "../task-flow/keys.js";
import { sessionBindingsOf } from "../sessions/bindings.js";
import { noteWriteAccessMissing, noteWriteAccessOk, readTicketUpdates } from "./settings.js";

export const TICKET_UPDATES_PER_HOUR = 120;
export const TICKET_UPDATES_PER_TASK = 12;
const CLAIM_LEASE_MS = 60_000;
const KEPT_SECONDS = 400 * 86_400;
const TITLE_MAX = 120;

const MOMENT_OF: Partial<Record<CodeMilestoneKind, TicketUpdateMoment>> = { started: "started", plan_ready: "plan_ready", pr_ready: "pr_opened", merged: "merged", closed: "closed" };

/** The ticket a task started from, as intake recorded it (system, id and link checked by the intake schema). */
export interface TicketRef { tracker: string; id: string; url: string }

export interface TicketUpdatesDependencies {
  store: Pick<DocumentStore, "get" | "getMany" | "put" | "update" | "delete" | "query" | "transact">;
  now: () => number;
  /** The tracker registered under a system's name, or undefined. A ticket whose tracker is not registered (or cannot write) is not written to. */
  trackerFor(system: string): Tracker | undefined;
  /** What a tracker call is scoped to (the install's company). */
  scope: HostScope;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

type Item = Record<string, unknown>;
const hourOf = (now: number): string => new Date(now).toISOString().slice(0, 13);

/** A title made safe to post: no controls, no mention or markup characters (nobody is pinged, nothing becomes a link), one line, cut. */
export function inertTicketTitle(title: string): string {
  const plain = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/:\/\//gu, ": ").replace(/[@<>[\]()`*_~#|!]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...plain].slice(0, TITLE_MAX).join("").trimEnd();
  return cut === "" ? "(no title)" : cut;
}

/** A pull request's address when it is a plain https address (no sign-in data), else nothing: only an address Rovara can vouch for is put in a ticket. */
function plainHttpsLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The words of one update: the moment, the title, the status it moved to, the pull request's link. Nothing else. */
export function ticketUpdateText(input: { moment: TicketUpdateMoment; title: string; pullRequests?: readonly string[] | undefined; status?: string | undefined }): string {
  const links = (input.pullRequests ?? []).flatMap((link) => plainHttpsLink(link) ?? []).slice(0, 5);
  return [
    `${TICKET_MOMENT_WORDS[input.moment]}: "${inertTicketTitle(input.title)}".`,
    ...(input.status === undefined ? [] : [`Status: ${inertTicketTitle(input.status)}.`]),
    ...links.map((link) => `Pull request: ${link}`),
  ].join("\n");
}

/** The ticket intake started this task from, verified against the intake item; undefined when the task did not start from a ticket Rovara writes to. */
export async function originTicketOf(deps: Pick<TicketUpdatesDependencies, "store" | "now">, input: { orgId: OrgId; project: string; taskId: string; sessionId: string }): Promise<TicketRef | undefined> {
  const bindings = await sessionBindingsOf(deps.store, input.orgId, input.sessionId);
  for (const binding of bindings) {
    if (binding.kind !== "tracker_item") continue;
    const item = await readIntakeItem(deps, input.orgId, input.project, intakeItemIdOf(binding.system, binding.id));
    // Intake itself must have started THIS task from this ticket; a ticket bound any other way is not written to.
    if (item === undefined || item.state !== "started" || item.system !== binding.system || item.id !== binding.id) continue;
    if (item.sessionId !== input.sessionId && item.taskId !== input.taskId) continue;
    return { tracker: binding.system, id: binding.id, url: item.url };
  }
  return undefined;
}

/** The claim's key: one per moment, per pull request for `pr_opened` and per plan for `plan_ready`. */
function claimKeyOf(milestone: CodeMilestone, moment: TicketUpdateMoment): string {
  if (moment === "pr_opened") return `pr_opened#${createHash("sha256").update((milestone.pullRequests ?? []).map((pr) => `${pr.repository}#${String(pr.number)}`).join(",")).digest("hex").slice(0, 24)}`;
  if (moment === "plan_ready") return `plan_ready#${createHash("sha256").update(milestone.at).digest("hex").slice(0, 24)}`;
  return moment;
}

const claimKey = (taskId: string, key: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}` });

async function claim(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<"claimed" | "done" | "busy"> {
  const now = deps.now();
  const written = await deps.store.put({
    item: { ...claimKey(taskId, key), entityType: "TICKET_UPDATE", state: "sending", leaseUntil: now + CLAIM_LEASE_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + KEPT_SECONDS },
    condition: when.or(when.absent(), when.and(when.eq("state", "sending"), when.lt("leaseUntil", now))),
  });
  if (written.applied) return "claimed";
  const seen = await deps.store.get(claimKey(taskId, key));
  return seen?.["state"] === "sending" ? "busy" : "done";
}

async function settle(deps: TicketUpdatesDependencies, taskId: string, key: string, outcome: string): Promise<void> {
  await deps.store.update({ key: claimKey(taskId, key), ops: [change.set("state", "done"), change.set("outcome", outcome), change.remove("leaseUntil")] });
}

async function release(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<void> {
  await deps.store.delete({ key: claimKey(taskId, key), condition: when.eq("state", "sending") }).catch(() => undefined);
}

/** Counts one write against a limit in one conditional update; false when the limit is used up. */
async function countWithin(deps: TicketUpdatesDependencies, key: DocumentKey, max: number, expiresSeconds: number): Promise<boolean> {
  return (await deps.store.update({ key, ops: [change.add("count", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, expiresSeconds)], condition: when.or(when.notExists("count"), when.lt("count", max)) })).applied;
}

/** Gives one count back (a write that did not happen). Never below zero. */
async function giveBack(deps: TicketUpdatesDependencies, key: DocumentKey): Promise<void> {
  await deps.store.update({ key, ops: [change.add("count", -1)], condition: when.gt("count", 0) });
}

/** A refusal that will not pass by itself (the tracker's own "no"): the update is skipped, not tried again. A rate limit or a fault may pass and is thrown. */
const isFinal = (error: unknown): boolean => error instanceof TrackerWriteRefusedError || (error instanceof AgentXError && error.statusCode < 500 && error.code !== "TOO_MANY_REQUESTS");
const refusalOf = (error: unknown): string => (error instanceof TrackerWriteRefusedError ? error.reason : "refused");

/** One milestone: the update it calls for, sent once to the ticket the task started from. Never throws for a ticket that cannot be written; throws a fault that may pass. */
export async function sendTicketUpdate(deps: TicketUpdatesDependencies, milestone: CodeMilestone): Promise<string> {
  const moment = MOMENT_OF[milestone.kind];
  if (moment === undefined) return "not_a_moment";
  const task = await deps.store.get(taskKey(milestone.taskId)) as Item | undefined;
  const taskOrg = task?.["orgId"] ?? task?.["companyId"];
  if (task === undefined || taskOrg !== milestone.orgId || typeof task["project"] !== "string") return "no_task";
  const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : milestone.sessionId;
  if (sessionId === undefined) return "no_session";
  const orgId = milestone.orgId;
  const project = task["project"];
  const ticket = await originTicketOf(deps, { orgId, project, taskId: milestone.taskId, sessionId });
  if (ticket === undefined) return "no_ticket";
  const { settings } = await readTicketUpdates(deps, orgId, project);
  const status = settings.changeStatus ? settings.statuses[moment] : undefined;
  if (!settings.comments && status === undefined) return "off";
  const tracker = deps.trackerFor(ticket.tracker);
  if (tracker === undefined || (tracker.comment === undefined && tracker.setStatusByName === undefined)) return "not_connected";
  const key = claimKeyOf(milestone, moment);
  const claimed = await claim(deps, milestone.taskId, key);
  if (claimed === "done") return "already_sent";
  if (claimed === "busy") throw new Error("ticket update in flight");
  // The two counters are spent only by a write that reached the tracker. Each is taken in one conditional update (so two deliveries cannot both use the last one), and given back when the other limit says
  // no, when nothing was written, or when the send fails and will be tried again.
  const now = deps.now();
  const perTask: DocumentKey = { pk: `DEVTASK#${milestone.taskId}`, sk: "TICKET_UPDATE_COUNT" };
  const perHour = ticketUpdateCallsKey(orgId, ticket.tracker, hourOf(now));
  const spent: DocumentKey[] = [];
  const refund = async (): Promise<void> => { for (const counter of spent.splice(0)) await giveBack(deps, counter).catch(() => undefined); };
  try {
    if (await countWithin(deps, perTask, TICKET_UPDATES_PER_TASK, Math.floor(now / 1000) + KEPT_SECONDS)) spent.push(perTask);
    if (spent.length === 1 && await countWithin(deps, perHour, TICKET_UPDATES_PER_HOUR, Math.floor(now / 1000) + 2 * 3600)) spent.push(perHour);
    if (spent.length < 2) {
      await refund();
      deps.log?.("ticket_update.rate_limited", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment });
      await settle(deps, milestone.taskId, key, "rate_limited");
      return "rate_limited";
    }
    const ref = { tracker: ticket.tracker, id: ticket.id, url: ticket.url };
    // Rovara notes what it is about to write BEFORE it writes, so the tracker's echo of it is not taken for a member's act (`own-writes.ts`). A note that cannot be written stops the write.
    await noteOwnWrite(deps, orgId, { system: ticket.tracker, ticket: ticket.id, touch: true }, deps.log);
    let moved: string | undefined;
    let missing = false;
    if (status !== undefined && tracker.setStatusByName !== undefined) {
      const answer = await tracker.setStatusByName(ref, status, deps.scope).catch((error: unknown) => { if (isFinal(error)) return refusalOf(error); throw error; });
      if (answer === "moved") moved = status;
      if (answer === "needs_write_access") missing = true;
    }
    let posted = "comments_off";
    if (settings.comments) {
      if (tracker.comment === undefined) posted = "not_connected";
      else {
        const text = ticketUpdateText({ moment, title: typeof task["title"] === "string" ? task["title"] : "", status: moved, ...(milestone.pullRequests === undefined ? {} : { pullRequests: milestone.pullRequests.map((pr) => pr.url) }) });
        // The comment's key is the claim's: the same update again is the same comment, never a second one. A task only its owner can see is written as an internal comment.
        posted = await tracker.comment(ref, text, deps.scope, { key: `ticket_update:${milestone.taskId}:${key}`, requirePrivate: true }).then(() => "posted", (error: unknown) => { if (isFinal(error)) return refusalOf(error); throw error; });
        if (posted === "needs_write_access") missing = true;
      }
    }
    if (missing) await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
    else if (posted === "posted" || moved !== undefined) await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
    if (posted !== "posted" && moved === undefined) await refund();
    const outcome = missing ? "needs_write_access" : posted;
    deps.log?.("ticket_update.sent", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment, outcome, ...(moved === undefined ? {} : { statusMoved: true }) });
    await settle(deps, milestone.taskId, key, outcome);
    return outcome;
  } catch (error) {
    await refund();
    await release(deps, milestone.taskId, key);
    throw error;
  }
}

/** The handler registered once on the milestone hook (`app.milestones.register`). */
export function ticketUpdatesHandler(deps: TicketUpdatesDependencies): CodeMilestoneHandler {
  return {
    name: "ticket_updates",
    async on(milestone) {
      if (MOMENT_OF[milestone.kind] === undefined) return;
      await sendTicketUpdate(deps, milestone);
    },
  };
}
