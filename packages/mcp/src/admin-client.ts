// Spec 025 A14: the admin tools' view of the control plane, with the admin sign-in `agentx login
// --admin` stored. Every answer is parsed with the contracts' schemas; every refusal becomes one of
// FR-049's codes. The token is never part of an error, a log line or a result.
import { randomUUID } from "node:crypto";
import {
  AdminBindingsResponseSchema, AdminFailuresResponseSchema, AdminHealthResponseSchema, AdminMeResponseSchema, AdminProjectsResponseSchema,
  AdminUsageResponseSchema, AdminWorkspacesResponseSchema,
  type AdminBindingsResponse, type AdminFailuresResponse, type AdminHealthResponse, type AdminMeResponse, type AdminProjectsResponse,
  type AdminUsageGroupBy, type AdminUsageResponse, type AdminWorkspacesResponse,
} from "@agentx/contracts";
import { z } from "zod";
import { NEXT_STEPS, ToolError, UNEXPECTED_ANSWER_STEP, UPGRADE_AGENTX_STEP, plainText } from "./errors.js";

export const ADMIN_SIGN_IN_STEP = "run npx @charterarc/agentx login --admin";
export interface AdminSession { baseUrl: string; accessToken: string }
export type AdminFailuresQuery = { since?: string; until?: string; project?: string; limit?: number };
export type AdminTurnsQuery = { since: string; until?: string; project?: string; origin?: "slack" | "ai_tool"; thread?: string; task?: string; limit?: number; cursor?: string };
export type AdminUsageQuery = { since?: string; until?: string; groupBy: AdminUsageGroupBy };
export type AdminWorkspacesQuery = { project?: string; status?: string; limit?: number };
const AdminCredentialsResponseSchema = z.object({ credentials: z.array(z.object({ ref: z.string(), type: z.string(), secretName: z.string(), registeredAt: z.string().optional(), builtIn: z.boolean().optional() })) });
export type AdminCredentialsResponse = z.infer<typeof AdminCredentialsResponseSchema>;
const AdminTurnsPageSchema = z.object({ turns: z.array(z.record(z.string(), z.unknown())), cursor: z.string().optional(), skipped: z.number().int().nonnegative().optional() });
/** { turns, cursor?, skipped? }; inferred, so it fits exactOptionalPropertyTypes. */
export type AdminTurnsPage = z.infer<typeof AdminTurnsPageSchema>;

export interface AdminControlPlaneClient {
  me(): Promise<AdminMeResponse>;
  health(): Promise<AdminHealthResponse>;
  failures(query: AdminFailuresQuery): Promise<AdminFailuresResponse>;
  turns(query: AdminTurnsQuery): Promise<AdminTurnsPage>;
  usage(query: AdminUsageQuery): Promise<AdminUsageResponse>;
  projects(): Promise<AdminProjectsResponse>;
  bindings(): Promise<AdminBindingsResponse>;
  credentials(): Promise<AdminCredentialsResponse>;
  workspaces(query: AdminWorkspacesQuery): Promise<AdminWorkspacesResponse>;
}

/** The broker's catch-all refusal for a path it does not serve: a control plane from before 25d. */
const NOT_AN_ADMIN_ROUTE = "this endpoint serves administration only";
const REQUEST_TIMEOUT_MS = 30_000;

function refusal(status: number, value: unknown, secret: string): ToolError {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = plainText(error?.message, `AgentX answered HTTP ${status}`, [secret]);
  if (status === 401 || code === "AUTH_REQUIRED") return new ToolError("ADMIN_REQUIRED", "AgentX refused this computer's admin sign-in, or it has expired", ADMIN_SIGN_IN_STEP);
  if (code === "FORBIDDEN" && message.includes(NOT_AN_ADMIN_ROUTE)) return new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin read routes yet", UPGRADE_AGENTX_STEP);
  if (code === "FORBIDDEN") return new ToolError("ADMIN_REQUIRED", `AgentX refused: ${message}`, ADMIN_SIGN_IN_STEP);
  if (code === "CONFIG_INVALID") return new ToolError("INVALID_REQUEST", message);
  return new ToolError("CONTROL_PLANE_UNAVAILABLE", message, status >= 500 ? NEXT_STEPS.CONTROL_PLANE_UNAVAILABLE : UNEXPECTED_ANSWER_STEP);
}

const search = (values: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

export function httpAdminClient(options: { session(): Promise<AdminSession>; fetch: typeof fetch; traceId?(): string; tries?: number; sleep?(ms: number): Promise<void> }): AdminControlPlaneClient {
  const tries = Math.max(1, options.tries ?? 3);
  const sleep = (ms: number): Promise<void> => (options.sleep ? options.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    // A ToolError from the session (ADMIN_REQUIRED: no admin sign-in held, Task 16) passes through.
    const session = await options.session();
    const where = plainText(session.baseUrl, "its URL", [session.accessToken]);
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await options.fetch(`${session.baseUrl}${path}`, {
          method: "GET",
          headers: { authorization: `Bearer ${session.accessToken}`, "x-agentx-trace-id": options.traceId?.() ?? randomUUID() },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        text = await response.text().catch(() => "");
      } catch {
        // The fetch error's own words are never shown: they can quote the request.
        if (attempt < tries) { await sleep(250 * attempt); continue; }
        throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${where} after ${attempt} tries`);
      }
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = undefined; }
      if (response.status >= 500 && attempt < tries) { await sleep(250 * attempt); continue; }
      if (!response.ok) throw refusal(response.status, value, session.accessToken);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", "AgentX answered with something this version of the CLI cannot read; upgrade it", NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }
  return {
    me: () => get(AdminMeResponseSchema, "/v1/admin/me"),
    health: () => get(AdminHealthResponseSchema, "/v1/admin/health"),
    failures: (query) => get(AdminFailuresResponseSchema, `/v1/admin/failures${search({ since: query.since, until: query.until, project: query.project, limit: query.limit })}`),
    turns: (query) => get(AdminTurnsPageSchema, `/v1/admin/turns${search({ since: query.since, until: query.until, project: query.project, origin: query.origin, thread: query.thread, task: query.task, limit: query.limit, cursor: query.cursor })}`),
    usage: (query) => get(AdminUsageResponseSchema, `/v1/admin/usage${search({ since: query.since, until: query.until, group_by: query.groupBy })}`),
    projects: () => get(AdminProjectsResponseSchema, "/v1/admin/projects"),
    bindings: () => get(AdminBindingsResponseSchema, "/v1/admin/slack/bindings"),
    credentials: () => get(AdminCredentialsResponseSchema, "/v1/admin/credentials"),
    workspaces: (query) => get(AdminWorkspacesResponseSchema, `/v1/admin/workspaces${search({ project: query.project, status: query.status, limit: query.limit })}`),
  };
}
