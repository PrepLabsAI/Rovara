// The session receipt joins the host's accepted-close transaction. Route authorization/transport stays in control.ts (P3).
import { INDEX_EXPIRY_ATTRIBUTE, agentSessionKey, agentXError, cleanSessionName, sessionEventId, when, type Principal, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { toDocument, type TaskRecord } from "../task-flow/records.js";
import { closeFacts } from "../task-flow/close-conditions.js";
import { developerIdOf } from "./create.js";
import { SessionStore, sessionEventItem } from "./store.js";

export async function sessionCloseAcceptanceItems(deps: TaskFlowDeps, task: TaskRecord, principal: Principal, receipt: { requestId: string; operationId: string; intentHash: string; at: string }): Promise<TransactItem[]> {
  if (task.sessionId === undefined) return [];
  const session = await new SessionStore(deps.store).get(deps.companyId, task.sessionId);
  if (session === undefined || session.subject.kind !== "task" || session.subject.taskId !== task.taskId || session.endedAt !== undefined) throw agentXError("CHANGE_STALE", "the close preview has changed");
  const name = cleanSessionName(principal.displayName) ?? "Someone";
  return [
    { kind: "check", key: agentSessionKey(session.orgId, session.sessionId, "META"), condition: closeFacts(toDocument({ ...session, ...agentSessionKey(session.orgId, session.sessionId, "META") }), ["orgId", "subject", "owner", "project", "endedAt"]) },
    { kind: "put", item: { ...agentSessionKey(session.orgId, session.sessionId, `REQUEST#${receipt.requestId}`), entityType: "AGENT_SESSION_REQUEST", orgId: session.orgId, sessionId: session.sessionId, action: "close", by: developerIdOf(principal), ...receipt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(receipt.at) / 1000) + 400 * 86_400 }, condition: when.absent() },
    sessionEventItem(session, { eventId: sessionEventId("status", `close-accepted-${receipt.requestId}`), at: receipt.at, type: "status", actor: { kind: "member", developerId: developerIdOf(principal), name }, text: `${name} requested close.` }),
    ...deps.audit.stage({ eventId: `session:${session.sessionId}:close:${receipt.requestId}`, companyId: deps.companyId, at: receipt.at, actor: { type: "person", id: principal.personId }, action: "session.close_requested", subject: { type: "session", id: session.sessionId } }),
  ];
}
