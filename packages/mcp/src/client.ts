// Spec 025 FR-027: the tools' view of the control plane. The stdio server gives it the signed-in
// developer's session (packages/cli); the hosted endpoint will give it another.
import { CLI_PACKAGE_NAME } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import {
  AgentXConfigurationConfirmSchema,
  AgentXError,
  DeveloperCloseResponseSchema,
  DeveloperProjectsResponseSchema,
  DeveloperPullRequestResponseSchema,
  DeveloperTaskListResponseSchema,
  DeveloperTaskResponseSchema,
  TASK_VIEW_HEADER,
  TASK_VIEW_VERSION,
  SecondReviewStateReaderSchema,
  ModelSelectionStateReaderSchema,
  DesignReviewStateReaderSchema,
  TaskDiagnosisViewReaderSchema,
  SessionListReaderSchema,
  SessionMessageSchema,
  SessionResponseReaderSchema,
  TaskPeopleChangeResponseSchema,
  NeedsConfirmationSchema,
  TaskPeopleViewResponseSchema,
  type AgentXConfigurationConfirm,
  type ContinueDeveloperTaskRequest,
  type DeveloperCloseResponse,
  type DeveloperProjectsResponse,
  type DeveloperPullRequestRequest,
  type DeveloperPullRequestResponse,
  type DeveloperTaskListItem,
  type DeveloperTaskStatus,
  type DeveloperTaskClientView,
  type ShareDeveloperTaskRequest,
  type RunInput,
  type StartDeveloperTaskRequest,
  type TaskPeopleChangeResult,
  type TaskPeopleRoleRequest,
  type TaskPeopleTakeOwnershipRequest,
  type TaskPeopleView,
  type WorkflowDecisionRequest,
  type WorkflowFeedbackFindingsDecisionRequest,
  type WorkflowFeedbackReviewRetryRequest,
  type WorkflowPublishRetryRequest,
  type WorkflowResolveFindingsInput,
  forwardReader,
} from "@agentx/contracts";
import { z } from "zod";
import { CLOSE_BUSY_STEP, NEXT_STEPS, SHARE_BUSY_STEP, START_BUSY_STEP, ToolError, isMeaningfulCode, plainText, signInStep, toolErrorFromResponse } from "./errors.js";

/** What the session routes answer, read leniently: a newer server's extra fields and values are kept, not refused. */
const SessionMessageReaderSchema = forwardReader(SessionMessageSchema);
export type SessionListRead = z.output<typeof SessionListReaderSchema>;
export type SessionViewRead = z.output<typeof SessionResponseReaderSchema>["session"];
/** Session ownership confirmations do not advertise an expiry on the wire. */
export type TaskOwnershipResult = Exclude<TaskPeopleChangeResult, { status: "PENDING" }> | {
  status: "PENDING"; requestId: string; confirmationUrl: string; expiresAt?: string;
};
export type SessionMessageRead = z.output<typeof SessionMessageReaderSchema>;

/**
 * A local review page's address carries a session token in its path (`/s/<43 characters>/...`). Whoever holds it can approve what the page shows, and the
 * agent that reads a tool result runs on the same machine, so such an address is never passed on: a person asks for it in their own terminal.
 */
const PAGE_TOKEN_PATH = /^\/s\/[A-Za-z0-9_-]{43}(?:\/|$)/;

/** The hosts of a Code install on this machine: its local pages are plain http on one of these, so a link there is not refused for its scheme. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A link the server sent, only when it is an https address (or an http address on this machine's loopback, where Code serves its local pages) on the
 * control plane's own origin with no user name or password, printable ASCII, and at most 1,000 characters (so the tools' cleaning never cuts one in
 * two). Anything else becomes "": the tools leave that field out.
 */
function pinnedLink(value: unknown, baseUrl: string): string {
  if (typeof value !== "string" || value.length > 1_000 || !/^[\x21-\x7e]+$/.test(value)) return "";
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname));
    return schemeOk && !PAGE_TOKEN_PATH.test(url.pathname) && url.username === "" && url.password === "" && url.origin === base.origin ? value : "";
  } catch {
    return "";
  }
}

export interface ControlPlaneSession { baseUrl: string; accessToken: string; signInCommand: string }

/** For a read inside a wait: its own deadline, and the tool call's signal, so a cancel ends it at once. */
export interface CallOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  /** TASK_BUSY's next step for a busy answer to this call (final review M1); the default is to wait or cancel. */
  busyStep?: string;
}

/** One task's design review as a client reads it (read only: the owner's acts on it are made on the local page). */
export type DesignReviewStateReadView = z.infer<typeof DesignReviewStateReaderSchema>;

/** The tickets that wait for the owner, the places a project's work is asked for (the answer of `GET /v1/app/projects/<project>/intake`). */
export const IntakeListReaderSchema = z.object({
  items: z.array(z.object({ itemId: z.string(), system: z.string(), id: z.string(), title: z.string(), reason: z.string(), waitingSince: z.string(), requester: z.object({ display: z.string() }).passthrough() }).passthrough()),
  sources: z.array(z.object({ sourceId: z.string(), failing: z.boolean(), lastError: z.string().optional(), ref: z.object({ channel: z.string(), system: z.string().optional(), when: z.object({ label: z.string().optional(), assignedToRovara: z.boolean().optional() }).passthrough() }).passthrough() }).passthrough()),
}).passthrough();
export type IntakeListRead = z.infer<typeof IntakeListReaderSchema>;
export const IntakeStartReaderSchema = z.object({ started: z.boolean(), taskId: z.string().optional(), reason: z.string().optional(), state: z.string().optional() }).passthrough();
export type IntakeStartRead = z.infer<typeof IntakeStartReaderSchema>;

/** The second review's state as a client reads it: a mode this build does not know reads `unknown` (forward-compatible reader). */
export type SecondReviewStateRead = z.infer<typeof SecondReviewStateReaderSchema>;

/** A task's Fix with agent state as a client reads it (forward-compatible: a proposal kind this build does not know reads `unknown`). */
export type TaskDiagnosisRead = z.infer<typeof TaskDiagnosisViewReaderSchema>;
/** The saved connections as a client reads them: never a secret, its name or the vendor account (read only: the owner adds and changes them on the local page). */
export const ConnectionsReadSchema = z.object({
  connections: z.array(z.object({
    connectionId: z.string(), type: z.string(), label: z.string(), access: z.string(), hasCredential: z.boolean(), detail: z.string(),
    lastCheck: z.object({ ok: z.boolean(), at: z.string() }).optional(),
  }).passthrough()),
}).passthrough();
export type ConnectionsRead = z.infer<typeof ConnectionsReadSchema>;

/** A project's context sources and the changes waiting for the owner, as a client reads them. */
export const ContextSourcesReadSchema = z.object({
  project: z.string(), revision: z.number(),
  sources: z.array(z.object({ sourceId: z.string(), label: z.string(), stages: z.array(z.string()), tools: z.array(z.object({ name: z.string(), role: z.string() }).passthrough()), quotes: z.string(), retention: z.string() }).passthrough()),
  pending: z.array(z.object({ changeId: z.string(), kind: z.string(), sourceId: z.string(), reasons: z.array(z.string()) }).passthrough()),
}).passthrough();
export type ContextSourcesRead = z.infer<typeof ContextSourcesReadSchema>;

/** The model each step uses, as a client reads it (read only: the owner changes it on the local page). */
export type ModelSelectionStateRead = z.infer<typeof ModelSelectionStateReaderSchema>;

export interface ControlPlaneClient {
  /** The environment's agentx-configuration, read without a token. */
  configuration(): Promise<{ env: string; apiVersion: string; baseUrl: string; adminApiVersion?: string; confirm?: AgentXConfigurationConfirm }>;
  projects(): Promise<DeveloperProjectsResponse>;
  startTask(request: StartDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  getTask(taskId: string, events: number, options?: CallOptions): Promise<DeveloperTaskClientView>;
  /** PLANFULLDOC: one stored version of the task's plan, whole (the latest when `version` is left out). */
  getTaskPlan(taskId: string, query: { document?: "requirements" | "design" | "plan"; version?: number }): Promise<TaskPlanView>;
  listTasks(query: { project?: string; status?: DeveloperTaskStatus; limit: number }): Promise<DeveloperTaskListItem[]>;
  continueTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  decideWorkflowTask(taskId: string, request: WorkflowDecisionRequest): Promise<DeveloperTaskClientView>;
  startWorkflowReviewTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  retryWorkflowTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  /** Task 16: sends blocked work back to coding with the problems found; expectedRevision is required. */
  sendWorkflowBack(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  /** Accepts (with a reason) or sends to coding each blocking review finding; expectedRevision and candidateDigest are required. */
  resolveWorkflowFindings(taskId: string, request: WorkflowResolveFindingsInput): Promise<DeveloperTaskClientView>;
  /** Task 12/16: asks AgentX to open the workflow's draft pull request again. */
  retryWorkflowPublish(taskId: string, request: WorkflowPublishRetryRequest): Promise<DeveloperTaskClientView>;
  /** After an approved PR feedback fix changed nothing: keep the pull request as it is and wait for its merge again. */
  keepWorkflowPullRequests(taskId: string, request: WorkflowPublishRetryRequest): Promise<DeveloperTaskClientView>;
  /** The pending PR feedback proposal, as the feedback page shows it (GitHub and reviewer text: untrusted data). */
  getWorkflowFeedback(taskId: string): Promise<Record<string, unknown>>;
  /** The owner's decision on the pending PR feedback proposal, the same transition the Slack buttons make. */
  decideWorkflowFeedback(taskId: string, request: WorkflowFeedbackFindingsDecisionRequest): Promise<DeveloperTaskClientView>;
  /** The owner's Retry review of a PR feedback review that could not finish. */
  retryWorkflowFeedbackReview(taskId: string, request: WorkflowFeedbackReviewRetryRequest): Promise<{ task: DeveloperTaskClientView; started: boolean }>;
  cancelTask(taskId: string, requestId: string): Promise<DeveloperTaskClientView>;
  closeTask(taskId: string, requestId: string, discardUnpublished?: boolean): Promise<DeveloperCloseResponse>;
  openPullRequest(taskId: string, request: DeveloperPullRequestRequest): Promise<DeveloperPullRequestResponse>;
  /** Spec 025 FR-030: shares the task, or changes a shared task's mode (API 1.2). */
  shareTask(taskId: string, request: ShareDeveloperTaskRequest): Promise<DeveloperTaskClientView>;
  /** The second review's settings and state (read only: the owner changes them on the local page). Absent route: the install has no second review. */
  getSecondReview(query: { project?: string; builder?: readonly string[] }): Promise<SecondReviewStateRead>;
  /** The tickets that wait for the owner in a project, and where its work is asked for (read only). */
  getIntake(project: string): Promise<IntakeListRead>;
  /** Starts a task from a ticket that waits (the owner's act: the task is theirs, and its plan still waits for their approval). */
  startIntakeTicket(project: string, itemId: string, requestId: string): Promise<IntakeStartRead>;
  /** Drops a ticket that waits ("not this one"). */
  dismissIntakeTicket(project: string, itemId: string, requestId: string): Promise<{ dismissed: boolean }>;
  /** The saved connections (read only: the owner adds, changes and removes them on the local page). Absent route: the install has none. */
  listConnections(): Promise<ConnectionsRead>;
  /** A project's context sources and the changes waiting for the owner (read only). */
  getContextSources(project: string): Promise<ContextSourcesRead>;
  /** The model each step uses, what it would run on now and what it costs (read only: the owner changes it on the local page). Absent route: the install has no per-step model setting. */
  getModelSelection(): Promise<ModelSelectionStateRead>;
  /** One task's design review: how it stands, the findings, and what waits for the owner (read only). */
  getDesignReview(taskId: string): Promise<DesignReviewStateReadView>;
  /** A task's error, whether Fix with agent is offered for it, and the diagnosis of it (read only: the owner starts one on the task's page). Absent route: the install has no Fix with agent. */
  getTaskDiagnosis(taskId: string): Promise<TaskDiagnosisRead>;
  getTaskPeople(taskId: string): Promise<TaskPeopleView>;
  getTaskPeopleRequest(taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  setTaskPerson(taskId: string, request: TaskPeopleRoleRequest): Promise<TaskPeopleChangeResult>;
  takeTaskOwnership(taskId: string, request: TaskPeopleTakeOwnershipRequest): Promise<TaskOwnershipResult>;
  /** Plan 3 Task 35a: the agents the person can see, or those that work on a project. */
  listAgents(query: { project?: string }): Promise<AgentSummary[]>;
  /** Plan 3 Task 35a: starts a run of an agent on a project; the run is a task. */
  runAgent(agentId: string, request: { requestId: string; project: string; version?: number | "draft"; input: RunInput }): Promise<DeveloperTaskClientView>;
  /**
   * Plan 3 Task 35a: the approvals that wait for the person, one with its full arguments, and its confirmation page's link (ticketed when they
   * may decide it). There is no call that decides one: a person decides on the page (R3-4, R66).
   */
  listApprovals(): Promise<ApprovalSummary[]>;
  getApproval(approvalId: string): Promise<ApprovalSummary>;
  approvalConfirmLink(approvalId: string): Promise<{ confirmUrl: string; ticketed: boolean }>;
  /**
   * Plan 5 Task 23: sessions. Exactly one of owner, shared and project names the list. There is no call here that takes a session over, retries it or
   * shares it: a person does those on the CLI or in a browser.
   */
  listSessions(query: { owner?: "me"; shared?: "me"; project?: string; status?: "open" | "ended"; cursor?: string; limit?: number }): Promise<SessionListRead>;
  getSession(sessionId: string): Promise<SessionViewRead>;
  commentOnSession(sessionId: string, request: { requestId: string; text: string }): Promise<SessionMessageRead>;
  /** A message to the session's agent; the caller needs "can use". */
  tellSessionAgent(sessionId: string, request: { requestId: string; text: string }): Promise<SessionMessageRead>;
  /** `nothingRunning` is the server's words when the stop found nothing to stop (so the tool never says "Stop requested"). */
  stopSession(sessionId: string, requestId: string): Promise<SessionViewRead & { nothingRunning?: string }>;
  /** Rovara Code (Plan 6 Task 5): answers the questions a task waits on, in one call (every question needs an answer). The caller needs "can use" on the session. */
  answerTaskQuestions(sessionId: string, request: { requestId: string; round: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }): Promise<SessionViewRead>;
}

/** An agent as the agent routes list it; the tool reads only the fields it shows. */
const AgentSummarySchema = z.object({
  agentId: z.string(), name: z.string(), description: z.string().optional(), builtin: z.boolean(), status: z.string(), access: z.string(),
  currentVersion: z.number().optional(), pinnedVersion: z.number().optional(), disabled: z.boolean().optional(),
}).passthrough();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
/** An approval as the approval routes show it; `arguments` only when one approval is read. */
const ApprovalSummarySchema = z.object({
  approvalId: z.string(), kind: z.string(), status: z.string(), confirmUrl: z.string(), summary: z.string().optional(), prompt: z.string().optional(),
  changes: z.array(z.string()).optional(), project: z.string().optional(), connector: z.string().optional(), tool: z.string().optional(), scope: z.string().optional(), repository: z.string().optional(),
  expiresAt: z.string().optional(), arguments: z.unknown().optional(),
}).passthrough();
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

/** The answer to a run whose version waits for the agent's owner (`202 NEEDS_OWNER_APPROVAL`): where the owner confirms it. */
const OwnerApprovalWaitSchema = z.object({ status: z.literal("NEEDS_OWNER_APPROVAL"), confirmUrl: z.string(), changes: z.array(z.string()) });

/** Spec 025 A1: adminApiVersion is absent from a control plane from before 25d. */
/** Spec 025 E16 (C22): confirm is absent from a control plane from before 25e. */
const ConfigurationSchema = z.object({ env: z.string(), apiVersion: z.string(), adminApiVersion: z.string().optional(), confirm: AgentXConfigurationConfirmSchema.optional() });
/** The full-plan answer: the canonical document is untrusted model text, kept as data; the summary is AgentX's plain wording of its checks. */
const TaskPlanResponseSchema = z.object({
  plan: z.object({
    taskId: z.string(), document: z.enum(["requirements", "design", "plan"]), version: z.number().int().positive(), sha256: z.string(),
    approved: z.boolean(), current: z.boolean(), versions: z.array(z.number().int().positive()),
    content: z.record(z.string(), z.unknown()),
    summary: z.object({
      lines: z.array(z.string()),
      decisions: z.array(z.object({ id: z.string(), question: z.string(), answer: z.string() })),
      noneReason: z.string().optional(),
    }),
  }),
});
export type TaskPlanView = z.infer<typeof TaskPlanResponseSchema>["plan"];
/** The feedback page's view of a PR feedback proposal; the tool reads only the fields it shows. */
const FeedbackReviewResponseSchema = z.object({ review: z.record(z.string(), z.unknown()) });
const UNREADABLE = "AgentX answered with something this version of the CLI cannot read; upgrade it";
const DEFAULT_SIGN_IN = `npx ${CLI_PACKAGE_NAME} login <your AgentX URL>`;
const REQUEST_TIMEOUT_MS = 30_000;
/** No call, retries included, takes longer than this. */
const DEADLINE_MS = 45_000;

/** A 401 on an authorized call: the caller refreshes the sign-in once and tries once more. */
class Refused extends Error {
  constructor(readonly error: ToolError) {
    super(error.message);
    this.name = "Refused";
  }
}

/**
 * A call that is safe to send again: a read, or a write the control plane deduplicates by its
 * requestId (the same body, so the same requestId, is sent each time).
 */
function repeatable(method: string, body: unknown): boolean {
  if (method === "GET") return true;
  return typeof body === "object" && body !== null && typeof (body as { requestId?: unknown }).requestId === "string";
}

function errorCodeOf(value: unknown): string | undefined {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown } }).error : undefined;
  return typeof error?.code === "string" ? error.code : undefined;
}

export function httpControlPlaneClient(options: {
  /** The signed-in session; `force` asks for a refreshed access token (AgentX refused the last one). */
  session(options?: { force?: boolean }): Promise<ControlPlaneSession>;
  fetch: typeof fetch;
  traceId?(): string;
  sleep?(ms: number): Promise<void>;
  tries?: number;
  now?(): number;
  deadlineMs?: number;
}): ControlPlaneClient {
  const sleep = (ms: number): Promise<void> => (options.sleep ? options.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = (): number => (options.now ? options.now() : Date.now());
  const tries = Math.max(1, options.tries ?? 3);
  const defaultDeadlineMs = options.deadlineMs ?? DEADLINE_MS;

  async function session(force = false): Promise<ControlPlaneSession> {
    try {
      return await (force ? options.session({ force: true }) : options.session());
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof AgentXError && error.code === "AUTH_REQUIRED") {
        const message = plainText(error.message.replace(/^AUTH_REQUIRED: /, ""), "this computer is not signed in to AgentX");
        throw new ToolError("SIGN_IN_REQUIRED", message, signInStep(message, DEFAULT_SIGN_IN));
      }
      // Only AgentX's own words are shown; any other error's text could hold anything.
      const message = error instanceof AgentXError ? plainText(error.message.replace(/^[A-Z_]+: /, ""), "AgentX could not be reached") : "AgentX could not be reached";
      throw new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
    }
  }

  async function send<T>(current: ControlPlaneSession, schema: z.ZodType<T>, method: string, path: string, body: unknown, authorized: boolean, refused: readonly string[] = [], call: CallOptions = {}): Promise<T> {
    const maxTries = repeatable(method, body) ? tries : 1;
    const started = now();
    const deadlineMs = Math.min(call.deadlineMs ?? defaultDeadlineMs, defaultDeadlineMs);
    const cancelled = () => new ToolError("CONTROL_PLANE_UNAVAILABLE", "the call was cancelled before AgentX answered");
    const isCancelled = (): boolean => call.signal?.aborted === true;
    // The tokens sent, and any AgentX refused, never appear in what a tool returns.
    const secrets = authorized ? [current.accessToken, ...refused] : [];
    const unreachable = (attempt: number) =>
      new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${plainText(current.baseUrl, "its URL")}${attempt > 1 ? ` after ${attempt} tries` : ""}`);
    /** Waits before the next try, or answers false when there is no try left or no time for one. */
    const again = async (attempt: number): Promise<boolean> => {
      if (attempt >= maxTries || isCancelled()) return false;
      const delay = Math.round(250 + Math.random() * 500 * attempt);
      if (now() - started + delay >= deadlineMs) return false;
      await sleep(delay);
      return true;
    };
    for (let attempt = 1; ; attempt += 1) {
      if (isCancelled()) throw cancelled();
      const headers: Record<string, string> = { "x-agentx-trace-id": options.traceId?.() ?? randomUUID(), [TASK_VIEW_HEADER]: TASK_VIEW_VERSION };
      if (authorized) headers.authorization = `Bearer ${current.accessToken}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      // Each try gets what is left of the deadline, at most 30 seconds, to answer in full.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(0, Math.min(REQUEST_TIMEOUT_MS, deadlineMs - (now() - started))));
      const onCancel = () => abort.abort();
      call.signal?.addEventListener("abort", onCancel, { once: true });
      let response: Response;
      let text: string;
      try {
        response = await options.fetch(`${current.baseUrl}${path}`, {
          method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal,
        });
        text = await response.text().catch(() => "");
      } catch {
        if (isCancelled()) throw cancelled();
        if (await again(attempt)) continue;
        throw unreachable(attempt);
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", onCancel);
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = undefined;
      }
      // An outage is tried again; a 5xx that names what is wrong (SLACK_UNAVAILABLE) is the answer.
      if (response.status >= 500 && !isMeaningfulCode(errorCodeOf(value)) && await again(attempt)) continue;
      if (!response.ok) {
        const error = toolErrorFromResponse(response.status, value, current.signInCommand, secrets, call.busyStep);
        if (response.status === 401 && authorized) throw new Refused(error);
        throw error;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", UNREADABLE, NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }

  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, authorized = true, options: CallOptions = {}): Promise<T> {
    const first = await session();
    try {
      return await send(first, schema, method, path, body, authorized, [], options);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
    // AgentX refused the access token: refresh it once and try once more, never in a loop. A 401
    // means nothing was done, so sending the same request again is safe.
    const refreshed = await session(true);
    try {
      return await send(refreshed, schema, method, path, body, authorized, [first.accessToken], options);
    } catch (error) {
      if (error instanceof Refused) throw error.error;
      throw error;
    }
  }

  const task = (response: { task: DeveloperTaskClientView }) => response.task;
  /** A session view with its own link and its decision links kept only when they are the control plane's. */
  const pinned = async (view: SessionViewRead): Promise<SessionViewRead> => {
    const { baseUrl } = await session();
    return { ...view, link: pinnedLink(view.link, baseUrl), approvals: view.approvals.map((approval) => ({ ...approval, confirmUrl: pinnedLink(approval.confirmUrl, baseUrl) })) };
  };
  const sessionPath = (sessionId: string, rest = "") => `/v1/app/sessions/${encodeURIComponent(sessionId)}${rest}`;
  const path = (taskId: string, rest = "") => `/v1/dev/tasks/${encodeURIComponent(taskId)}${rest}`;
  return {
    configuration: async () => {
      const current = await session();
      const value = await send(current, ConfigurationSchema, "GET", "/v1/auth/.well-known/agentx-configuration", undefined, false);
      return {
        env: value.env, apiVersion: value.apiVersion, baseUrl: current.baseUrl,
        ...(value.adminApiVersion === undefined ? {} : { adminApiVersion: value.adminApiVersion }),
        ...(value.confirm === undefined ? {} : { confirm: value.confirm }),
      };
    },
    projects: () => call(DeveloperProjectsResponseSchema, "GET", "/v1/dev/projects"),
    startTask: async (request) => task(await call(DeveloperTaskResponseSchema, "POST", "/v1/dev/tasks", request, true, { busyStep: START_BUSY_STEP })),
    getTask: async (taskId, events, options) => task(await call(DeveloperTaskResponseSchema, "GET", path(taskId, `?events=${events}`), undefined, true, options)),
    getTaskPlan: async (taskId, query) => {
      const search = new URLSearchParams();
      if (query.document !== undefined) search.set("document", query.document);
      if (query.version !== undefined) search.set("version", String(query.version));
      return (await call(TaskPlanResponseSchema, "GET", path(taskId, `/plan${search.size === 0 ? "" : `?${search.toString()}`}`))).plan;
    },
    listTasks: async (query) => {
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.project !== undefined) search.set("project", query.project);
      if (query.status !== undefined) search.set("status", query.status);
      return (await call(DeveloperTaskListResponseSchema, "GET", `/v1/dev/tasks?${search.toString()}`)).tasks;
    },
    continueTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/continue"), request)),
    decideWorkflowTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/decision"), request)),
    startWorkflowReviewTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/review"), request)),
    retryWorkflowTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/retry"), request)),
    sendWorkflowBack: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/send-back"), request)),
    resolveWorkflowFindings: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/review-findings"), request)),
    retryWorkflowPublish: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/publish-retry"), request)),
    keepWorkflowPullRequests: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/keep-pull-requests"), request)),
    getWorkflowFeedback: async (taskId) => (await call(FeedbackReviewResponseSchema, "GET", path(taskId, "/workflow/feedback"))).review,
    decideWorkflowFeedback: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/feedback-decision"), request)),
    retryWorkflowFeedbackReview: async (taskId, request) => {
      const answer = await call(DeveloperTaskResponseSchema.extend({ started: z.boolean() }), "POST", path(taskId, "/workflow/feedback-retry"), request);
      return { task: answer.task, started: answer.started };
    },
    cancelTask: async (taskId, requestId) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/cancel"), { requestId })),
    closeTask: (taskId, requestId, discardUnpublished = false) => call(DeveloperCloseResponseSchema, "POST", path(taskId, "/close"), { requestId, ...(discardUnpublished ? { discard_unpublished: true } : {}) }, true, { busyStep: CLOSE_BUSY_STEP }),
    openPullRequest: (taskId, request) => call(DeveloperPullRequestResponseSchema, "POST", path(taskId, "/pull-requests"), request),
    shareTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/share"), request, true, { busyStep: SHARE_BUSY_STEP })),
    getDesignReview: async (taskId) => (await call(z.object({ designReview: DesignReviewStateReaderSchema }).passthrough(), "GET", path(taskId, "/design-review"))).designReview,
    getTaskDiagnosis: (taskId) => call(TaskDiagnosisViewReaderSchema, "GET", path(taskId, "/diagnosis")),
    getIntake: (project) => call(IntakeListReaderSchema, "GET", `/v1/app/projects/${encodeURIComponent(project)}/intake`),
    startIntakeTicket: (project, itemId, requestId) => call(IntakeStartReaderSchema, "POST", `/v1/app/projects/${encodeURIComponent(project)}/intake/${encodeURIComponent(itemId)}/start`, { requestId }),
    dismissIntakeTicket: (project, itemId, requestId) => call(z.object({ dismissed: z.boolean() }).passthrough(), "POST", `/v1/app/projects/${encodeURIComponent(project)}/intake/${encodeURIComponent(itemId)}/dismiss`, { requestId }),
    listConnections: () => call(ConnectionsReadSchema, "GET", "/v1/dev/connections"),
    getContextSources: (project) => call(ContextSourcesReadSchema, "GET", `/v1/dev/context-sources?project=${encodeURIComponent(project)}`),
    getSecondReview: async (query) => {
      const search = new URLSearchParams();
      if (query.project !== undefined) search.set("project", query.project);
      for (const builder of query.builder ?? []) search.append("builder", builder);
      return call(SecondReviewStateReaderSchema, "GET", `/v1/dev/second-review${search.size === 0 ? "" : `?${search.toString()}`}`);
    },
    getModelSelection: () => call(ModelSelectionStateReaderSchema, "GET", "/v1/dev/model-selection"),
    getTaskPeople: async (taskId) => (await call(TaskPeopleViewResponseSchema, "GET", path(taskId, "/people"))).view,
    getTaskPeopleRequest: async (taskId, requestId) => (await call(TaskPeopleChangeResponseSchema, "GET", path(taskId, `/people/requests/${encodeURIComponent(requestId)}`))).change,
    setTaskPerson: async (taskId, request) => (await call(TaskPeopleChangeResponseSchema, "POST", path(taskId, "/people/role"), request)).change,
    takeTaskOwnership: async (taskId, request) => {
      const answer = await call(z.union([TaskPeopleChangeResponseSchema, NeedsConfirmationSchema.extend({ requestId: z.string().optional() })]), "POST", path(taskId, "/people/take-ownership"), request);
      return "change" in answer ? answer.change : { status: "PENDING", requestId: request.requestId, confirmationUrl: answer.confirmUrl };
    },
    listAgents: async (query) => (await call(z.object({ agents: z.array(AgentSummarySchema) }), "GET", `/v1/app/agents${query.project === undefined ? "" : `?project=${encodeURIComponent(query.project)}`}`)).agents,
    runAgent: async (agentId, request) => {
      const answer = await call(z.union([DeveloperTaskResponseSchema, OwnerApprovalWaitSchema]), "POST", `/v1/app/agents/${encodeURIComponent(agentId)}/runs`, request, true, { busyStep: START_BUSY_STEP });
      if ("status" in answer) {
        // Owner decision 2026-10-22: a version less safe than the one that runs now waits for the agent's owner; this is not a started run.
        throw new ToolError("OWNER_APPROVAL_NEEDED", `That version of the agent is less safe than the one that runs now, so the agent's owner has to OK this run first. Nothing started. Give this link to the owner, who approves it signed in: ${plainText(answer.confirmUrl, "")}${answer.changes.length === 0 ? "" : ` (${answer.changes.map((change) => plainText(change, "")).join("; ")})`}`);
      }
      return task(answer);
    },
    listApprovals: async () => (await call(z.object({ approvals: z.array(ApprovalSummarySchema) }), "GET", "/v1/app/approvals?status=PENDING")).approvals,
    getApproval: async (approvalId) => (await call(z.object({ approval: ApprovalSummarySchema }), "GET", `/v1/app/approvals/${encodeURIComponent(approvalId)}`)).approval,
    // A POST without a body: repeatable() keeps it to one try, so a ticket is minted at most once per call.
    listSessions: (query) => {
      const search = new URLSearchParams();
      if (query.owner !== undefined) search.set("owner", query.owner);
      if (query.shared !== undefined) search.set("shared", query.shared);
      if (query.project !== undefined) search.set("project", query.project);
      if (query.status !== undefined) search.set("status", query.status);
      if (query.cursor !== undefined) search.set("cursor", query.cursor);
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      return call(SessionListReaderSchema, "GET", `/v1/app/sessions?${search.toString()}`);
    },
    getSession: async (sessionId) => pinned((await call(SessionResponseReaderSchema, "GET", sessionPath(sessionId))).session),
    commentOnSession: (sessionId, request) => call(SessionMessageReaderSchema, "POST", sessionPath(sessionId, "/messages"), { requestId: request.requestId, kind: "comment", text: request.text }),
    tellSessionAgent: (sessionId, request) => call(SessionMessageReaderSchema, "POST", sessionPath(sessionId, "/messages"), { requestId: request.requestId, kind: "steer", text: request.text }),
    stopSession: async (sessionId, requestId) => {
      const answer = await call(SessionResponseReaderSchema, "POST", sessionPath(sessionId, "/stop"), { requestId });
      const view = await pinned(answer.session);
      return answer.stop === "NOTHING_RUNNING" ? { ...view, nothingRunning: answer.message ?? "Nothing was running to stop." } : view;
    },
    answerTaskQuestions: async (sessionId, request) => pinned((await call(SessionResponseReaderSchema, "POST", sessionPath(sessionId, "/answers"), request)).session),
    approvalConfirmLink: (approvalId) => call(z.object({ confirmUrl: z.string(), ticketed: z.boolean() }), "POST", `/v1/app/approvals/${encodeURIComponent(approvalId)}/confirm-link`),
  };
}
