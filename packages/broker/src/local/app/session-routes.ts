// Lane L9-wire: the session routes the MCP tools and the CLI's `session` commands call (`/v1/app/sessions...`), over L6b's session store, summary and control. A session here is a
// task's session; the read is L6b's `sessionSnapshot` and the task flow's view of the same task. Comments between people are not here (one owner): a comment is refused, a message
// to the agent goes through the control host (L9-wire's `host.ts`), which says plainly that a running step does not take it yet.
import type { ObjectStorage } from "@agentx/contracts";
import {
  AgentXError, IntentAnswerRefusal, SESSION_ACTIONS, SessionIdSchema, WorkflowTransitionError, agentXError,
  type AgentSessionRecord, type OrgId,
} from "@agentx/contracts";
import { AGENT_SESSION_CONTRACT_VERSION } from "@agentx/contracts";
import type { ControlResult } from "../../core/sessions/control.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { listSessions, sessionSnapshot } from "../../core/sessions/read.js";
import { SessionStore } from "../../core/sessions/store.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import { readTask, taskViewOf } from "../../core/task-flow/reads.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { createLocalSessionControl } from "./host.js";
import { answerUnderstandQuestions } from "./answers.js";
import { developerTaskView } from "./task-view.js";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const SESSIONS = /^\/v1\/app\/sessions(?:\/([A-Za-z0-9_-]{1,100})(?:\/(stop|retry|messages|answers))?)?$/u;

const STATUS_OF_REFUSAL: Record<string, number> = { not_found: 404, forbidden: 403, ended: 409, unavailable: 409, nothing_to_retry: 409, invalid: 400, request_id_reused: 409 };

export interface SessionRoutesDeps {
  flow: TaskFlow;
  blobs: ObjectStorage;
  companyId: OrgId;
  /** The URL clients reach this install at: the session's `link` is its own address. */
  origin: () => string;
}

function bodyOf(request: BrokerRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === "") return {};
  let value: unknown;
  try { value = JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the request body must be an object");
  return value as Record<string, unknown>;
}

export function createSessionRoutes(deps: SessionRoutesDeps): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { flow } = deps;
  const store = flow.deps.store;
  const sessions = new SessionStore(store);
  const control = createLocalSessionControl(flow.deps);
  const tile = (session: AgentSessionRecord): Record<string, unknown> => JSON.parse(JSON.stringify({
    contractVersion: AGENT_SESSION_CONTRACT_VERSION, sessionId: session.sessionId, kind: session.kind, title: session.title, project: session.project, agent: session.agent, owner: session.owner,
    where: session.where, level: "edit", revision: session.revision, summary: session.summary, createdAt: session.createdAt, updatedAt: session.updatedAt, endedAt: session.endedAt,
  })) as Record<string, unknown>;

  const view = async (session: AgentSessionRecord): Promise<Record<string, unknown>> => {
    if (session.subject.kind !== "task") throw agentXError("NOT_FOUND", "There is no such session.");
    const task = await readTask(flow.deps, session.subject.taskId);
    if (task === undefined) throw agentXError("NOT_FOUND", "There is no such session.");
    const snapshot = sessionSnapshot(session);
    return JSON.parse(JSON.stringify({
      contractVersion: AGENT_SESSION_CONTRACT_VERSION, sessionId: session.sessionId, kind: session.kind, mode: session.mode, title: session.title, project: session.project, agent: session.agent,
      owner: session.owner, startedBy: session.startedBy, where: session.where, status: session.summary.status, step: session.summary.step, peek: session.summary.peek, lastRunFailed: session.summary.lastRunFailed,
      cost: { spentUsd: session.summary.costUsd, ...(session.summary.runLimitUsd === undefined ? {} : { runLimitUsd: session.summary.runLimitUsd }), payer: { kind: "member", name: session.owner.name } },
      approvals: [], followers: 0, viewingNow: [],
      you: { level: "edit", owner: true, following: true, actions: SESSION_ACTIONS.filter((action) => snapshot.actions.includes(action as never) || action === "close") },
      link: `${deps.origin()}/v1/app/sessions/${session.sessionId}`, bindings: [], legs: session.legs, revision: session.revision, createdAt: session.createdAt, updatedAt: session.updatedAt, endedAt: session.endedAt,
      body: { kind: "task", task: await developerTaskView(task, await taskViewOf(flow.deps, task), deps.blobs) },
    })) as Record<string, unknown>;
  };

  const refused = (result: Extract<ControlResult, { status: "refused" }>): BrokerResponse =>
    json(STATUS_OF_REFUSAL[result.reason] ?? 400, { error: { code: result.reason === "not_found" ? "NOT_FOUND" : result.reason === "forbidden" ? "FORBIDDEN" : "CONFIG_INVALID", message: result.message } });

  return async (request, caller) => {
    const path = request.path.split("?")[0] ?? request.path;
    const match = SESSIONS.exec(path);
    if (match === null) return undefined;
    try {
      const sessionId = match[1];
      const action = match[2];
      const orgId = deps.companyId;
      if (sessionId === undefined && request.method === "GET") {
        const query = new URL(request.path, "http://local").searchParams;
        const limit = Number(query.get("limit"));
        const status = query.get("status");
        const listed = await listSessions(store, orgId, developerIdOf(caller.principal), {
          ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}), ...(query.get("cursor") === null ? {} : { cursor: query.get("cursor")! }),
          ...(status === "open" || status === "needs_me" || status === "failed" ? { filter: status } : {}),
        });
        return json(200, { sessions: listed.sessions.map(tile), ...(listed.cursor === undefined ? {} : { next: listed.cursor }) });
      }
      if (sessionId === undefined || !SessionIdSchema.safeParse(sessionId).success) throw agentXError("NOT_FOUND", "There is no such session.");
      const session = await sessions.get(orgId, sessionId);
      if (session === undefined || session.owner.developerId !== developerIdOf(caller.principal)) throw agentXError("NOT_FOUND", "There is no such session.");
      if (action === undefined && request.method === "GET") return json(200, { session: await view(session) });
      if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
      const body = bodyOf(request);
      const requestId = typeof body["requestId"] === "string" ? body["requestId"] : "";
      if (action === "stop") {
        const result = await control.stop(caller.principal, orgId, sessionId, { requestId });
        if (result.status === "refused") return refused(result);
        return json(200, { session: await view((await sessions.get(orgId, sessionId)) ?? result.session), ...(result.nothingRunning === true ? { stop: "NOTHING_RUNNING", ...(result.message === undefined ? {} : { message: result.message }) } : {}) });
      }
      if (action === "retry") {
        const result = await control.retry(caller.principal, orgId, sessionId, { requestId });
        return result.status === "refused" ? refused(result) : json(200, { session: await view((await sessions.get(orgId, sessionId)) ?? result.session) });
      }
      if (action === "messages") {
        if (body["kind"] !== "steer") throw agentXError("CONFIG_INVALID", "A session has one owner on this install, so a comment has nobody to read it. Tell the agent instead.");
        const result = await control.tell(caller.principal, orgId, sessionId, { requestId, text: typeof body["text"] === "string" ? body["text"] : "" });
        return result.status === "refused" ? refused(result) : json(200, result.message);
      }
      if (action === "answers") return json(200, { session: await answerQuestions(session, caller, body) });
      throw agentXError("NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      if (error instanceof IntentAnswerRefusal) return json(409, { error: { code: error.code, message: error.message } });
      if (error instanceof WorkflowTransitionError) return json(400, { error: { code: "CONFIG_INVALID", message: error.message } });
      throw error;
    }
  };

  /** The owner's answers to Understand's questions: the workflow takes them, and Understand runs again with them in the same commit. */
  async function answerQuestions(session: AgentSessionRecord, caller: TaskCaller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = session.subject.kind === "task" ? session.subject.taskId : undefined;
    if (taskId === undefined) throw agentXError("NOT_FOUND", "There is no such session.");
    await answerUnderstandQuestions(flow.deps, {
      taskId, round: typeof body["round"] === "number" ? body["round"] : -1, answers: body["answers"], by: { name: caller.principal.displayName }, source: caller.client === "mcp" || caller.client === "cli" ? caller.client : "app",
    });
    return view((await sessions.get(deps.companyId, session.sessionId)) ?? session);
  }
}
