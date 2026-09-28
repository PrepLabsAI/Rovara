// Spec 025 FR-027: the tools' view of the control plane. The stdio server gives it the signed-in
// developer's session (packages/cli); the hosted endpoint will give it another.
import { randomUUID } from "node:crypto";
import {
  AgentXError,
  DeveloperCloseResponseSchema,
  DeveloperProjectsResponseSchema,
  DeveloperPullRequestResponseSchema,
  DeveloperTaskListResponseSchema,
  DeveloperTaskResponseSchema,
  type ContinueDeveloperTaskRequest,
  type DeveloperCloseResponse,
  type DeveloperProjectsResponse,
  type DeveloperPullRequestRequest,
  type DeveloperPullRequestResponse,
  type DeveloperTaskListItem,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type StartDeveloperTaskRequest,
} from "@agentx/contracts";
import { z } from "zod";
import { NEXT_STEPS, ToolError, isMeaningfulCode, plainText, signInStep, toolErrorFromResponse } from "./errors.js";

export interface ControlPlaneSession { baseUrl: string; accessToken: string; signInCommand: string }

export interface ControlPlaneClient {
  /** The environment's agentx-configuration, read without a token. */
  configuration(): Promise<{ env: string; apiVersion: string; baseUrl: string }>;
  projects(): Promise<DeveloperProjectsResponse>;
  startTask(request: StartDeveloperTaskRequest): Promise<DeveloperTaskView>;
  getTask(taskId: string, events: number): Promise<DeveloperTaskView>;
  listTasks(query: { project?: string; status?: DeveloperTaskStatus; limit: number }): Promise<DeveloperTaskListItem[]>;
  continueTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  cancelTask(taskId: string, requestId: string): Promise<DeveloperTaskView>;
  closeTask(taskId: string, requestId: string): Promise<DeveloperCloseResponse>;
  openPullRequest(taskId: string, request: DeveloperPullRequestRequest): Promise<DeveloperPullRequestResponse>;
}

const ConfigurationSchema = z.object({ env: z.string(), apiVersion: z.string() });
const UNREADABLE = "AgentX answered with something this version of the CLI cannot read; upgrade it";
const DEFAULT_SIGN_IN = "npx @charterarc/agentx login <your AgentX URL>";
const REQUEST_TIMEOUT_MS = 30_000;

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
  session(): Promise<ControlPlaneSession>;
  fetch: typeof fetch;
  traceId?(): string;
  sleep?(ms: number): Promise<void>;
  tries?: number;
}): ControlPlaneClient {
  const sleep = (ms: number): Promise<void> => (options.sleep ? options.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tries = Math.max(1, options.tries ?? 3);

  async function session(): Promise<ControlPlaneSession> {
    try {
      return await options.session();
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

  async function send<T>(current: ControlPlaneSession, schema: z.ZodType<T>, method: string, path: string, body: unknown, authorized: boolean): Promise<T> {
    const maxTries = repeatable(method, body) ? tries : 1;
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { "x-agentx-trace-id": options.traceId?.() ?? randomUUID() };
      if (authorized) headers.authorization = `Bearer ${current.accessToken}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await options.fetch(`${current.baseUrl}${path}`, {
          method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < maxTries) {
          await sleep(500 * attempt);
          continue;
        }
        throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${plainText(current.baseUrl, "its URL")}${attempt > 1 ? ` after ${attempt} tries` : ""}`);
      }
      const text = await response.text().catch(() => "");
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = undefined;
      }
      // An outage is tried again; a 5xx that names what is wrong (SLACK_UNAVAILABLE) is the answer.
      if (response.status >= 500 && attempt < maxTries && !isMeaningfulCode(errorCodeOf(value))) {
        await sleep(500 * attempt);
        continue;
      }
      if (!response.ok) throw toolErrorFromResponse(response.status, value, current.signInCommand);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", UNREADABLE, NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }

  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, authorized = true): Promise<T> {
    const current = await session();
    try {
      return await send(current, schema, method, path, body, authorized);
    } catch (error) {
      // The access token never appears in what a tool returns, whatever the server echoed.
      if (error instanceof ToolError && current.accessToken !== "") {
        const hide = (text: string) => text.split(current.accessToken).join("[REDACTED]");
        throw new ToolError(error.code, hide(error.message), hide(error.nextStep));
      }
      throw error;
    }
  }

  const task = (response: { task: DeveloperTaskView }) => response.task;
  const path = (taskId: string, rest = "") => `/v1/dev/tasks/${encodeURIComponent(taskId)}${rest}`;
  return {
    configuration: async () => {
      const current = await session();
      const value = await send(current, ConfigurationSchema, "GET", "/v1/auth/.well-known/agentx-configuration", undefined, false);
      return { env: value.env, apiVersion: value.apiVersion, baseUrl: current.baseUrl };
    },
    projects: () => call(DeveloperProjectsResponseSchema, "GET", "/v1/dev/projects"),
    startTask: async (request) => task(await call(DeveloperTaskResponseSchema, "POST", "/v1/dev/tasks", request)),
    getTask: async (taskId, events) => task(await call(DeveloperTaskResponseSchema, "GET", path(taskId, `?events=${events}`))),
    listTasks: async (query) => {
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.project !== undefined) search.set("project", query.project);
      if (query.status !== undefined) search.set("status", query.status);
      return (await call(DeveloperTaskListResponseSchema, "GET", `/v1/dev/tasks?${search.toString()}`)).tasks;
    },
    continueTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/continue"), request)),
    cancelTask: async (taskId, requestId) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/cancel"), { requestId })),
    closeTask: (taskId, requestId) => call(DeveloperCloseResponseSchema, "POST", path(taskId, "/close"), { requestId }),
    openPullRequest: (taskId, request) => call(DeveloperPullRequestResponseSchema, "POST", path(taskId, "/pull-requests"), request),
  };
}
