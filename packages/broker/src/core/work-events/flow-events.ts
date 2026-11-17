// Work events from the task flow (lead 4, slice A4): the facts the cost report splits time with. "Rovara working", "waiting on people" (a plan to approve, a question, a spend approval, a pull request review) and "waiting on
// the system" (a step queued for a machine), and the send-backs, all come from what the workflow snapshot says changed.
//
// ONE pure function reads a transition (the snapshot before and the snapshot after) and says which events it made (`flowEventsOf`); `flowWorkEventItems` turns them into the items that join the transaction of the change
// that caused them (the writer's own rule: the events exist exactly when the change committed). The task flow's two writers (`acceptStep`, `commitWorkflow`), the decision service and merge tracking call it with the
// snapshots they already hold; nothing else in the flow knows about events.
//
// The rules the writer keeps, each tested:
//   - It NEVER fails a step. Nothing here throws (a snapshot it cannot read, an invalid event, a transaction with no room left: no events, and `onSkip` is told); the event rows are unconditional puts of keys no
//     other row uses, so they cannot be the reason a transaction is refused. Off (the default) it adds nothing, so every transaction is exactly what it was.
//   - Idempotent per event: the id comes from the change (`workEventId`: kind, task, and the workflow revision or the decision's request id), so the same change is the same row.
//   - Bounded: at most `FLOW_EVENTS_MAX` events per change and never past the transaction's 100 items.
//   - Content-free and person-free: the actor of every event is the system (or the agent for a step); WHO decided is in the closed word of `place` (`person_*` or `rovara_*`), never an id. So person erase has nothing to rewrite.
//   - Company and project keyed: the row is in the company's own event partition, and carries the project.
//
// What a transition says (the closed words below are the report's vocabulary; `report/times.ts` folds them):
//   waiting_changed   the wait changed: `agent` (a step runs), `system` (queued), `person` with a reason (`plan_approval`, `answer`, `design_choice`, `approval`, `spend_approval`, `blocked`, `pr_review`), `none` (done)
//   step_started/ended  a step began or ended (the step is the stage, lower case); a retry is a second `step_started`
//   decision_answered   one new decision record; `place` says who and how (`person_gate`, `person_send_back`, `person_findings`, `rovara_auto_fix`, `rovara_auto_retry`, `person_pr_feedback`, `rovara_ci_fix`)
//   a send-back is a `decision_answered` with outcome `changes_requested` and a `person_*` or `rovara_*` place (an automatic retry is outcome `answered`, never a send-back)
import { isRunLimitBlockReason, WORKFLOW_BLOCK_REASONS, workEventId, type OrgId, type TransactItem, type WorkEventInput, type WorkflowSnapshot } from "@agentx/contracts";
import { workEventItems } from "./work-events.js";

/** The most events one change adds. A change that would make more keeps the most important first (the wait, the send-backs) and leaves the rest out. */
export const FLOW_EVENTS_MAX = 12;
/** A transaction holds at most this many items; events are added only when they all fit. */
export const TRANSACTION_ITEMS_MAX = 100;

/** Who the work waits for, with the reason (a closed word), as the workflow says it. */
export interface FlowWait { on: "person" | "agent" | "system" | "none"; reason?: string }

/** What a workflow snapshot is waiting for. Total: every snapshot has an answer. */
export function waitOf(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason">): FlowWait {
  if (workflow.stage === "MERGED" || workflow.stage === "CLOSED" || workflow.state === "COMPLETE") return { on: "none" };
  switch (workflow.state) {
    case "RUNNING": return { on: "agent" };
    case "READY": return { on: "system", reason: "queued" };
    case "WAITING":
      if (workflow.stage === "PLAN_REVIEW") return { on: "person", reason: "plan_approval" };
      if (workflow.stage === "UNDERSTAND") return { on: "person", reason: "answer" };
      if (workflow.stage === "WAIT_FOR_MERGE") return { on: "person", reason: "pr_review" };
      if (workflow.stage === "PLAN_CRITIQUE") return { on: "person", reason: "design_choice" };
      return { on: "person", reason: "approval" };
    case "BLOCKED":
      return { on: "person", reason: workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused || isRunLimitBlockReason(workflow.blockReason) ? "spend_approval" : "blocked" };
    default: return { on: "none" };
  }
}

const sameWait = (a: FlowWait, b: FlowWait): boolean => a.on === b.on && (a.reason ?? "") === (b.reason ?? "");
const stepOf = (stage: string): string => stage.toLowerCase();
const instantOf = (value: string): string => new Date(Date.parse(value)).toISOString();
const ownerOutcome: Record<string, "merged" | "closed_unmerged" | "answered" | "plan_rejected" | "passed" | "skipped" | "changes_requested"> = {
  MERGED: "merged", CLOSED: "closed_unmerged", ANSWERED: "answered", REJECTED: "plan_rejected", PASSED: "passed", SKIPPED: "skipped", CHANGES_REQUESTED: "changes_requested",
};

export interface FlowEventContext { orgId: OrgId; project: string }

/**
 * The events one transition makes, most important first. `before` is the snapshot the writer read (absent: none); `after` is what it writes. A transition that does not move the revision makes none (it is the same
 * change, or a write the flow carries without a revision). Pure and total: it never throws; a snapshot it cannot read gives no events.
 */
export function flowEventsOf(before: WorkflowSnapshot | undefined, after: WorkflowSnapshot, context: FlowEventContext): WorkEventInput[] {
  try {
    if (before !== undefined && (before.revision === after.revision || before.taskId !== after.taskId)) return [];
    // Strictly after the snapshot before, so two waits of one task never share an instant (the report orders by time, and a tie would be settled by an id hash).
    const at = instantOf(before === undefined ? after.updatedAt : new Date(Math.max(Date.parse(after.updatedAt), Date.parse(before.updatedAt) + 1)).toISOString());
    const common = { version: 1 as const, at, orgId: context.orgId, project: context.project, taskId: after.taskId };
    const id = (kind: WorkEventInput["kind"], source: string): string => workEventId({ kind, taskId: after.taskId, source });
    const system = { kind: "system" as const };
    const agent = { kind: "agent" as const };
    const events: WorkEventInput[] = [];
    const wasWaiting = before === undefined ? undefined : waitOf(before);
    const nowWaiting = waitOf(after);
    const revision = String(after.revision);
    // 1. The wait: the fact the report's time split is made from.
    if (wasWaiting === undefined || !sameWait(wasWaiting, nowWaiting)) {
      events.push({ ...common, id: id("waiting_changed", revision), kind: "waiting_changed", actor: system, waitingOn: nowWaiting.on, ...(nowWaiting.reason === undefined ? {} : { reason: nowWaiting.reason }) });
    }
    // 2. Send-backs and decisions: the decision records this transition added (by request id), and the fix rounds it counted.
    const knownDecisions = new Set((before?.decisions ?? []).map((decision) => decision.requestId));
    for (const decision of after.decisions ?? []) {
      if (knownDecisions.has(decision.requestId)) continue;
      const byRovara = decision.actorRole === "AGENTX";
      const retry = decision.source === "AUTO_RETRY";
      const outcome = retry ? "answered" : decision.decision === "APPROVE" ? "approved" : decision.decision === "REJECT" ? "rejected" : decision.decision === "REQUEST_CHANGES" ? "changes_requested" : "answered";
      events.push({
        ...common, id: id("decision_answered", decision.requestId), kind: "decision_answered", actor: system, decisionId: decision.requestId, decision: stepOf(before?.stage ?? after.stage), outcome,
        place: `${byRovara ? "rovara" : "person"}_${(decision.source ?? "GATE").toLowerCase()}`,
      });
      if (decision.decision === "APPROVE" && before?.stage === "PLAN_REVIEW") {
        events.push({ ...common, id: id("plan_approved", decision.requestId), kind: "plan_approved", actor: system, ...(after.risk === undefined ? {} : { risk: after.risk.level }) });
      }
    }
    const knownFeedback = new Set((before?.feedbackDecisions ?? []).map((decision) => decision.requestId));
    for (const decision of after.feedbackDecisions ?? []) {
      // Only an approved round is changes people asked for in the pull request; a dismissal or a request to review again sends nothing back.
      if (knownFeedback.has(decision.requestId) || decision.decision !== "APPROVE") continue;
      events.push({
        ...common, id: id("decision_answered", decision.requestId), kind: "decision_answered", actor: system, decisionId: decision.requestId, decision: "pr_feedback", outcome: "changes_requested", place: "person_pr_feedback",
      });
    }
    const ciBefore = before?.fixRounds?.ci ?? 0;
    const ciAfter = after.fixRounds?.ci ?? 0;
    if (before !== undefined && ciAfter > ciBefore) {
      events.push({ ...common, id: id("decision_answered", `ci:${String(ciAfter)}`), kind: "decision_answered", actor: system, decisionId: `ci-${String(ciAfter)}`, decision: "ci_fix", outcome: "changes_requested", place: "rovara_ci_fix" });
    }
    // 3. Steps.
    const wasRunning = before?.state === "RUNNING";
    const isRunning = after.state === "RUNNING";
    if (before !== undefined && wasRunning && (!isRunning || before.stage !== after.stage)) {
      const stopped = after.state === "BLOCKED" ? (nowWaiting.reason === "spend_approval" ? { outcome: "stopped" as const, cause: "budget_paused" as const } : { outcome: "failed" as const, cause: "other" as const })
        : after.stage === "CLOSED" && after.outcome !== "MERGED" ? { outcome: "stopped" as const, cause: "cancelled" as const } : { outcome: "done" as const };
      events.push({ ...common, id: id("step_ended", revision), kind: "step_ended", actor: agent, step: stepOf(before.stage), ...stopped });
    }
    if (isRunning && !(wasRunning && before?.stage === after.stage)) {
      events.push({ ...common, id: id("step_started", revision), kind: "step_started", actor: agent, step: stepOf(after.stage) });
    }
    // 4. Questions put to a person.
    if (nowWaiting.on === "person" && (wasWaiting === undefined || !sameWait(wasWaiting, nowWaiting)) && ["plan_approval", "answer", "design_choice", "spend_approval"].includes(nowWaiting.reason ?? "")) {
      events.push({ ...common, id: id("decision_asked", revision), kind: "decision_asked", actor: system, decisionId: `rev-${revision}`, decision: nowWaiting.reason!, ...(after.risk === undefined ? {} : { risk: after.risk.level }) });
    }
    // 5. Pull requests and the end.
    const was = new Map((before?.pullRequests ?? []).map((pullRequest) => [`${pullRequest.repositoryId}#${String(pullRequest.number)}`, pullRequest.state]));
    for (const pullRequest of (after.pullRequests ?? []).slice(0, 8)) {
      const key = `${pullRequest.repositoryId}#${String(pullRequest.number)}`;
      const prior = was.get(key);
      const pr = { ...common, actor: system, repository: pullRequest.repositoryId, number: pullRequest.number };
      if (prior === undefined) events.push({ ...pr, id: id("pr_opened", key), kind: "pr_opened" });
      if (pullRequest.state === "MERGED" && prior !== "MERGED") events.push({ ...pr, id: id("pr_merged", key), kind: "pr_merged" });
      if (pullRequest.state === "CLOSED" && prior !== "CLOSED") events.push({ ...pr, id: id("pr_closed", `${key}@${revision}`), kind: "pr_closed" });
    }
    const ended = (stage: string): boolean => stage === "MERGED" || stage === "CLOSED";
    if (ended(after.stage) && !(before !== undefined && ended(before.stage))) {
      events.push({ ...common, id: id("task_closed", "end"), kind: "task_closed", actor: system, outcome: after.outcome === undefined ? (after.stage === "MERGED" ? "merged" : "closed_unmerged") : ownerOutcome[after.outcome] ?? "closed_unmerged" });
    }
    return events;
  } catch {
    return [];
  }
}

export interface FlowWorkEventInput extends FlowEventContext {
  /** The flow's switch (`workEvents`): anything but `true` adds nothing. */
  enabled: boolean | undefined;
  before: WorkflowSnapshot | undefined;
  after: WorkflowSnapshot;
  /** How many more items the transaction can take (the caller counts what it holds already). */
  room: number;
  /** Told once for each event left out (never its content). */
  onSkip?: ((reason: "invalid" | "too_many" | "duplicate" | "no_room") => void) | undefined;
}

/** The items for the events one transition made, to add to the transaction of the change. Never throws; empty when off, when the transition made none, or when they do not all fit. */
export function flowWorkEventItems(input: FlowWorkEventInput): TransactItem[] {
  try {
    if (input.enabled !== true) return [];
    const made = flowEventsOf(input.before, input.after, { orgId: input.orgId, project: input.project });
    if (made.length === 0) return [];
    const wanted = made.slice(0, FLOW_EVENTS_MAX);
    for (let skipped = made.length - wanted.length; skipped > 0; skipped -= 1) input.onSkip?.("too_many");
    const items = workEventItems(wanted, input.onSkip);
    // All or nothing against the transaction's size: a timeline with holes is worse than none, and a transaction past its limit would be refused whole.
    if (items.length > input.room || items.length > Math.max(0, TRANSACTION_ITEMS_MAX - 1)) {
      input.onSkip?.("no_room");
      return [];
    }
    return items;
  } catch {
    return [];
  }
}

export interface StartWorkEventInput {
  companyId: OrgId;
  taskId: string;
  project: string;
  /** Where the task started, as the report says it (`reportOriginOf`). */
  origin: string;
  receivedAt: string;
  /** The workflow the task starts with (absent for a task that has none): what it waits for at its first moment is read from it, so a task that starts running is not called queued. */
  workflow?: WorkflowSnapshot | undefined;
}

/**
 * The events of a task's start, in the start's own transaction: it started, and what it waits for first (from the snapshot it starts with: `RUNNING` is the agent, `READY` is queued). Never throws; none when an
 * event is not valid.
 */
export function startWorkEventItems(input: StartWorkEventInput): TransactItem[] {
  try {
    const started: WorkEventInput = { version: 1, at: input.receivedAt, orgId: input.companyId, project: input.project, taskId: input.taskId, actor: { kind: "system" }, id: workEventId({ kind: "task_started", taskId: input.taskId, source: "start" }), kind: "task_started", origin: input.origin };
    const first = input.workflow === undefined ? [] : flowEventsOf(undefined, input.workflow, { orgId: input.companyId, project: input.project });
    return workEventItems([started, ...first]);
  } catch {
    return [];
  }
}
