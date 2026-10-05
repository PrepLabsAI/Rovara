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
  type AgentXConfigurationConfirm,
  type ContinueDeveloperTaskRequest,
  type DeveloperCloseResponse,
  type DeveloperProjectsResponse,
  type DeveloperPullRequestRequest,
  type DeveloperPullRequestResponse,
  type DeveloperTaskListItem,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type ShareDeveloperTaskRequest,
  type StartDeveloperTaskRequest,
  type WorkflowDecisionRequest,
} from "@agentx/contracts";
import { z } from "zod";
import { CLOSE_BUSY_STEP, NEXT_STEPS, SHARE_BUSY_STEP, START_BUSY_STEP, ToolError, isMeaningfulCode, plainText, signInStep, toolErrorFromResponse } from "./errors.js";

export interface ControlPlaneSession { baseUrl: string; accessToken: string; signInCommand: string }

/** For a read inside a wait: its own deadline, and the tool call's signal, so a cancel ends it at once. */
export interface CallOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  /** TASK_BUSY's next step for a busy answer to this call (final review M1); the default is to wait or cancel. */
  busyStep?: string;
}

export interface ControlPlaneClient {
  /** The environment's agentx-configuration, read without a token. */
  configuration(): Promise<{ env: string; apiVersion: string; baseUrl: string; adminApiVersion?: string; confirm?: AgentXConfigurationConfirm }>;
  projects(): Promise<DeveloperProjectsResponse>;
  startTask(request: StartDeveloperTaskRequest): Promise<DeveloperTaskView>;
  getTask(taskId: string, events: number, options?: CallOptions): Promise<DeveloperTaskView>;
  listTasks(query: { project?: string; status?: DeveloperTaskStatus; limit: number }): Promise<DeveloperTaskListItem[]>;
  continueTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  decideWorkflowTask(taskId: string, request: WorkflowDecisionRequest): Promise<DeveloperTaskView>;
  startWorkflowReviewTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  retryWorkflowTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  cancelTask(taskId: string, requestId: string): Promise<DeveloperTaskView>;
  closeTask(taskId: string, requestId: string): Promise<DeveloperCloseResponse>;
  openPullRequest(taskId: string, request: DeveloperPullRequestRequest): Promise<DeveloperPullRequestResponse>;
  /** Spec 025 FR-030: shares the task, or changes a shared task's mode (API 1.2). */
  shareTask(taskId: string, request: ShareDeveloperTaskRequest): Promise<DeveloperTaskView>;
}

/** Spec 025 A1: adminApiVersion is absent from a control plane from before 25d. */
/** Spec 025 E16 (C22): confirm is absent from a control plane from before 25e. */
const ConfigurationSchema = z.object({ env: z.string(), apiVersion: z.string(), adminApiVersion: z.string().optional(), confirm: AgentXConfigurationConfirmSchema.optional() });
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
      const headers: Record<string, string> = { "x-agentx-trace-id": options.traceId?.() ?? randomUUID() };
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

  const task = (response: { task: DeveloperTaskView }) => response.task;
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
    cancelTask: async (taskId, requestId) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/cancel"), { requestId })),
    closeTask: (taskId, requestId) => call(DeveloperCloseResponseSchema, "POST", path(taskId, "/close"), { requestId }, true, { busyStep: CLOSE_BUSY_STEP }),
    openPullRequest: (taskId, request) => call(DeveloperPullRequestResponseSchema, "POST", path(taskId, "/pull-requests"), request),
    shareTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/share"), request, true, { busyStep: SHARE_BUSY_STEP })),
  };
}
