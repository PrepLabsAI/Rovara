// A task session is created with the task it wraps (lane L6b, inventory B6): `createTaskSessionItems` returns the steps that join the task's own start transaction, so the task and its session exist
// together or not at all. One developer owns every session on a Code install (the local owner), so there is no share, follower or "started for someone else" in the items.
import { createHash } from "node:crypto";
import {
  AgentSessionRecordSchema, SESSION_TITLE_MAX, agentSessionKey, cleanSessionName, liveSessionKey, mySessionsKey, openAgentSessionKey, projectSessionsKey, redactText, sessionEventId, sessionLegSk, when,
  type AgentSessionRecord, type OrgId, type Payer, type Principal, type SessionEvent, type SessionLeg, type TransactItem, type WorkOrigin,
} from "@agentx/contracts";
import { sessionEventItem, jsonOf } from "./store.js";

const UNTITLED = "Untitled task";

/**
 * The title a session shows: redacted first (so the cut can't leave half a token), invisible and control characters turned into spaces, and cut to `SESSION_TITLE_MAX` characters. The caller passes a
 * title that already went through the task flow's own cleaning of a title.
 */
export function sessionTitle(title: string): string {
  const clean = redactText(title).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...clean].slice(0, SESSION_TITLE_MAX).join("").trimEnd();
  return cut === "" ? UNTITLED : cut;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The id the session names a person by (64 hex): a hash of their Rovara person id, so the id says nothing about the person and is the same in every record. */
export function developerIdOf(principal: Pick<Principal, "provider" | "personId">): string {
  return sha256(`developer\u0000${principal.provider}\u0000${principal.personId}`);
}

export interface TaskSessionInput {
  orgId: OrgId;
  sessionId: string;
  taskId: string;
  project: string;
  agent: { agentId: string; name: string; version: number | "draft" };
  title: string;
  /** The person who owns the session: the local owner, as the identity adapter names them. */
  owner: Pick<Principal, "provider" | "personId" | "displayName">;
  origin: WorkOrigin;
  payer: Payer;
  /** The start's time (an instant): the session, its leg, its event and its index entries are all stamped with it. */
  now: string;
}

/** The one session id a task gets: derived from the task id, so two starts that race write the same items and the loser's transaction is refused instead of making a second session. */
export function taskSessionId(taskId: string): string {
  return `ses_${sha256(`task-session\n${taskId}`).slice(0, 20)}`;
}

/** The header record a new task session starts with, its first leg alongside. */
export function taskSessionHeader(input: TaskSessionInput): { record: AgentSessionRecord; leg: SessionLeg } {
  const owner = cleanSessionName(input.owner.displayName) ?? "Someone";
  const agentName = cleanSessionName(input.agent.name) ?? input.agent.agentId;
  const subject = { kind: "task" as const, taskId: input.taskId };
  const where = { kind: "cloud" as const };
  const leg: SessionLeg = { seq: 1, subject, where, startedAt: input.now };
  const summary = { status: "starting" as const, costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: sha256("starting"), computedAt: input.now };
  const developerId = developerIdOf(input.owner);
  const record = AgentSessionRecordSchema.parse({
    orgId: input.orgId, sessionId: input.sessionId, kind: "task", mode: "delegate", subject, legs: [leg], where, project: input.project,
    agent: { agentId: input.agent.agentId, name: agentName, version: input.agent.version }, title: sessionTitle(input.title), owner: { developerId, name: owner },
    startedBy: { kind: "member", developerId }, origin: input.origin, payer: input.payer, followerCount: 0, summary, summaryRevision: 1, revision: 1, createdAt: input.now, updatedAt: input.now,
  } satisfies Record<string, unknown>);
  return { record, leg };
}

const putNew = (key: { pk: string; sk: string }, entityType: string, fields: Record<string, unknown>): TransactItem => ({ kind: "put", item: { ...key, entityType, ...jsonOf(fields) }, condition: when.absent() });

/**
 * The steps of a new task session: the `META` header (status "starting", revision 1), its first leg, the `started` event, the entry that lists it for its owner, its project, the live wall and the sweep.
 * Each is written only if absent. The task's own record carries the `sessionId` (the caller writes that).
 */
export function createTaskSessionItems(input: TaskSessionInput): TransactItem[] {
  const { record, leg } = taskSessionHeader(input);
  const { orgId, sessionId } = record;
  const owner = record.owner.name;
  const event: SessionEvent = {
    eventId: sessionEventId("started", sessionId), at: input.now, type: "started", actor: { kind: "member", developerId: record.owner.developerId, name: owner },
    text: `${owner} started ${record.agent?.name ?? "the agent"}: ${record.title}`,
  };
  return [
    putNew(agentSessionKey(orgId, sessionId, "META"), "AGENT_SESSION", { ...record }),
    putNew(agentSessionKey(orgId, sessionId, sessionLegSk(leg.seq)), "AGENT_SESSION_LEG", { orgId, sessionId, ...leg }),
    sessionEventItem({ orgId, sessionId }, event),
    putNew(mySessionsKey(orgId, record.owner.developerId, input.now, sessionId), "MY_SESSION", { orgId, sessionId, developerId: record.owner.developerId, createdAt: input.now }),
    putNew(projectSessionsKey(orgId, input.project, input.now, sessionId), "PROJECT_SESSION", { orgId, sessionId, project: input.project, createdAt: input.now }),
    putNew(liveSessionKey(orgId, sessionId), "LIVE_SESSION", { orgId, sessionId, kind: "task", project: input.project, ownerId: record.owner.developerId, status: "starting", createdAt: input.now, updatedAt: input.now }),
    putNew(openAgentSessionKey(orgId, sessionId), "OPEN_AGENT_SESSION", { orgId, sessionId }),
  ];
}
