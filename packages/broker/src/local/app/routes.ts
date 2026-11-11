// Lane L9-wire: the owner's HTTP routes on `rovara up`: the ones the CLI, the MCP tools and the editor call with the session token. Authentication happens before this (the identity
// adapter vouches for the principal); nothing here reads who is acting from a body.
//
// Plan decisions are NOT here: an approval is authority, and the only proof the local owner can give is the one a local page signs for exactly one request, revision and digest
// (decisions/local-session.ts). The session token that logs a tool in is not an approval proof, so a tool that asks to approve is told to open the page.
import type { ObjectStorage } from "@agentx/contracts";
import { AgentXError, DEVELOPER_API_VERSION, agentXError, type Principal } from "@agentx/contracts";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import { loadOwnedTask, taskViewOf } from "../../core/task-flow/reads.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { currentDocumentType, waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { DOCUMENT_CHANGED, readVerifiedText } from "./documents.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { readTaskPlanDocument } from "../../aws/task-plan-document.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { createLocalSessionControl, createSessionControlHost } from "./host.js";
import { listProjects, registerProject } from "./projects.js";
import { developerTaskListItem, developerTaskView } from "./task-view.js";
import type { SecondReview } from "../../core/second-review/index.js";
import type { ModelSelectionService } from "../../core/model-selection/service.js";
import { designReviewStateOf } from "../../core/design-review/state-view.js";
import { DIAGNOSIS_LAPTOP_REFUSALS } from "../../core/diagnosis/words.js";
import type { LocalDiagnosis } from "./diagnosis.js";

export const OPENS_PER_MINUTE = 5;
/** The most pages of the task index one list reads to fill a filtered answer. */
const LIST_PAGES_MAX = 5;
const OPEN_WINDOW_MS = 60_000;
export const APPROVE_ON_THE_PAGE = "A plan is approved on its local review page, by you. Run `rovara open <task>` to open it; an assistant cannot approve for you.";

export interface OwnerRoutesDeps {
  flow: TaskFlow;
  blobs: ObjectStorage;
  /** Opens a review page in the owner's browser, from this process. Resolves when the browser was asked; the address is not returned. */
  openPage: (path: string, options?: { fresh?: boolean }) => Promise<void>;
  version: string;
  /** The second review. Absent: its route is not there. */
  secondReview?: SecondReview;
  /** The model each step uses. Absent: its route is not there. */
  modelSelection?: ModelSelectionService;
  /** The design review: what a client reads of it (the owner's acts on it are the page's). Absent: the review's route answers that the task has none. */
  designReview?: { allowSkip(project: string): Promise<boolean>; unpricedNote(): string };
  /** Fix with agent. Absent: its routes are not there. */
  diagnosis?: Pick<LocalDiagnosis, "core">;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

export const SECOND_REVIEW_ON_THE_PAGE = "The second review's model, mode and evidence are changed on its local page, by you, in a page session opened within the last ten minutes. Run `rovara open second-review` to open it; an assistant cannot change them for you, and neither can this token.";
export const SECOND_REVIEW_PATH = "/v1/dev/second-review";
export const MODEL_SELECTION_ON_THE_PAGE = "The model each step uses is changed on its local page, by you, in a page session opened within the last ten minutes. Run `rovara open models` to open it; an assistant cannot change it for you, and neither can this token.";
export const MODEL_SELECTION_PATH = "/v1/dev/model-selection";
/** Cloud's staff routes for the evidence that lets a model block. Here they are refused with the page message: the evidence is written on the local page (see `SECOND_REVIEW_ON_THE_PAGE`). */
export const SECOND_REVIEW_EVIDENCE_PATH = /^\/v1\/admin\/second-review\/(replay|verdict)$/u;
export const ATTACH_ON_THE_PAGE = "Saying where a task's plan is posted is done on the task's page, in your browser (run `rovara open <task>`): it lets a comment there decide the plan, so a tool with the API token cannot do it.";
export const DESIGN_REVIEW_ON_THE_PAGE = "A cost choice, the answers to the design review's questions, and picking a paused review up again are your own acts on the task's page, in your browser (run `rovara open <task>`): a tool with the API token can read the review but cannot make them.";
const TASK = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})(?:\/(plan|close|cancel|thread|workflow\/decision|workflow\/retry|continue|design-review|design-review\/(?:choice|answers|resume)|diagnosis))?$/u;
/** Fix with agent: `GET /v1/app/diagnoses/<id>` reads one (the hosted product's route). Starting one is the owner's act on the task's page, so a tool that holds the API token is told to open it; the deeper look and "Apply this change" are not on this install. */
const DIAGNOSES = /^\/v1\/app\/diagnoses(?:\/(dgn_[0-9a-z]{20})(?:\/(deep|propose))?)?$/u;

/**
 * routes the MCP tools and the CLI call that have no core feature in Code yet (they wait on features not built yet: custom agents, approvals of connected systems, sharing and task people,
 * opening a pull request by hand, review of a candidate, PR feedback, parallel parts, a task's budget). Answered in plain words instead of the older handler's "route not found".
 */
const NOT_ON_THIS_INSTALL = /^\/v1\/app\/(?:agents|approvals)(?:\/|$)|^\/v1\/dev\/tasks\/[0-9a-f-]{36}\/(?:share|people|pull-requests|continue|workflow\/(?:review|send-back|review-findings|publish-retry|keep-pull-requests|feedback|feedback-decision|feedback-retry))(?:\/|$)/u;
export const NOT_ON_THIS_INSTALL_MESSAGE = "That is not on this install yet: Rovara on this computer does not do it. It comes with a later release.";

/** `GET /v1/auth/.well-known/agentx-configuration`: what a client asks before it signs in. Open, like `/healthz`. */
export function configurationAnswer(version: string): BrokerResponse {
  // `apiVersion` is the developer API this install speaks (what the CLI and the MCP tools check, `major.minor`); `version` is the Rovara release running.
  return json(200, { env: "local", apiVersion: DEVELOPER_API_VERSION, version });
}

export function createOwnerRoutes(deps: OwnerRoutesDeps): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { flow } = deps;
  const companyId = flow.deps.companyId;
  const viewOf = async (caller: TaskCaller, taskId: string): Promise<Record<string, unknown>> => {
    const task = await loadOwnedTask(flow.deps, caller, taskId);
    return developerTaskView(task, await taskViewOf(flow.deps, task), deps.blobs, deps.secondReview?.taskView(task, task.workflow?.candidate?.digest));
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
    const isOurs = NOT_ON_THIS_INSTALL.test(path) || path === SECOND_REVIEW_PATH || path === MODEL_SELECTION_PATH || SECOND_REVIEW_EVIDENCE_PATH.test(path) || DIAGNOSES.test(path) || path === "/v1/dev/projects" || path === "/v1/admin/projects" || path === "/v1/dev/tasks" || TASK.test(path) || path === "/v1/local/pages/open";
    if (!isOurs) return undefined;
    try {
      if (NOT_ON_THIS_INSTALL.test(path)) throw agentXError("NOT_AVAILABLE_HERE", NOT_ON_THIS_INSTALL_MESSAGE);
      if (SECOND_REVIEW_EVIDENCE_PATH.test(path)) {
        if (deps.secondReview?.enabled() !== true) throw agentXError("NOT_FOUND", "route not found");
        // The evidence that lets a model block is the owner's act on the local page, in a page session opened within ten minutes: this token is held by every local tool, so it never writes it.
        throw agentXError("FORBIDDEN", SECOND_REVIEW_ON_THE_PAGE);
      }
      if (path === MODEL_SELECTION_PATH) {
        if (deps.modelSelection === undefined) throw agentXError("NOT_FOUND", "route not found");
        // Reading is for any holder of the token; changing is the owner's act on the local page (the same rule as the second review's settings).
        if (request.method === "GET") return json(200, await deps.modelSelection.state());
        throw agentXError("FORBIDDEN", MODEL_SELECTION_ON_THE_PAGE);
      }
      if (path === SECOND_REVIEW_PATH) {
        if (deps.secondReview?.enabled() !== true) throw agentXError("NOT_FOUND", "route not found");
        // Reading is for any holder of the token; changing is the owner's act on the local page (the same rule as approving a plan).
        if (request.method === "GET") {
          const query = new URL(request.path, "http://local").searchParams;
          return json(200, await deps.secondReview.state({ ...(query.get("project") === null ? {} : { project: query.get("project") as string }), builder: query.getAll("builder") }));
        }
        throw agentXError("FORBIDDEN", SECOND_REVIEW_ON_THE_PAGE);
      }
      const diagnoses = DIAGNOSES.exec(path);
      if (diagnoses !== null) {
        if (deps.diagnosis?.core.enabled() !== true) throw agentXError("NOT_FOUND", "route not found");
        const [, id, tail] = diagnoses;
        if (id !== undefined && tail === undefined && request.method === "GET") return json(200, await deps.diagnosis.core.status(caller.principal, id));
        // The deeper look reads the repositories with a worker, and "Apply this change" needs a settings route to raise it into: neither is on this install.
        if (id !== undefined && tail !== undefined && request.method === "POST") throw agentXError("NOT_AVAILABLE_HERE", tail === "propose" ? DIAGNOSIS_LAPTOP_REFUSALS.noPath : DIAGNOSIS_LAPTOP_REFUSALS.notAvailableHere);
        // A diagnosis spends the owner's own model key: it is started by the owner on the task's page, never by a tool.
        if (id === undefined && request.method === "POST") throw agentXError("FORBIDDEN", DIAGNOSIS_LAPTOP_REFUSALS.startOnThePage);
        throw agentXError("NOT_FOUND", "route not found");
      }
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
        const body = bodyOf(request) as { path?: unknown; fresh?: unknown };
        const target = typeof body.path === "string" && /^\/[A-Za-z0-9/_-]{0,200}$/u.test(body.path) ? body.path : "/";
        // A page that makes a long-lived credential or changes who can act as the owner asks for a page session opened a few minutes ago: only the script tokens page, the chat, lessons, connections and models pages (the last changes which models a task uses) may ask the page server for a new one.
        const fresh = body.fresh === true && (target === "/tokens" || target === "/chat" || target === "/lessons" || target === "/connections" || target === "/models");
        // A few a minute, one at a time: a holder of the API token cannot open a pile of browser tabs and processes.
        const now = (flow.deps.now?.() ?? new Date()).getTime();
        while (opens.length > 0 && opens[0]! <= now - OPEN_WINDOW_MS) opens.shift();
        if (opening || opens.length >= OPENS_PER_MINUTE) throw agentXError("TOO_MANY_REQUESTS", "Rovara is already opening pages for you. Wait a moment, then try again.");
        opens.push(now);
        opening = true;
        try {
          await deps.openPage(target, fresh ? { fresh: true } : {});
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
        const query = new URL(request.path, "http://local").searchParams;
        const limit = Number(query.get("limit"));
        const project = query.get("project") ?? undefined;
        const status = query.get("status") ?? undefined;
        const cursor = query.get("cursor") ?? undefined;
        const wanted = Number.isInteger(limit) && limit > 0 ? limit : 50;
        // The list is filtered by what the caller asked for (`project`, `status`); a script token's list shows only its own projects, whatever it asked for. Pages are read until enough match (a few at most),
        // and the cursor is the last page read, so nothing is skipped.
        const shown: Array<Parameters<typeof developerTaskListItem>[0]> = [];
        let next = cursor;
        for (let pages = 0; pages < LIST_PAGES_MAX; pages += 1) {
          const listed = await flow.list(caller, { limit: Math.min(wanted, 200), ...(next === undefined ? {} : { cursor: next }) });
          for (const row of listed.tasks) {
            if (project !== undefined && row.project !== project) continue;
            if (status !== undefined && row.status !== status) continue;
            if (caller.scriptToken !== undefined && !caller.scriptToken.projects.includes(row.project)) continue;
            shown.push(row);
          }
          next = listed.cursor;
          if (next === undefined || shown.length >= wanted) break;
        }
        return json(200, { tasks: shown.map((row) => developerTaskListItem(row)), ...(next === undefined ? {} : { nextCursor: next }) });
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
          // A structured plan (Cloud's format) is answered whole: its canonical document and the plain wording of its checks and decisions (the same function Cloud's route uses).
          if (artifact.format === "structured") {
            const query = new URL(request.path, "http://local").searchParams;
            const version = query.get("version");
            const reader = textReaderOf(deps.blobs);
            // Bytes that do not match the digest the approval binds are not shown (the same refusal a Markdown plan gets).
            if (await loadWorkflowDocument(reader, artifact, {}).catch(() => undefined) === undefined) throw agentXError("CHANGE_STALE", DOCUMENT_CHANGED);
            return json(200, { plan: await readTaskPlanDocument(task, reader, { document: query.get("document") ?? artifact.type, ...(version === null ? {} : { version: Number(version) }) }) });
          }
          const read = await readVerifiedText(deps.blobs, artifact, 200_000);
          if ("changed" in read) throw agentXError("CHANGE_STALE", DOCUMENT_CHANGED);
          const type = artifact.type === "requirements" || artifact.type === "design" || artifact.type === "plan" ? artifact.type : "plan";
          const versions = workflow.artifacts.filter((candidate) => candidate.type === artifact.type).map((candidate) => candidate.version);
          return json(200, { plan: {
            taskId, document: type, version: artifact.version, sha256: artifact.sha256, approved: workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === artifact.sha256),
            current: true, versions, content: { markdown: "text" in read ? read.text : "" }, summary: { lines: [], decisions: [] },
          } });
        }
        if (action === "diagnosis" && request.method === "GET") {
          // The error the task shows now, whether Fix with agent is offered for it, and the diagnosis of it (read only: starting one is the owner's act on the task's page).
          const read = deps.diagnosis?.core.enabled() === true ? await deps.diagnosis.core.forTask(caller.principal, taskId) : undefined;
          if (read === undefined) throw agentXError("NOT_FOUND", "route not found");
          return json(200, read);
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
        if (action === "design-review" && request.method === "GET") {
          const task = await loadOwnedTask(flow.deps, caller, taskId);
          const state = task.workflow === undefined ? undefined : designReviewStateOf(taskId, task.workflow, { allowSkip: await (deps.designReview?.allowSkip(task.project) ?? Promise.resolve(false)), ...(deps.designReview === undefined ? {} : { unpricedNote: deps.designReview.unpricedNote() }) });
          if (state === undefined) throw agentXError("NOT_FOUND", "this task has no design review");
          return json(200, { designReview: state });
        }
        if (action !== undefined && action.startsWith("design-review/") && request.method === "POST") {
          // The owner's acts on a review are made on the task's page (a token that every local tool holds never decides): a tool reads, and is told where to act.
          await loadOwnedTask(flow.deps, caller, taskId);
          throw agentXError("FORBIDDEN", DESIGN_REVIEW_ON_THE_PAGE);
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
