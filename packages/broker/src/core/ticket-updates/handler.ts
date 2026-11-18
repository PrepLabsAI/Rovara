// The milestone handler that writes back to the ticket that started a task. It is told the task's milestones (`core/milestones`) and acts on five: `started`, `plan_ready`, `pr_ready` (the pull request
// opened), `merged` and `closed`. Write-back uses the owner's tracker sign-in, so every rule fails closed:
//   - ONLY the ticket that started the task: a `tracker_item` binding of the task's session that intake itself recorded as started for THIS task (the intake item names the session or the task). A ticket
//     someone linked by hand, or any other place, is never written to;
//   - what leaves is set by the project's level (`TICKET_UPDATE_LEVELS`; owner decision 254z d replaces the old rule that nothing but fixed words ever leaves). At `status_only`, the default of every project that exists and of a
//     laptop, it is only fixed words, the task's title (made inert and cut), the status it moved to and the link to the pull request, written by this file exactly as before. Above it, `thread.ts` keeps one root comment on
//     the ticket, edited in place, and replies. Code, diffs, files, logs, test output, errors, secrets and money per person never leave at any level;
//   - a task only its owner can see (every task on a laptop) is written as an internal comment where the tracker can tell, never to customers;
//   - rate limited: at most `TICKET_UPDATES_PER_HOUR` writes per company and tracker an hour, and at most `TICKET_UPDATES_PER_TASK` per task. Over a limit the update is skipped (logged), never queued;
//   - each update is claimed once (a conditional write in the task's partition) before it is sent, so two deliveries send it once; a fault that may pass gives the claim back and throws, so the
//     delivery tries again (bounded by the milestone's attempts). A missing scope is noted for the settings page and the update is skipped: it never fails the task.
// A ticket is written through the Tracker port (`comment`, `setStatusByName`), so Linear and Jira (or any tracker that registers) are the same code here.
import { createHash } from "node:crypto";
import {
  EVAL_CI_LINE_PATTERN, TICKET_MOMENT_WORDS, intakeItemIdOf, ticketUpdateCallsKey, ticketUpdateLevelOf,
  type CodeMilestone, type CodeMilestoneKind, type DocumentKey, type DocumentStore, type HostScope, type OrgId, type Tracker, type TicketUpdateMoment,
} from "@agentx/contracts";
import { readIntakeItem } from "../intake/store.js";
import { noteOwnWrite } from "../intake/own-writes.js";
import type { TaskLogMilestoneDeps } from "../task-log/milestones.js";
import type { CodeMilestoneHandler } from "../milestones/milestones.js";
import { taskKey } from "../task-flow/keys.js";
import { sessionBindingsOf } from "../sessions/bindings.js";
import { noteWriteAccessMissing, noteWriteAccessOk, readTicketUpdates } from "./settings.js";
import { KEPT_SECONDS, claim, scopeCoversCompany, countWithin, giveBack, hourOf, isFinal, refusalOf, release, settle } from "./claims.js";
import { inertTicketTitle, plainHttpsLink } from "./text.js";
import { effectiveLevel, refreshThreadOfTask, sendThreadMilestone, type ThreadOutcome } from "./thread.js";

export { inertTicketTitle } from "./text.js";
import { setupEvidenceOf, setupPausedMessage, setupTrustLineOf } from "../setup-agent/recheck-rows.js";

export const TICKET_UPDATES_PER_HOUR = 120;
export const TICKET_UPDATES_PER_TASK = 12;

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
  /** L4-U5: the project's setup page when the host has an https address for it. Absent: the comment says to open the setup page in Rovara. */
  setupUrl?: ((project: string) => string | undefined) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /**
   * Whether more than the task's owner can see this task (the project's members, a shared task). Absent, a failure, or false: only the owner can, which is every task on a laptop. A task only its owner can see is never
   * written above `status_only` to a tracker that cannot make an internal comment (design B5): fail closed.
   */
  taskShared?: ((orgId: OrgId, taskId: string) => Promise<boolean>) | undefined;
  /** The task's page on the web, when the host has an https address for it. Absent: the thread has no "Full detail" line. */
  taskUrl?: ((taskId: string) => string | undefined) | undefined;
  /** The summary of the plan waiting for review, for the task log's `plan_summary` (`core/task-log`). Absent: no plan summary is logged, so none is written to a ticket. */
  planSummaryOf?: TaskLogMilestoneDeps["planSummaryOf"];
}

type Item = Record<string, unknown>;

/** The words of one update: the moment, the title, the status it moved to, the pull request's link. Nothing else. */
export function ticketUpdateText(input: { moment: TicketUpdateMoment; title: string; pullRequests?: readonly string[] | undefined; status?: string | undefined; verdict?: string | undefined; evalLine?: string | undefined; /** L4-U5: the setup's evidence line (fixed words), only when the check could not be made or finished. */ setupLine?: string | undefined }): string {
  const links = (input.pullRequests ?? []).flatMap((link) => plainHttpsLink(link) ?? []).slice(0, 5);
  // L4-EVCI: the customer's own eval result as one line, only when it is exactly the words Rovara writes for it (never a free text), and only on the ready line.
  const evalLine = input.moment === "pr_opened" && input.evalLine !== undefined && EVAL_CI_LINE_PATTERN.test(input.evalLine) ? [input.evalLine] : [];
  return [
    `${TICKET_MOMENT_WORDS[input.moment]}: "${inertTicketTitle(input.title)}".`,
    ...(input.status === undefined ? [] : [`Status: ${inertTicketTitle(input.status)}.`]),
    // L4-PRP: the pull request's verdict, the same words as its description (fixed words and counts), only for a pull request that is ready.
    ...(input.moment !== "pr_opened" || input.verdict === undefined ? [] : [`Result: ${Array.from(input.verdict.replace(/[\p{Cc}\p{Cf}<>@[\]`*_~#|!]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 200).join("")}.`]),
    ...links.map((link) => `Pull request: ${link}`),
    ...evalLine,
    ...(input.setupLine === undefined ? [] : [input.setupLine]),
  ].join("\n");
}

/** The ticket intake started this task from, verified against the intake item; undefined when the task did not start from a ticket Rovara writes to. */
export async function originTicketOf(
  deps: Pick<TicketUpdatesDependencies, "store" | "now">, input: { orgId: OrgId; project: string; taskId: string; sessionId: string },
  options: { strict?: boolean } = {},
): Promise<TicketRef | undefined> {
  const bindings = await sessionBindingsOf(deps.store, input.orgId, input.sessionId);
  for (const binding of bindings) {
    if (binding.kind !== "tracker_item") continue;
    const item = await readIntakeItem(deps, input.orgId, input.project, intakeItemIdOf(binding.system, binding.id));
    // Intake itself must have started THIS task from this ticket; a ticket bound any other way is not written to.
    if (item === undefined || item.state !== "started" || item.system !== binding.system || item.id !== binding.id) continue;
    if (item.sessionId !== input.sessionId && item.taskId !== input.taskId) continue;
    // Above `status_only` (customer words leave) the item must name THIS task: an item that intake marked started for a session that was already bound to the ticket by hand (a duplicate, a raced start) names no task.
    if (options.strict === true && item.taskId !== input.taskId) continue;
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

/** One milestone: the update it calls for, sent once to the ticket the task started from. Never throws for a ticket that cannot be written; throws a fault that may pass. */
export async function sendTicketUpdate(deps: TicketUpdatesDependencies, milestone: CodeMilestone): Promise<string> {
  // L4-U5: `setup_paused` (the task paused before Build because the project's setup broke) is a comment of its own, in the page's fixed words; it never moves a ticket's status.
  const setupPaused = milestone.kind === "setup_paused";
  const moment = setupPaused ? undefined : MOMENT_OF[milestone.kind];
  if (moment === undefined && !setupPaused) return "not_a_moment";
  const momentName = setupPaused ? "setup_paused" : moment!;
  const task = await deps.store.get(taskKey(milestone.taskId)) as Item | undefined;
  const taskOrg = task?.["orgId"] ?? task?.["companyId"];
  if (task === undefined || taskOrg !== milestone.orgId || typeof task["project"] !== "string" || !scopeCoversCompany(deps.scope, milestone.orgId)) return "no_task";
  const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : milestone.sessionId;
  if (sessionId === undefined) return "no_session";
  const orgId = milestone.orgId;
  const project = task["project"];
  const ticket = await originTicketOf(deps, { orgId, project, taskId: milestone.taskId, sessionId });
  if (ticket === undefined) return "no_ticket";
  const { settings, at: settingsAt } = await readTicketUpdates(deps, orgId, project);
  const status = moment === undefined || !settings.changeStatus ? undefined : settings.statuses[moment];
  if (!settings.comments && status === undefined) return "off";
  const tracker = deps.trackerFor(ticket.tracker);
  if (tracker === undefined || (tracker.comment === undefined && tracker.setStatusByName === undefined)) return "not_connected";
  // Above `status_only` the ticket gets one thread (a root comment edited in place, and replies) from the task log instead of the five one-shot comments; the level is what this project chose, narrowed to what this tracker and this
  // task allow (`effectiveLevel`). At `status_only` nothing below changes: it is the code that was here before the levels.
  // Batch 17: a setup pause (L4-U5, no moment) is always its own one-shot comment, never a thread message.
  if (settings.comments && moment !== undefined) {
    let level = await effectiveLevel(deps, { tracker, orgId, taskId: milestone.taskId, level: ticketUpdateLevelOf(settings) });
    const strictTicket = level === "status_only" ? undefined : await originTicketOf(deps, { orgId, project, taskId: milestone.taskId, sessionId }, { strict: true });
    if (strictTicket === undefined) level = "status_only";
    // The thread goes to the ticket that names THIS task, whichever other ticket the session was bound to.
    if (level !== "status_only" && strictTicket !== undefined) return sendThreadMilestone(deps, { milestone, moment, task, ticket: strictTicket, tracker, orgId, project, settings, settingsAt, level, status, key: claimKeyOf(milestone, moment) });
  }
  // The setup pause says its words only while the task's re-check says the setup is broken, and once per re-check (a task paused twice by the same break is told once).
  let setupText: string | undefined;
  let setupKey: string | undefined;
  if (setupPaused) {
    const evidence = await setupEvidenceOf({ store: deps.store, companyId: orgId }, project, milestone.taskId);
    if (evidence?.state !== "broken" || evidence.recheckKey === undefined) return "not_broken";
    setupKey = `setup_paused#${evidence.recheckKey}`;
    setupText = setupPausedMessage(evidence.failedStep ?? "setup", deps.setupUrl?.(project));
  }
  // The evidence line rides on the pull request comment only when the setup could not be re-checked (a pass never posts).
  const trustLine = moment === "pr_opened" ? await setupTrustLineOf({ store: deps.store, companyId: orgId }, project, milestone.taskId) : undefined;
  const key = setupKey ?? claimKeyOf(milestone, moment!);
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
      deps.log?.("ticket_update.rate_limited", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment: momentName });
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
        const text = setupText ?? ticketUpdateText({ moment: moment!, title: typeof task["title"] === "string" ? task["title"] : "", status: moved, ...(milestone.verdict === undefined ? {} : { verdict: milestone.verdict }), ...(milestone.pullRequests === undefined ? {} : { pullRequests: milestone.pullRequests.map((pr) => pr.url) }), ...(milestone.evalLine === undefined ? {} : { evalLine: milestone.evalLine }), ...(trustLine === undefined ? {} : { setupLine: trustLine }) });
        // The comment's key is the claim's: the same update again is the same comment, never a second one. A task only its owner can see is written as an internal comment.
        posted = await tracker.comment(ref, text, deps.scope, { key: `ticket_update:${milestone.taskId}:${key}`, requirePrivate: true }).then(() => "posted", (error: unknown) => { if (isFinal(error)) return refusalOf(error); throw error; });
        if (posted === "needs_write_access") missing = true;
      }
    }
    if (missing) await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
    else if (posted === "posted" || moved !== undefined) await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
    if (posted !== "posted" && moved === undefined) await refund();
    const outcome = missing ? "needs_write_access" : posted;
    deps.log?.("ticket_update.sent", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment: momentName, outcome, ...(moved === undefined ? {} : { statusMoved: true }) });
    await settle(deps, milestone.taskId, key, outcome);
    return outcome;
  } catch (error) {
    await refund();
    await release(deps, milestone.taskId, key);
    throw error;
  }
}

/**
 * The task log gained entries that are not a milestone (an answer, a decision, a question asked): the ticket's thread is brought up to date from the log. Reads the task, the ticket it started from and the project's level
 * afresh, so it writes nothing for a task that did not start from a ticket Rovara writes to, and nothing at `status_only` (or a level the tracker or the task does not allow).
 */
export function refreshTicketThread(deps: TicketUpdatesDependencies, taskId: string): Promise<ThreadOutcome | undefined> {
  return refreshThreadOfTask(deps, {
    taskId,
    originTicketOf: (task) => originTicketOf(deps, task, { strict: true }),
    levelOf: async (orgId, project) => {
      const read = await readTicketUpdates(deps, orgId, project);
      return { level: ticketUpdateLevelOf(read.settings), comments: read.settings.comments, since: read.at };
    },
  });
}

/** The handler registered once on the milestone hook (`app.milestones.register`). */
export function ticketUpdatesHandler(deps: TicketUpdatesDependencies): CodeMilestoneHandler {
  return {
    name: "ticket_updates",
    async on(milestone) {
      if (MOMENT_OF[milestone.kind] === undefined && milestone.kind !== "setup_paused") return;
      await sendTicketUpdate(deps, milestone);
    },
  };
}
