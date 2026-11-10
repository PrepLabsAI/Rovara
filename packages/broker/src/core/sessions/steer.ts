// What becomes of a message to the agent after it is saved (the hosted product's `agent-sessions/steer.ts`, the parts that are not the route). A queued message becomes `delivered` when the
// task's `threadNotesFedThrough` passes its note (`settleSteerDeliveries`, run by the session's summary refresh) or when the running step took it live (`answerMessage`), and when the session ends the messages no
// step took are made `not_delivered` (`closeQueuedSteers`). The session counts its queued messages (`sessionQueuedSteersKey`), so a session with none is not searched. No log line, event or notice holds a message's text.
import {
  AppNoteSchema, INDEX_EXPIRY_ATTRIBUTE, LIVE_STEER_REAPPROVAL_REASON, LIVE_STEER_REVISED_REASON, SESSION_RETENTION_DAYS, SessionMessageSchema, agentSessionKey, change, sessionEventId, sessionQueuedSteersKey, when,
  type AgentSessionRecord, type AppNote, type DocumentStore, type OrgId, type SessionId, type SessionMessage, type TransactItem,
} from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import type { TaskRecord } from "../task-flow/records.js";
import { noteKey } from "./notes.js";
import { SessionStore, sessionEventItem } from "./store.js";

/** What the agent's name is when a session has none. */
const THE_AGENT = "The agent";

// ---- the words a refusal or a delivery says

export const PLAIN_TASK_REASON = "this task takes instructions only from its owner's next request";
export const TASK_FULL_REASON = "this task already holds all the messages it keeps";
export const SESSION_ENDED_REASON = "the session has ended";
/** What a message to a task that waits for answers is told (Rovara asked questions and no step reads a note until they are answered). */
export const WAITING_FOR_ANSWERS_REASON = (sessionId: string): string => `it is waiting for your answers to its questions; answer them on the task's page, with rovara session answer ${sessionId}, or with the answer tool`;

/** Where a message goes now: a note for the task's next step, or the reason it cannot be delivered. */
export type SteerRoute = { kind: "note" } | { kind: "not_delivered"; reason: string } | { kind: "ended" };

/** Whether the task is waiting for the owner's answers to Understand's questions (nothing reads a note until they are given). */
const waitingForAnswers = (workflow: TaskRecord["workflow"]): boolean => {
  const asked = workflow?.intent?.assessment;
  return workflow?.definitionVersion === "1.1.0" && workflow.stage === "UNDERSTAND" && workflow.state === "WAITING" && asked?.kind === "questions";
};

/** Where a message to this task's session goes (before anything is written). */
export function routeOfTask(session: Pick<AgentSessionRecord, "sessionId">, task: Pick<TaskRecord, "closedAt" | "workflow"> | undefined): SteerRoute {
  const ended = task === undefined || task.closedAt !== undefined || task.workflow?.stage === "MERGED" || task.workflow?.stage === "CLOSED";
  if (ended) return { kind: "ended" };
  if (waitingForAnswers(task.workflow)) return { kind: "not_delivered", reason: WAITING_FOR_ANSWERS_REASON(session.sessionId) };
  if (task.workflow !== undefined) return { kind: "note" };
  return { kind: "not_delivered", reason: PLAIN_TASK_REASON };
}

const isoOf = (ms: number): string => new Date(ms).toISOString();
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", INDEX_EXPIRY_ATTRIBUTE]);

export const messageKey = (session: { orgId: OrgId; sessionId: string }, messageId: string) => agentSessionKey(session.orgId, session.sessionId, `MESSAGE#${messageId}`);

export function messageOf(item: Record<string, unknown> | undefined, session: { orgId: OrgId; sessionId: string }): SessionMessage | undefined {
  if (item === undefined || item["orgId"] !== session.orgId || item["sessionId"] !== session.sessionId) return undefined;
  const parsed = SessionMessageSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? parsed.data : undefined;
}

// ---- the queue's count and the answers

/** What a delivery answer says: the session's own words, one per answer. */
const answerText = (session: AgentSessionRecord, author: string, answer: { state: "delivered" } | { state: "not_delivered"; reason: string }): string =>
  answer.state === "delivered" ? `${session.agent?.name ?? THE_AGENT} got ${author}'s message.` : `${session.agent?.name ?? THE_AGENT} can't take messages right now: ${answer.reason}.`;

/**
 * The session's count of queued messages to the agent going up (`1`, in the transaction that writes a queued message) or down (`-1`, in the one that answers it). Never conditional: the message's own condition
 * (it is queued, or it is new) is what makes each message count once.
 */
export function queuedSteersItem(session: Pick<AgentSessionRecord, "orgId" | "sessionId">, amount: 1 | -1, nowMs: number): TransactItem {
  return {
    kind: "update", key: sessionQueuedSteersKey(session.orgId, session.sessionId),
    ops: [
      change.set("entityType", "AGENT_SESSION_QUEUED_STEERS"), change.set("orgId", session.orgId), change.set("sessionId", session.sessionId),
      change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor(nowMs / 1000) + SESSION_RETENTION_DAYS * 86_400), change.add("count", amount),
    ],
  };
}

/** How many messages to the agent the session counts as queued; 0 when it has never counted one. */
async function queuedCount(store: Pick<DocumentStore, "get">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">): Promise<number> {
  const count = (await store.get(sessionQueuedSteersKey(session.orgId, session.sessionId)))?.["count"];
  return typeof count === "number" ? count : 0;
}

export interface SteerDeps {
  store: DocumentStore;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Answers a queued message: its `delivery`, the queue's count down by one, any `extra` items, and the session's own event for it. When a condition on the message or an extra item fails, the message was
 * answered already: the answer is the message as it is stored (`wrote` false). The event is only written if it is not told yet (it is its own conditional put, so a repeat is refused alone).
 */
export async function answerMessage(
  deps: SteerDeps, session: AgentSessionRecord, message: SessionMessage, answer: { state: "delivered" } | { state: "not_delivered"; reason: string }, extra: readonly TransactItem[] = [],
): Promise<{ message: SessionMessage | undefined; wrote: boolean }> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const at = isoOf(nowMs);
  const type = answer.state === "delivered" ? "steer_delivered" : "steer_not_delivered";
  const base: TransactItem[] = [
    ...extra,
    {
      kind: "update", key: messageKey(session, message.messageId),
      ops: [change.set("delivery", { state: answer.state, at, ...(answer.state === "not_delivered" ? { reason: answer.reason } : {}) })],
      condition: when.and(when.present(), when.eq(["delivery", "state"], "queued")),
    },
    queuedSteersItem(session, -1, nowMs),
  ];
  const event = sessionEventItem(session, {
    eventId: sessionEventId(type, message.messageId), at, type, actor: { kind: "agent" }, source: message.source === "linear" ? "linear" : "app", messageId: message.messageId,
    text: answerText(session, message.author.name, answer),
  });
  const read = async (): Promise<SessionMessage | undefined> => messageOf(await deps.store.get(messageKey(session, message.messageId)), session);
  const first = await deps.store.transact([...base, event]);
  if (first.applied) return { message: await read(), wrote: true };
  // Only the event refused (it is told already): the rest is written without it.
  const eventIndex = base.length;
  if (first.failed.length === 1 && first.failed[0] === eventIndex) {
    const second = await deps.store.transact(base);
    return { message: await read(), wrote: second.applied };
  }
  // A condition on the message or an extra item failed: the message was answered, or the note settled, by another run. What is stored is the answer.
  return { message: await read(), wrote: false };
}

// ---- telling the session a step took a message

const SETTLE_MAX = 50;

/**
 * Marks the session's queued messages `delivered` for every note the task's `threadNotesFedThrough` has passed: the message's delivery, a `steer_delivered` event and the note's `settledAt` go in one transaction,
 * so each message is told once, and a note already settled or a message already answered is left alone. Answers how many messages it marked.
 */
export async function settleSteerDeliveries(deps: SteerDeps, session: AgentSessionRecord): Promise<number> {
  if (session.subject.kind !== "task") return 0;
  // A session with no queued message has nothing to settle: the task's notes are not read at all.
  if (await queuedCount(deps.store, session) <= 0) return 0;
  const taskId = session.subject.taskId;
  const task = (await deps.store.get(taskKey(taskId))) as TaskRecord | undefined;
  if (task === undefined || task.threadNotesFedThrough === undefined || (task.threadNoteCount ?? 0) === 0) return 0;
  const through = task.threadNotesFedThrough;
  const due: AppNote[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "NOTE#msg_" }, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const parsed = AppNoteSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key) && key !== "pk" && key !== "sk")));
      if (parsed.success && parsed.data.sessionId === session.sessionId && parsed.data.settledAt === undefined && parsed.data.receivedAt <= through) due.push(parsed.data);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  let delivered = 0;
  const nowIso = isoOf((deps.now ?? (() => new Date()))().getTime());
  for (const note of due.slice(0, SETTLE_MAX)) {
    const message = messageOf(await deps.store.get(messageKey(session, note.messageId)), session);
    const settled: TransactItem = { kind: "update", key: noteKey(taskId, note.messageId), ops: [change.set("settledAt", nowIso)], condition: when.and(when.present(), when.notExists("settledAt")) };
    if (message?.delivery?.state !== "queued") {
      // Nothing to tell (the message is gone or was answered otherwise): the note is settled so it is not looked at again.
      await deps.store.transact([settled]);
      continue;
    }
    if ((await answerMessage(deps, session, message, { state: "delivered" }, [settled])).wrote) delivered += 1;
  }
  return delivered;
}

/** The most messages one look closes on an ended session; a session with more is closed by its next look. */
const CLOSE_MAX = 100;

/**
 * When a session has ended, its messages to the agent that no step took can never be delivered: each is made `not_delivered` with a fixed reason and the session's own event, in one transaction with the queue's
 * count going down, so it is told once. Answers how many it closed. Nothing happens for a session that has not ended, or that counts no queued message. Run after `settleSteerDeliveries`, so a message a step did
 * take is `delivered` first.
 */
export async function closeQueuedSteers(deps: SteerDeps, session: AgentSessionRecord): Promise<number> {
  if (session.endedAt === undefined || await queuedCount(deps.store, session) <= 0) return 0;
  const queued: SessionMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.query({ pk: agentSessionKey(session.orgId, session.sessionId, "META").pk, sk: { op: "beginsWith", prefix: "MESSAGE#msg_" }, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const message = messageOf(item, session);
      if (message?.kind === "steer" && message.delivery?.state === "queued" && queued.length < CLOSE_MAX) queued.push(message);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && queued.length < CLOSE_MAX);
  let closed = 0;
  for (const message of queued) {
    if ((await answerMessage(deps, session, message, { state: "not_delivered", reason: SESSION_ENDED_REASON })).wrote) closed += 1;
  }
  return closed;
}

/** `settleSteerDeliveries` and, for an ended session, `closeQueuedSteers`, for a session known by id: reads it, and never throws (a mark it can't make is made by the next refresh). */
export async function settleSteerDeliveriesFor(deps: SteerDeps, orgId: OrgId, sessionId: SessionId): Promise<void> {
  try {
    const session = await new SessionStore(deps.store).get(orgId, sessionId);
    if (session === undefined) return;
    await settleSteerDeliveries(deps, session);
    await closeQueuedSteers(deps, session);
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_settle_failed", sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
}


// ---- a step stopped for re-approval

/** The agent's own words for a message a step stopped for. */
const needsApprovalText = (session: AgentSessionRecord, author: string): string =>
  `${session.agent?.name ?? THE_AGENT} needs the owner's approval for ${author}'s message: it asks for a change outside the approved plan.`;

/**
 * A step stopped because the owner's live message asked for a change outside the approved plan: the message says so on its row (`needs re-approval`) and on the session's timeline. Only a message that was
 * delivered and has no reason yet is marked, so a repeat, a message of another session and a comment are left alone. Never throws. Answers whether it marked the message.
 */
export async function markSteerNeedsReapproval(deps: SteerDeps, orgId: OrgId, sessionId: SessionId, messageId: string): Promise<boolean> {
  try {
    const session = await new SessionStore(deps.store).get(orgId, sessionId);
    if (session === undefined) return false;
    const message = messageOf(await deps.store.get(messageKey(session, messageId)), session);
    if (message?.kind !== "steer" || message.delivery?.state !== "delivered" || message.delivery.reason !== undefined) return false;
    const at = isoOf((deps.now ?? (() => new Date()))().getTime());
    const marked: TransactItem = {
      kind: "update", key: messageKey(session, messageId), ops: [change.set("delivery", { state: "delivered", at: message.delivery.at, reason: LIVE_STEER_REAPPROVAL_REASON })],
      condition: when.and(when.present(), when.eq(["delivery", "state"], "delivered"), when.notExists(["delivery", "reason"])),
    };
    const event = sessionEventItem(session, { eventId: sessionEventId("steer_needs_reapproval", messageId), at, type: "status", actor: { kind: "agent" }, source: message.source === "linear" ? "linear" : "app", messageId, text: needsApprovalText(session, message.author.name) });
    const first = await deps.store.transact([marked, event]);
    if (first.applied) return true;
    // Only the event refused (it is told already): the mark is written without it.
    if (first.failed.length === 1 && first.failed[0] === 1) return (await deps.store.transact([marked])).applied;
    return false;
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_reapproval_mark_failed", orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * A step ended before the owner approved "Revise the plan with this change": the message says what became of it (`plan being revised`), with no text. The same rules as `markSteerNeedsReapproval`:
 * only a message that is marked "needs re-approval" is changed. Never throws; answers whether it marked the message.
 */
export async function markSteerRevised(deps: SteerDeps, orgId: OrgId, sessionId: SessionId, messageId: string): Promise<boolean> {
  try {
    const session = await new SessionStore(deps.store).get(orgId, sessionId);
    if (session === undefined) return false;
    const message = messageOf(await deps.store.get(messageKey(session, messageId)), session);
    if (message?.kind !== "steer" || message.delivery?.state !== "delivered" || message.delivery.reason !== LIVE_STEER_REAPPROVAL_REASON) return false;
    const at = isoOf((deps.now ?? (() => new Date()))().getTime());
    const marked: TransactItem = {
      kind: "update", key: messageKey(session, messageId), ops: [change.set("delivery", { state: "delivered", at: message.delivery.at, reason: LIVE_STEER_REVISED_REASON })],
      condition: when.and(when.present(), when.eq(["delivery", "state"], "delivered"), when.eq(["delivery", "reason"], LIVE_STEER_REAPPROVAL_REASON)),
    };
    const event = sessionEventItem(session, {
      eventId: sessionEventId("steer_plan_revised", messageId), at, type: "status", actor: { kind: "agent" }, source: message.source === "linear" ? "linear" : "app", messageId,
      text: `${session.agent?.name ?? THE_AGENT} is revising the plan with ${message.author.name}'s message. The owner approves the revised plan before any coding.`,
    });
    const first = await deps.store.transact([marked, event]);
    if (first.applied) return true;
    if (first.failed.length === 1 && first.failed[0] === 1) return (await deps.store.transact([marked])).applied;
    return false;
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_revised_mark_failed", orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/** A steer message of this session, as stored, or `undefined` when it is not one (another session's, a comment, gone). Read for the owner's "Revise the plan" press, which hands its text to the planner and nowhere else: the caller never logs it. */
export async function readSteerMessage(store: Pick<DocumentStore, "get">, orgId: OrgId, sessionId: SessionId, messageId: string): Promise<SessionMessage | undefined> {
  const message = messageOf(await store.get(messageKey({ orgId, sessionId }, messageId)), { orgId, sessionId });
  return message?.kind === "steer" ? message : undefined;
}

/**
 * A step that took live messages and then did not succeed will run again, and its re-run never received them: their notes stop saying "already given to the running step" so the re-run reads them as the messages they
 * are (information only). Scoped to the attempt that ended: only a note marked live at or after `sinceIso` (when that attempt's operation was created) is cleared, so a message given live to an earlier step that
 * succeeded keeps its mark. Never throws; answers how many notes it cleared. No message text is read into a log or an error.
 */
export async function clearLiveDeliveredSince(deps: SteerDeps, taskId: string, sinceIso: string): Promise<number> {
  let cleared = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await deps.store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "NOTE#msg_" }, filter: when.exists("liveDeliveredAt"), ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) {
        const at = item["liveDeliveredAt"];
        if (typeof at !== "string" || at < sinceIso) continue;
        const result = await deps.store.update({ key: { pk: `DEVTASK#${taskId}`, sk: String(item["sk"]) }, ops: [change.remove("liveDeliveredAt")], condition: when.and(when.present(), when.eq("liveDeliveredAt", at)) });
        if (result.applied) cleared += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_live_mark_clear_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
  }
  return cleared;
}
