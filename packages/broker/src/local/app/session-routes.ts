// Lane L9-wire: the session routes the MCP tools and the CLI's `session` commands call (`/v1/app/sessions...`), over L6b's session store, summary and control. A session here is a
// task's session; the read is L6b's `sessionSnapshot` and the task flow's view of the same task. Comments between people are not here (one owner): a comment is refused, a message
// to the agent goes through the control host (L9-wire's `host.ts`), which keeps it as a note and gives it to a running step.
import type { ObjectStorage } from "@agentx/contracts";
import {
  AgentXError, IntentAnswerRefusal, TaskCloseActionSchema, SESSION_ACTIONS, SessionIdSchema, WorkflowTransitionError, agentSessionKey, agentXError,
  type AgentSessionRecord, type OrgId, type SessionId,
} from "@agentx/contracts";
import { AGENT_SESSION_CONTRACT_VERSION } from "@agentx/contracts";
import { closeHasDigest } from "../../core/task-flow/close-acceptance.js";
import { parseBody } from "../../core/task-flow/owner-round.js";
import type { ControlResult } from "../../core/sessions/control.js";
import { createSessionAccess, requireLevelOf, type SessionAccess, type SessionMembers } from "../../core/sessions/access.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { listSessions, sessionSnapshot } from "../../core/sessions/read.js";
import { sessionBindingsOf } from "../../core/sessions/bindings.js";
import { SessionStore } from "../../core/sessions/store.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import { readTask, taskViewOf } from "../../core/task-flow/reads.js";
import { taskLogViewFor } from "../../core/task-log/read.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { createAsk } from "../../core/sessions/ask.js";
import { followSession, recordPresence, unfollowSession, viewingNow } from "../../core/sessions/followers.js";
import { revisePlanWithLiveMessage } from "../../core/sessions/live-steer-revise.js";
import { createLocalSessionControl } from "./host.js";
import { answerUnderstandQuestions } from "./answers.js";
import { developerTaskView } from "./task-view.js";
import { taskOwnerView } from "../../developer/task-owner-view.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import type { SecondReview } from "../../core/second-review/index.js";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const SESSIONS = /^\/v1\/app\/sessions(?:\/([A-Za-z0-9_-]{1,100})(?:\/(stop|retry|messages|answers|revise-plan|follow|unfollow|presence|close|log))?)?$/u;
/** `POST /v1/app/sessions/<id>/ask` asks about a task; `GET /v1/app/sessions/<id>/asks/<askId>` reads it back, for the person who asked. */
const ASK_PATH = /^\/v1\/app\/sessions\/([A-Za-z0-9_-]{1,100})\/(?:ask|asks\/(ask_[0-9a-z]{20}))$/u;

const STATUS_OF_REFUSAL: Record<string, number> = { not_found: 404, forbidden: 403, task_access_denied: 403, ended: 409, unavailable: 409, nothing_to_retry: 409, invalid: 400, request_id_reused: 409 };

export interface SessionRoutesDeps {
  flow: TaskFlow;
  blobs: ObjectStorage;
  companyId: OrgId;
  /** The URL clients reach this install at: the session's `link` is its own address. */
  origin: () => string;
  /** Recomputes a session's summary now (after a close, so the answer shows the session ended). */
  refresh?: ((orgId: OrgId, sessionId: SessionId) => Promise<unknown>) | undefined;
  /** Ask about this task; absent when the install cannot answer one. */
  ask?: ReturnType<typeof createAsk> | undefined;
  /** The second review's lines on the task body. */
  secondReview?: SecondReview;
  /** Where the company's people come from for the session levels. Default: the local owner alone (who holds `edit` on every session). */
  members?: SessionMembers | undefined;
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
  const control = createLocalSessionControl(flow.deps, { members: deps.members });
  const access = createSessionAccess({ store, members: deps.members });
  const followerDeps = { store, members: deps.members, ...(flow.deps.now === undefined ? {} : { now: flow.deps.now }) };
  /** A row of the list, with the person's own level on that session. */
  const maySeeMoney = (task: TaskRecord, you: SessionAccess, caller: TaskCaller): boolean => caller.scriptToken === undefined && caller.principal.companyId === deps.companyId && task.companyId === deps.companyId
    && (you.orgAdmin || you.companyRole === "member" && taskOwnerView(task)?.developerId === caller.principal.personId);
  const summaryFor = (session: AgentSessionRecord, revealMoney: boolean) => {
    if (revealMoney) return session.summary;
    const { costUsd: _spent, runLimitUsd: _limit, stopAtUsd: _stop, ...summary } = session.summary;
    void _spent; void _limit; void _stop;
    return summary;
  };
  const tile = (session: AgentSessionRecord, level: string, revealMoney: boolean): Record<string, unknown> => JSON.parse(JSON.stringify({
    contractVersion: AGENT_SESSION_CONTRACT_VERSION, sessionId: session.sessionId, kind: session.kind, title: session.title, project: session.project, agent: session.agent, owner: session.owner,
    where: session.where, level, revision: session.revision, summary: summaryFor(session, revealMoney), createdAt: session.createdAt, updatedAt: session.updatedAt, endedAt: session.endedAt,
  })) as Record<string, unknown>;

  /** What the person may do, for the session's header (the hosted product's `sessionActionsFor`): `view` watches, `use` also steers, `edit` also stops and retries; a company admin may stop; close is the owner's. */
  const actionsFor = (you: SessionAccess, offered: readonly string[]): string[] => SESSION_ACTIONS.filter((action) => {
    if (!offered.includes(action) && action !== "close") return false;
    if (action === "watch") return true;
    if (!you.owner && you.projectRole === "viewer") return false;
    if (action === "steer") return you.level === "use" || you.level === "edit";
    if (action === "stop") return you.level === "edit" || you.orgAdmin;
    if (action === "retry") return you.level === "edit";
    if (action === "close") return you.level === "edit" && you.owner;
    return false;
  });

  const view = async (session: AgentSessionRecord, you: SessionAccess, caller: TaskCaller): Promise<Record<string, unknown>> => {
    if (session.subject.kind !== "task") throw agentXError("NOT_FOUND", "There is no such session.");
    const task = await readTask(flow.deps, session.subject.taskId);
    if (task === undefined || task.companyId !== deps.companyId) throw agentXError("NOT_FOUND", "There is no such session.");
    const snapshot = sessionSnapshot(session);
    const revealMoney = maySeeMoney(task, you, caller);
    return JSON.parse(JSON.stringify({
      contractVersion: AGENT_SESSION_CONTRACT_VERSION, sessionId: session.sessionId, kind: session.kind, mode: session.mode, title: session.title, project: session.project, agent: session.agent,
      owner: session.owner, startedBy: session.startedBy, where: session.where, status: session.summary.status, step: session.summary.step, peek: session.summary.peek, lastRunFailed: session.summary.lastRunFailed,
      cost: { ...(revealMoney ? { spentUsd: session.summary.costUsd, ...(session.summary.runLimitUsd === undefined ? {} : { runLimitUsd: session.summary.runLimitUsd }) } : {}), payer: { kind: "member", name: session.owner.name } },
      approvals: [], followers: session.followerCount, viewingNow: await viewingNow(store, session, (flow.deps.now?.() ?? new Date()).getTime()),
      you: {
        level: you.level, owner: you.owner, following: you.owner || (await store.get(agentSessionKey(session.orgId, session.sessionId, `FOLLOWER#${developerIdOf(caller.principal)}`))) !== undefined,
        actions: actionsFor(you, snapshot.actions), ...(you.mayAsk && deps.ask !== undefined ? { live: { ask: true } } : {}),
      },
      link: `${deps.origin()}/v1/app/sessions/${session.sessionId}`, bindings: await sessionBindingsOf(store, session.orgId, session.sessionId), legs: session.legs, revision: session.revision, createdAt: session.createdAt, updatedAt: session.updatedAt, endedAt: session.endedAt,
      body: { kind: "task", task: await developerTaskView(task, await taskViewOf(flow.deps, task), deps.blobs, deps.secondReview?.taskView(task, task.workflow?.candidate?.digest), undefined, revealMoney) },
    })) as Record<string, unknown>;
  };

  const refused = (result: Extract<ControlResult, { status: "refused" }>): BrokerResponse =>
    json(STATUS_OF_REFUSAL[result.reason] ?? 400, { error: { code: result.reason === "not_found" ? "NOT_FOUND" : result.reason === "forbidden" ? "SESSION_LEVEL_REQUIRED" : result.reason === "task_access_denied" ? "TASK_ACCESS_DENIED" : "CONFIG_INVALID", message: result.message } });

  return async (request, caller) => {
    const path = request.path.split("?")[0] ?? request.path;
    const asked = ASK_PATH.exec(path);
    if (asked !== null) {
      try {
        if (deps.ask === undefined || !SessionIdSchema.safeParse(asked[1]).success) throw agentXError("NOT_FOUND", "route not found");
        if (asked[2] === undefined) {
          if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
          return json(200, await deps.ask.submit(caller.principal, deps.companyId, asked[1]!, bodyOf(request)));
        }
        if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
        return json(200, await deps.ask.status(caller.principal, deps.companyId, asked[1]!, asked[2]));
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        throw error;
      }
    }
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
        // Each row carries the person's real level on it; a row they hold no level on (a share taken back, a denial) is left out.
        const rows: Array<Record<string, unknown>> = [];
        for (const row of listed.sessions) {
          const level = await access.levelOf({ companyId: caller.principal.companyId, developerId: developerIdOf(caller.principal), principal: caller.principal }, row, {});
          if (level !== "none") {
            const you = await access.of(caller.principal, row);
            const task = row.subject.kind === "task" ? await readTask(flow.deps, row.subject.taskId) : undefined;
            rows.push(tile(row, level, task !== undefined && maySeeMoney(task, you, caller)));
          }
        }
        return json(200, { sessions: rows, ...(listed.cursor === undefined ? {} : { next: listed.cursor }) });
      }
      if (sessionId === undefined || !SessionIdSchema.safeParse(sessionId).success) throw agentXError("NOT_FOUND", "There is no such session.");
      const session = await sessions.get(orgId, sessionId);
      if (session === undefined) throw agentXError("NOT_FOUND", "There is no such session.");
      // The session levels: no level reads as a missing session; reading needs `view`, which every level holds. Each action checks its own level below (or in the session control).
      const you = requireLevelOf(await access.of(caller.principal, session), "view", "view it");
      /** The session as `GET` shows it, for this person, after an action (their access read again). */
      const see = async (after: AgentSessionRecord): Promise<Record<string, unknown>> => view(after, await access.of(caller.principal, after), caller);
      if (action === undefined && request.method === "GET") return json(200, { session: await view(session, you, caller) });
      // The task's log (B5): whoever holds a level on the session reads it (the check above), as this company's rows of this session's own task. The task id is the session's, never the request's; a session that is not a
      // task's, or whose task is another company's, reads as the missing session.
      if (action === "log") {
        if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
        const task = session.subject.kind === "task" ? await readTask(flow.deps, session.subject.taskId) : undefined;
        if (task === undefined || task.companyId !== orgId) throw agentXError("NOT_FOUND", "There is no such session.");
        return json(200, await taskLogViewFor(store, orgId, task.taskId));
      }
      // Following: the owner follows without an item, so a laptop answers `following: true` and writes nothing; a members adapter's people have items.
      // `DELETE .../follow` is the hosted product's unfollow; this install's HTTP server takes GET and POST only (a hardening choice), so the unfollow is also `POST .../unfollow`.
      if ((action === "follow" && (request.method === "POST" || request.method === "DELETE")) || (action === "unfollow" && request.method === "POST")) {
        return json(200, request.method === "POST" && action === "follow" ? await followSession(followerDeps, caller.principal, orgId, sessionId) : await unfollowSession(followerDeps, caller.principal, orgId, sessionId));
      }
      if (action === "presence" && request.method === "POST") return json(200, await recordPresence(followerDeps, caller.principal, orgId, sessionId));
      if (action === "close" && request.method === "GET") return await previewClose(session, you, caller, request.path);
      if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
      const body = bodyOf(request);
      const requestId = typeof body["requestId"] === "string" ? body["requestId"] : "";
      if (action === "stop") {
        const result = await control.stop(caller.principal, orgId, sessionId, { requestId });
        if (result.status === "refused") return refused(result);
        return json(200, { session: await see((await sessions.get(orgId, sessionId)) ?? result.session), ...(result.nothingRunning === true ? { stop: "NOTHING_RUNNING", ...(result.message === undefined ? {} : { message: result.message }) } : {}) });
      }
      if (action === "retry") {
        const result = await control.retry(caller.principal, orgId, sessionId, { requestId });
        return result.status === "refused" ? refused(result) : json(200, { session: await see((await sessions.get(orgId, sessionId)) ?? result.session) });
      }
      if (action === "messages") {
        if (body["kind"] !== "steer") throw agentXError("CONFIG_INVALID", "A session has one owner on this install, so a comment has nobody to read it. Tell the agent instead.");
        const result = await control.tell(caller.principal, orgId, sessionId, { requestId, text: typeof body["text"] === "string" ? body["text"] : "" });
        return result.status === "refused" ? refused(result) : json(200, result.message);
      }
      if (action === "answers") {
        // D5: only the task's owners answer the agent (owner level `edit`); a People commenter (`use`) comments and asks, never answers.
        requireLevelOf(you, "edit", "answer its questions");
        await answerQuestions(session, caller, body);
        return json(200, { session: await see((await sessions.get(orgId, sessionId)) ?? session) });
      }
      if (action === "close") return await answerClose(session, caller, body);
      if (action === "revise-plan") {
        // The owner sends coding that stopped for their live message back to planning with that change; the revised plan still waits for their approval on the page (nothing is approved here).
        if (session.subject.kind !== "task") throw agentXError("NOT_FOUND", "There is no such session.");
        // Only the task's effective owner may press (their own live message asked for the change).
        requireLevelOf(you, "edit", "revise its plan");
        if (!you.owner) throw agentXError("SESSION_LEVEL_REQUIRED", `Only ${you.effectiveOwner.name} can revise this plan with their message.`);
        await revisePlanWithLiveMessage(flow.deps, orgId, sessionId, { taskId: session.subject.taskId, ownerDeveloperId: you.effectiveOwner.developerId }, body);
        return json(200, { session: await see((await sessions.get(orgId, sessionId)) ?? session) });
      }
      throw agentXError("NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      if (error instanceof IntentAnswerRefusal) return json(409, { error: { code: error.code, message: error.message } });
      if (error instanceof WorkflowTransitionError) return json(400, { error: { code: "CONFIG_INVALID", message: error.message } });
      throw error;
    }
  };

  async function previewClose(session: AgentSessionRecord, you: SessionAccess, caller: TaskCaller, path: string): Promise<BrokerResponse> {
    requireLevelOf(you, "edit", "close it");
    if (session.subject.kind !== "task") throw agentXError("NOT_FOUND", "There is no such session.");
    const action = parseBody(TaskCloseActionSchema, new URL(path, "http://local").searchParams.get("action"));
    return json(200, await flow.previewClose(caller, session.subject.taskId, action));
  }

  async function answerClose(session: AgentSessionRecord, caller: TaskCaller, body: Record<string, unknown>): Promise<BrokerResponse> {
    const input = closeInput(body);
    const result = await control.close(caller.principal, deps.companyId, session.sessionId, input);
    if (result.status === "refused") return refused(result);
    const guarded = closeHasDigest(input);
    if (!guarded) await deps.refresh?.(deps.companyId, session.sessionId).catch(() => undefined);
    const after = (await sessions.get(deps.companyId, session.sessionId)) ?? result.session;
    const task = guarded && session.subject.kind === "task" ? await readTask(flow.deps, session.subject.taskId) : undefined;
    return json(200, { session: await view(after, await access.of(caller.principal, after), caller), closed: guarded ? task?.closedAt !== undefined : true });
  }

  /** Answers to Understand's questions (needs `edit`, D5): the workflow takes them, and Understand runs again with them in the same commit. */
  async function answerQuestions(session: AgentSessionRecord, caller: TaskCaller, body: Record<string, unknown>): Promise<void> {
    const taskId = session.subject.kind === "task" ? session.subject.taskId : undefined;
    if (taskId === undefined) throw agentXError("NOT_FOUND", "There is no such session.");
    await answerUnderstandQuestions(flow.deps, {
      taskId, round: typeof body["round"] === "number" ? body["round"] : -1, answers: body["answers"], by: { name: caller.principal.displayName }, source: caller.client === "mcp" || caller.client === "cli" ? caller.client : "app",
    });
  }
}

/** The bridge's existing camel-case flag is the same intent, never a replacement digest. */
function closeInput(body: Record<string, unknown>): { requestId: string; expectedPreviewDigest?: unknown; discard_unpublished?: boolean } {
  // DEC 304: the old session request still takes only requestId. Boolean forwarding accompanies displayed consent.
  if (!closeHasDigest(body) && Object.keys(body).some((name) => name !== "requestId")) throw agentXError("CONFIG_INVALID", "a close needs a request ID and takes nothing else (this install cannot check for unpublished work or discard it yet, and closing may remove the workspace folder)");
  if (typeof body["requestId"] !== "string" || Object.keys(body).some((name) => !["requestId", "expectedPreviewDigest", "discard_unpublished", "discardUnpublished"].includes(name))) throw agentXError("CONFIG_INVALID", "a close needs a request ID and valid close fields");
  const snake = body["discard_unpublished"], camel = body["discardUnpublished"];
  if ((snake !== undefined && typeof snake !== "boolean") || (camel !== undefined && typeof camel !== "boolean") || (snake !== undefined && camel !== undefined && snake !== camel)) throw agentXError("CONFIG_INVALID", "discard unpublished must be one boolean");
  return { requestId: body["requestId"], ...(Object.hasOwn(body, "expectedPreviewDigest") ? { expectedPreviewDigest: body["expectedPreviewDigest"] } : {}), ...(snake === undefined && camel === undefined ? {} : { discard_unpublished: (snake ?? camel) as boolean }) };
}
