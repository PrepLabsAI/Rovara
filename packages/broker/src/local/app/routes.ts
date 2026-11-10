// Lane L9-wire: the owner's HTTP routes on `rovara up`: the ones the CLI, the MCP tools and the editor call with the session token. Authentication happens before this (the identity
// adapter vouches for the principal); nothing here reads who is acting from a body.
//
// Plan decisions are NOT here: an approval is authority, and the only proof the local owner can give is the one a local page signs for exactly one request, revision and digest
// (decisions/local-session.ts). The session token that logs a tool in is not an approval proof, so a tool that asks to approve is told to open the page.
import type { ObjectStorage } from "@agentx/contracts";
import { AgentXError, agentXError, type Principal } from "@agentx/contracts";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import { loadOwnedTask, taskViewOf } from "../../core/task-flow/reads.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { currentDocumentType, waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { DOCUMENT_CHANGED, readVerifiedText } from "./documents.js";
import { createLocalSessionControl, createSessionControlHost } from "./host.js";
import { listProjects, registerProject } from "./projects.js";
import { developerTaskListItem, developerTaskView } from "./task-view.js";

export const OPENS_PER_MINUTE = 5;
const OPEN_WINDOW_MS = 60_000;
export const APPROVE_ON_THE_PAGE = "A plan is approved on its local review page, by you. Run `rovara open <task>` to open it; an assistant cannot approve for you.";

export interface OwnerRoutesDeps {
  flow: TaskFlow;
  blobs: ObjectStorage;
  /** Opens a review page in the owner's browser, from this process. Resolves when the browser was asked; the address is not returned. */
  openPage: (path: string) => Promise<void>;
  version: string;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

export const ATTACH_ON_THE_PAGE = "Saying where a task's plan is posted is done on the task's page, in your browser (run `rovara open <task>`): it lets a comment there decide the plan, so a tool with the API token cannot do it.";
const TASK = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})(?:\/(plan|close|cancel|thread|workflow\/decision|workflow\/retry|continue))?$/u;

/** `GET /v1/auth/.well-known/agentx-configuration`: what a client asks before it signs in. Open, like `/healthz`. */
export function configurationAnswer(version: string): BrokerResponse {
  return json(200, { env: "local", apiVersion: version });
}

export function createOwnerRoutes(deps: OwnerRoutesDeps): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { flow } = deps;
  const companyId = flow.deps.companyId;
  const viewOf = async (caller: TaskCaller, taskId: string): Promise<Record<string, unknown>> => {
    const task = await loadOwnedTask(flow.deps, caller, taskId);
    return developerTaskView(task, await taskViewOf(flow.deps, task), deps.blobs);
  };
  const opens: number[] = [];
  let opening = false;
  const host = createSessionControlHost(flow.deps);
  const sessionControl = createLocalSessionControl(flow.deps);
  /** A stop or a retry goes through the session control, so it is audited, written on the session's timeline and answered again (not run twice) for the same request id. */
  const controlled = async (caller: TaskCaller, taskId: string, action: "stop" | "retry", body: unknown): Promise<void> => {
    const task = await loadOwnedTask(flow.deps, caller, taskId);
    const requestId = (body as { requestId?: unknown } | null)?.requestId;
    if (task.sessionId === undefined) {
      // A task from before sessions has no session to record on: the direct call, as before.
      await (action === "stop" ? host.cancelTask(taskId, "") : host.retryWorkflow(taskId, ""));
      return;
    }
    if (typeof requestId !== "string") throw agentXError("CONFIG_INVALID", "requestId: name this request with a UUID, so a repeat does not run twice");
    const result = await (action === "stop" ? sessionControl.stop(caller.principal, companyId, task.sessionId, { requestId }) : sessionControl.retry(caller.principal, companyId, task.sessionId, { requestId }));
    if (result.status === "refused") throw agentXError(result.reason === "not_found" ? "NOT_FOUND" : result.reason === "forbidden" ? "FORBIDDEN" : "CONFIG_INVALID", result.message);
  };
  return async (request, caller) => {
    const path = request.path.split("?")[0] ?? request.path;
    const isOurs = path === "/v1/dev/projects" || path === "/v1/admin/projects" || path === "/v1/dev/tasks" || TASK.test(path) || path === "/v1/local/pages/open";
    if (!isOurs) return undefined;
    try {
      if (path === "/v1/dev/projects" && request.method === "GET") {
        const principal: Principal = caller.principal;
        const projects = (await listProjects(flow.deps.store, companyId)).map((project) => ({ ...project, access: "granted" as const, channels: [], role: "maintainer" as const }));
        // 51 gap: the contract's sign-in list is closed (slack, oidc, cloud, github, saml) and has no word for the local owner; "oidc" is the nearest and nothing reads it for a decision.
        return json(200, { developer: { id: developerIdFor(principal), name: principal.displayName, provider: "oidc" }, projects, notices: [] });
      }
      if (path === "/v1/admin/projects" && request.method === "POST") {
        if (!caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", "only the owner of this install can register a project");
        const registered = await registerProject(flow.deps.store, companyId, bodyOf(request));
        return json(registered.duplicate ? 200 : 201, registered);
      }
      if (path === "/v1/local/pages/open" && request.method === "POST") {
        // The server opens the page in the owner's browser; the address (which carries the page session and can approve) never leaves this process.
        const body = bodyOf(request) as { path?: unknown };
        const target = typeof body.path === "string" && /^\/[A-Za-z0-9/_-]{0,200}$/u.test(body.path) ? body.path : "/";
        // A few a minute, one at a time: a holder of the API token cannot open a pile of browser tabs and processes.
        const now = (flow.deps.now?.() ?? new Date()).getTime();
        while (opens.length > 0 && opens[0]! <= now - OPEN_WINDOW_MS) opens.shift();
        if (opening || opens.length >= OPENS_PER_MINUTE) throw agentXError("TOO_MANY_REQUESTS", "Rovara is already opening pages for you. Wait a moment, then try again.");
        opens.push(now);
        opening = true;
        try {
          await deps.openPage(target);
        } catch {
          throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not open a browser. Open the review pages from the terminal where `rovara up` runs.");
        } finally {
          opening = false;
        }
        return json(200, { opened: true });
      }
      if (path === "/v1/dev/tasks" && request.method === "POST") {
        const started = await flow.start(caller, bodyOf(request));
        return json(started.duplicate ? 200 : 201, { task: await viewOf(caller, started.task.taskId) });
      }
      if (path === "/v1/dev/tasks" && request.method === "GET") {
        const limit = Number(new URL(request.path, "http://local").searchParams.get("limit"));
        const listed = await flow.list(caller, Number.isInteger(limit) && limit > 0 ? { limit } : {});
        return json(200, { tasks: listed.tasks.map((row) => developerTaskListItem(row as never)), ...(listed.cursor === undefined ? {} : { nextCursor: listed.cursor }) });
      }
      const match = TASK.exec(path);
      if (match !== null) {
        const taskId = match[1]!;
        const action = match[2];
        if (action === undefined && request.method === "GET") return json(200, { task: await viewOf(caller, taskId) });
        if (action === "plan" && request.method === "GET") {
          const task = await loadOwnedTask(flow.deps, caller, taskId);
          const workflow = task.workflow;
          const digest = workflow === undefined ? undefined : waitingDocumentDigest(workflow);
          const artifact = workflow?.artifacts.filter((candidate) => candidate.type === currentDocumentType(workflow)).at(-1);
          if (workflow === undefined || artifact === undefined || digest === undefined) throw agentXError("NOT_FOUND", "this task has no plan yet");
          const read = await readVerifiedText(deps.blobs, artifact, 200_000);
          if ("changed" in read) throw agentXError("CHANGE_STALE", DOCUMENT_CHANGED);
          const type = artifact.type === "requirements" || artifact.type === "design" || artifact.type === "plan" ? artifact.type : "plan";
          const versions = workflow.artifacts.filter((candidate) => candidate.type === artifact.type).map((candidate) => candidate.version);
          return json(200, { plan: {
            taskId, document: type, version: artifact.version, sha256: artifact.sha256, approved: workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === artifact.sha256),
            current: true, versions, content: { markdown: "text" in read ? read.text : "" }, summary: { lines: [], decisions: [] },
          } });
        }
        if (action === "close" && request.method === "POST") {
          const task = await flow.close(caller, taskId);
          return json(200, { task: await viewOf(caller, task.taskId), closed: true });
        }
        if (action === "cancel" && request.method === "POST") {
          await controlled(caller, taskId, "stop", bodyOf(request));
          return json(200, { task: await viewOf(caller, taskId) });
        }
        if (action === "thread" && request.method === "POST") {
          // Attaching a thread lets a writer's comment there decide this task's plan. That is the owner's own act, on the task's page in their browser: a tool that holds the API token must never be able to open it (L12 review H2).
          await loadOwnedTask(flow.deps, caller, taskId);
          throw agentXError("FORBIDDEN", ATTACH_ON_THE_PAGE);
        }
        if (action === "workflow/retry" && request.method === "POST") {
          await controlled(caller, taskId, "retry", bodyOf(request));
          return json(200, { task: await viewOf(caller, taskId) });
        }
        if (action === "workflow/decision" && request.method === "POST") {
          await loadOwnedTask(flow.deps, caller, taskId);
          throw agentXError("FORBIDDEN", APPROVE_ON_THE_PAGE);
        }
      }
      throw agentXError("NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      throw error;
    }
  };
}

// 64 hex, as the client's summary asks; the same hash the sessions name this person by.
const developerIdFor = (principal: Principal): string => developerIdOf(principal);
