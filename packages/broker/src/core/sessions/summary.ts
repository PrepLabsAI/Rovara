// A session's summary (lane L6b, inventory B6; the hosted product's Plan 5 Task 7a): what Live, Home and the header show, recomputed from the source records and never from a stream record's own contents, so a
// stale or out-of-order batch is only a reason to look again. A refresh writes the summary, the live tile and one event in one transaction, and tells the change hooks afterwards.
//
// A session ENDS only when its work is over (`endedOf`): a closed task, a merged or closed workflow, a workspace that could not be prepared. A stopped task is `stopped` and a task between turns is `waiting`;
// both stay open. An ended session never reopens. Chain runs and sessions on a Mac are the hosted product's; this lane reads task sessions only.
//
// The sources are seams (facts.ts): the task flow's facts and the cost ledger's total. The decision tree below is the hosted product's, over those facts.
import { createHash } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, LIVE_ENDED_KEEP_HOURS, NO_CODE_CHANGED_STEP, SESSION_NEEDS_PEOPLE_MAX, SESSION_RETENTION_DAYS, SESSION_TITLE_MAX, SESSION_PEEK_MAX_CHARS, SessionSummarySchema, agentSessionKey,
  canonicalJson, change, failureCause, isNoCodeChangedReason, liveSessionKey, openAgentSessionKey, redactText, sessionEventId, sessionTaskStatus, taskStatusText, when,
  type AgentSessionRecord, type DocumentStore, type OrgId, type SessionEvent, type SessionId, type SessionStatus, type SessionSummary, type TaskStatus, type TransactItem,
} from "@agentx/contracts";
import { AgentSessionRecordSchema } from "@agentx/contracts";
import { defaultTaskDisplay } from "./display.js";
import type { SessionCostSource, SessionTaskFacts, TaskFactsSource } from "./facts.js";
import { SessionStore, jsonOf, sessionEventItem } from "./store.js";

type Log = (entry: Record<string, unknown>) => void;

/** What changed in one committed refresh. */
export interface SessionChange {
  orgId: OrgId;
  sessionId: SessionId;
  /** The session as the refresh left it. */
  session: AgentSessionRecord;
  previous: SessionSummary;
  summary: SessionSummary;
  summaryRevision: number;
  statusChanged: boolean;
  stepChanged: boolean;
  /** The refresh that ended the session. */
  ended: boolean;
  at: string;
}

/** A hook told of every committed change (the notification queue is one). A hook's failure is logged and never thrown: a notice is never a reason for a refresh to fail. */
export type SessionChangeHook = (change: SessionChange) => Promise<void>;

export interface SummaryDependencies {
  store: DocumentStore;
  facts: TaskFactsSource;
  cost: SessionCostSource;
  now?: () => Date;
  log?: Log;
  onChange?: readonly SessionChangeHook[];
}

// ---- digest and small helpers

/** SHA-256 of the summary's canonical JSON without `computedAt` (and without the digest itself). */
export function sessionSummaryDigest(summary: Omit<SessionSummary, "digest" | "computedAt">): string {
  return createHash("sha256").update(canonicalJson(summary), "utf8").digest("hex");
}

const SECONDS_PER_DAY = 86_400;
const cleanUsd = (value: number) => Math.round(value * 1e6) / 1e6;
const seconds = (at: string) => Math.floor(Date.parse(at) / 1000);

/** One line, no control or format characters, cut to the summary's step limit. */
const stepText = (text: string): string | undefined => {
  const clean = redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...clean].slice(0, SESSION_TITLE_MAX).join("").trimEnd();
  return cut === "" ? undefined : cut;
};

const peekText = (text: string): string | undefined => {
  const cut = [...redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, SESSION_PEEK_MAX_CHARS).join("");
  return cut === "" ? undefined : cut;
};

// ---- what is computed

type Ended = { status: "succeeded" | "failed" | "cancelled"; at: string };
export interface Computed {
  summary: SessionSummary;
  /** Set when the source says the work is over. */
  ended?: Ended;
}

interface Parts {
  status: SessionStatus;
  step?: string | undefined;
  peek?: string | undefined;
  lastRunFailed?: true | undefined;
  workflowBlocked?: true | undefined;
  costUsd: number;
  runLimitUsd?: number | undefined;
  stopAtUsd?: number | undefined;
  needsPeople?: readonly string[];
  pendingApprovals?: number;
  display?: TaskStatus | undefined;
}

function assemble(parts: Parts, nowMs: number): SessionSummary {
  const needsPeople = [...new Set(parts.needsPeople ?? [])].slice(0, SESSION_NEEDS_PEOPLE_MAX);
  const base = {
    status: parts.status,
    ...(parts.step === undefined ? {} : { step: parts.step }),
    ...(parts.peek === undefined ? {} : { peek: parts.peek }),
    ...(parts.lastRunFailed === undefined ? {} : { lastRunFailed: parts.lastRunFailed }),
    ...(parts.workflowBlocked === undefined ? {} : { workflowBlocked: parts.workflowBlocked }),
    costUsd: cleanUsd(parts.costUsd),
    ...(parts.runLimitUsd === undefined ? {} : { runLimitUsd: parts.runLimitUsd }),
    ...(parts.stopAtUsd === undefined ? {} : { stopAtUsd: parts.stopAtUsd }),
    needsPeople,
    pendingApprovals: parts.pendingApprovals ?? 0,
    ...(parts.display === undefined ? {} : { display: parts.display }),
  };
  return { ...base, digest: sessionSummaryDigest(base), computedAt: new Date(nowMs).toISOString() };
}

/** Whether the work is over, and how. */
function endedOf(facts: SessionTaskFacts, at: string): Ended | undefined {
  const workflow = facts.workflow;
  const closedStatus: Ended["status"] = facts.runStatus === "SUCCEEDED" ? "succeeded" : facts.runStatus === "FAILED" || facts.runStatus === "INTERRUPTED" ? "failed" : "cancelled";
  // A workspace that could not be prepared never started the workflow: its step stays marked running with nothing behind it, and only a close is left. The session ends failed when the preparation does.
  if (workflow !== undefined && facts.failedPrepare !== undefined) return { status: "failed", at: facts.failedPrepare.at ?? at };
  if (workflow?.stage === "MERGED") return { status: "succeeded", at };
  // A question that needed no code change succeeded; a plan that was rejected or a task that was closed did not.
  if (workflow?.stage === "CLOSED" && workflow.outcome === "ANSWERED") return { status: "succeeded", at };
  if (workflow?.stage === "CLOSED") return { status: "cancelled", at };
  // A task the owner closed before its work was merged or answered did not finish and did not fail: it was closed, however its last step ended. A plain task keeps the end of its last run.
  if (facts.closedAt !== undefined) return { status: workflow === undefined ? closedStatus : "cancelled", at };
  return undefined;
}

/** The summary of a task session from the task's facts and its cost. Pure: no store, no clock beyond `nowMs`. */
export function computeTaskState(facts: SessionTaskFacts, costUsd: number, previous: SessionSummary | undefined, nowMs: number): Computed {
  const workflow = facts.workflow;
  const at = facts.closedAt ?? facts.endedAt ?? facts.updatedAt;
  const costs = { costUsd, runLimitUsd: facts.runLimitUsd, stopAtUsd: facts.stopAtUsd };
  const step = facts.step === undefined ? undefined : stepText(facts.step);

  const ended = endedOf(facts, at);
  if (ended !== undefined) {
    return { ended, summary: assemble({ status: ended.status, step, display: facts.display ?? defaultTaskDisplay(facts, ended.status, { ended: true }), ...costs }, nowMs) };
  }

  // Open: the workflow stage decides first, then the last run.
  let status: SessionStatus;
  let openStep = step;
  let lastRunFailed: true | undefined;
  let workflowBlocked: true | undefined;
  const starting = facts.runStatus === "STARTING";
  if (facts.budgetPaused === true) {
    status = "paused";
    // A blocked workflow can still be retried although the budget paused it (the flag lets the session offer the button).
    if (workflow?.state === "BLOCKED") workflowBlocked = true;
  } else if (workflow !== undefined) {
    // A coding run that needed no code change reads as that, not as "Coding" (the person is asked to close the task or ask for a change; nothing is running).
    if (workflow.state === "BLOCKED" && isNoCodeChangedReason(workflow.blockReason)) openStep = NO_CODE_CHANGED_STEP;
    if (workflow.state === "BLOCKED") workflowBlocked = true;
    // Only a stage that waits on a person is not running: a plan under review needs its owner, a blocked task needs someone, a pull request waits to be merged. The checks and reviews also sit in WAITING
    // between runs, but nobody is needed for them. Understand's questions wait for a person too.
    if ((workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") || (workflow.stage === "UNDERSTAND" && workflow.state === "WAITING") || workflow.state === "BLOCKED") status = "needs_person";
    else if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") status = "waiting";
    // A stop that landed before the instructions ran cancels nothing and leaves the step marked running with nothing behind it; the task reads cancelled then, and so does the session.
    else if (facts.runStatus === "CANCELLED" && workflow.state === "RUNNING") status = "stopped";
    else status = starting ? "starting" : "running";
  } else {
    switch (facts.runStatus) {
      case "STARTING": status = "starting"; break;
      case "RUNNING": status = "running"; break;
      case "CANCELLED": status = "stopped"; break;
      case "FAILED":
      case "INTERRUPTED":
        status = "waiting";
        lastRunFailed = true;
        openStep = `Failed: ${failureCause(facts.failureCategory)}`;
        break;
      default: status = "waiting";
    }
  }
  const needsPeople = [...(facts.waitingOn ?? [])];
  // The person the task waits on is its owner; a task that waits on a decision with nobody named waits on the owner.
  if (status === "needs_person" && needsPeople.length === 0) needsPeople.push(facts.ownerDeveloperId);
  if ((workflow?.stage === "PLAN_REVIEW" || workflow?.stage === "UNDERSTAND") && workflow.state === "WAITING" && !needsPeople.includes(facts.ownerDeveloperId)) needsPeople.push(facts.ownerDeveloperId);
  // A run whose events can't be read keeps the peek the summary had: a missing line is not a reason to blank it.
  const peek = facts.peek === undefined ? previous?.peek : peekText(facts.peek);
  const display = facts.display ?? defaultTaskDisplay(facts, status, { lastRunFailed, step: openStep });
  return { summary: assemble({ status, step: openStep, peek, lastRunFailed, workflowBlocked, needsPeople, pendingApprovals: facts.pendingApprovals ?? 0, display, ...costs }, nowMs) };
}

/**
 * The summary of a session from its source records only (each read re-checks the company). A session whose source can't be read keeps the summary it has.
 */
export async function computeSessionSummary(deps: SummaryDependencies, session: AgentSessionRecord): Promise<Computed | undefined> {
  if (session.subject.kind !== "task") return undefined;
  const facts = await deps.facts.read(session.orgId, session.subject.taskId);
  // A task of another company is not this session's task.
  if (facts === undefined || facts.companyId !== session.orgId || facts.taskId !== session.subject.taskId) return undefined;
  const costUsd = await deps.cost.costUsd(session.orgId, facts.taskId);
  return computeTaskState(facts, costUsd, session.summary, (deps.now ?? (() => new Date()))().getTime());
}

// ---- the refresh

/** What an ended session with no status-model words says on its timeline. */
const ENDED_WORDS: Partial<Record<SessionStatus, string>> = { succeeded: "Finished", failed: "Failed: the run stopped with an error", cancelled: "Closed" };

function changeEvent(session: AgentSessionRecord, next: SessionSummary, revision: number, statusChanged: boolean, stepChanged: boolean, ending: boolean): SessionEvent | undefined {
  if (!statusChanged && !stepChanged) return undefined;
  const type = stepChanged && !ending && next.step !== undefined ? "step" as const : "status" as const;
  // The one status model's words; a summary written before it reads its plain status the same way.
  const said = next.display === undefined && ENDED_WORDS[next.status] !== undefined ? ENDED_WORDS[next.status]! : taskStatusText(sessionTaskStatus(next));
  const text = type === "step" ? `${statusChanged ? `${said}. ` : ""}Step: ${next.step ?? ""}` : said;
  return { eventId: sessionEventId(type, `${session.sessionId}:${String(revision)}`), at: next.computedAt, type, actor: { kind: "system" }, text };
}

function tileOf(session: AgentSessionRecord, summary: SessionSummary, revision: number, endedAt: string | undefined): Record<string, unknown> {
  return {
    ...liveSessionKey(session.orgId, session.sessionId), entityType: "LIVE_SESSION", orgId: session.orgId, sessionId: session.sessionId, kind: session.kind,
    ...(session.project === undefined ? {} : { project: session.project }), ownerId: session.owner.developerId, owner: session.owner, title: session.title,
    ...(session.agent === undefined ? {} : { agent: session.agent }), where: session.where, status: summary.status, summary, summaryRevision: revision, revision: session.revision,
    createdAt: session.createdAt, updatedAt: summary.computedAt,
    ...(endedAt === undefined ? {} : { endedAt, [INDEX_EXPIRY_ATTRIBUTE]: seconds(endedAt) + LIVE_ENDED_KEEP_HOURS * 3600 }),
  };
}

/**
 * Recomputes one session's summary and, when its digest differs, writes it: META `summary` and `summaryRevision + 1` (conditional on the revision read; one re-read on a lost race), the live tile, and a
 * `status` or `step` event when either changed (its id comes from the new revision, so it is told once). The first ended summary also sets `endedAt`, takes the session out of the sweep's list and sets
 * its retention. An ended session never reopens, and keeps the status it ended with while its cost catches up.
 */
export async function refreshSessionSummary(deps: SummaryDependencies, orgId: OrgId, sessionId: SessionId): Promise<"unchanged" | "updated"> {
  const sessions = new SessionStore(deps.store);
  const log: Log = deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry })));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await sessions.get(orgId, sessionId);
    if (session === undefined) return "unchanged";
    const state = await computeSessionSummary(deps, session);
    if (state === undefined) return "unchanged";
    const wasEnded = session.endedAt !== undefined;
    if (wasEnded && state.ended === undefined) {
      log({ event: "agent_session.reopen_refused", orgId, sessionId });
      return "unchanged";
    }
    // An ended session keeps the status it ended with.
    const summary = wasEnded && state.summary.status !== session.summary.status
      ? assemble({ ...state.summary, status: session.summary.status }, Date.parse(state.summary.computedAt))
      : state.summary;
    if (summary.digest === session.summary.digest) return "unchanged";
    // What is written must be a summary the schema accepts: a committed one that fails it would make the session unreadable and no refresh could fix it.
    const valid = SessionSummarySchema.safeParse(summary);
    if (!valid.success) {
      log({ event: "agent_session.summary_invalid", orgId, sessionId, problem: valid.error.issues[0]?.path.join(".") ?? "summary" });
      return "unchanged";
    }

    const revision = session.summaryRevision + 1;
    const ending = !wasEnded && state.ended !== undefined;
    const endedAt = wasEnded ? session.endedAt : state.ended?.at;
    const statusChanged = summary.status !== session.summary.status;
    const stepChanged = (summary.step ?? "") !== (session.summary.step ?? "");
    const event = changeEvent(session, summary, revision, statusChanged, stepChanged, ending);
    const items: TransactItem[] = [
      {
        kind: "update", key: agentSessionKey(orgId, sessionId, "META"),
        ops: [
          change.set("summary", jsonOf(summary)), change.set("summaryRevision", revision), change.set("updatedAt", summary.computedAt),
          ...(ending ? [change.set("endedAt", endedAt!), change.set(INDEX_EXPIRY_ATTRIBUTE, seconds(endedAt!) + SESSION_RETENTION_DAYS * SECONDS_PER_DAY)] : []),
        ],
        // Also on the session's own revision: the tile written below carries the header this read saw, so a change of the header in between sends the refresh back to read again.
        condition: when.and(when.present(), when.eq("orgId", orgId), when.eq("summaryRevision", session.summaryRevision), when.eq("revision", session.revision)),
      },
      { kind: "put", item: jsonOf(tileOf(session, summary, revision, endedAt)) },
      ...(event === undefined ? [] : [sessionEventItem({ orgId, sessionId }, event)]),
      ...(ending ? [{ kind: "delete" as const, key: openAgentSessionKey(orgId, sessionId) }] : []),
    ];
    const result = await deps.store.transact(items);
    // Another refresh got there first (or the event is already told): look again, once.
    if (!result.applied) continue;
    // The change is committed: a record that can't be built for the hooks is logged, never thrown.
    let written: AgentSessionRecord;
    try {
      written = AgentSessionRecordSchema.parse({ ...session, summary, summaryRevision: revision, updatedAt: summary.computedAt, ...(endedAt === undefined ? {} : { endedAt }) });
    } catch (error) {
      log({ event: "agent_session.notice_record_invalid", orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
      return "updated";
    }
    const committed: SessionChange = { orgId, sessionId, session: written, previous: session.summary, summary, summaryRevision: revision, statusChanged, stepChanged, ended: ending, at: summary.computedAt };
    for (const hook of deps.onChange ?? []) {
      try { await hook(committed); } catch (error) { log({ event: "agent_session.notice_hook_failed", sessionId, error: error instanceof Error ? error.name : "unknown" }); }
    }
    return "updated";
  }
  return "unchanged";
}
