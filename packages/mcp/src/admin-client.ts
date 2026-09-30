// Spec 025 A14: the admin tools' view of the control plane, with the admin sign-in `agentx login
// --admin` stored. Every answer is parsed with the contracts' schemas; every refusal becomes one of
// FR-049's codes. The token is never part of an error, a log line or a result.
import { randomUUID } from "node:crypto";
import {
  AdminBindingsResponseSchema, AdminFailuresResponseSchema, AdminHealthResponseSchema, AdminMeResponseSchema, AdminProjectsResponseSchema,
  AdminChangeResponseWireSchema, AdminChangesResponseWireSchema, AdminUsageResponseSchema, AdminWorkspacesResponseSchema,
  type AdminBindingsResponse, type AdminChangeOutcome, type AdminChangeViewWire, type AdminChangesResponseWire,
  type ApplyAdminChangeRequest, type DeclineAdminChangeRequest, type ProposeAdminChangeRequest, type AdminFailuresResponse, type AdminHealthResponse, type AdminMeResponse, type AdminProjectsResponse,
  type AdminUsageGroupBy, type AdminUsageResponse, type AdminWorkspacesResponse,
} from "@agentx/contracts";
import { z } from "zod";
import { NEXT_STEPS, ToolError, UNEXPECTED_ANSWER_STEP, UPGRADE_AGENTX_STEP, plainText, type ToolErrorCode } from "./errors.js";

export const ADMIN_SIGN_IN_STEP = "run npx @charterarc/agentx login --admin";
export interface AdminSession { baseUrl: string; accessToken: string }
export type AdminFailuresQuery = { since?: string; until?: string; project?: string; limit?: number };
export type AdminTurnsQuery = { since: string; until?: string; project?: string; origin?: "slack" | "ai_tool"; thread?: string; task?: string; limit?: number; cursor?: string };
export type AdminUsageQuery = { since?: string; until?: string; groupBy: AdminUsageGroupBy };
export type AdminWorkspacesQuery = { project?: string; status?: string; limit?: number };
export type AdminChangesQuery = { since?: string; until?: string; admin?: string; outcome?: AdminChangeOutcome; limit?: number; cursor?: string };
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
  // Spec 025 E4: the change routes. Answers are read loosely (R1): a newer control plane's status,
  // kind or method is a plain string here, and the driver treats one it does not know as neither
  // applied nor pending. Each takes the change tool call's one trace ID (FR-052).
  proposeChange(request: ProposeAdminChangeRequest, traceId: string): Promise<AdminChangeViewWire>;
  /** A poll inside a wait passes the tool call's signal, and one try (the wait polls again). */
  getChange(changeId: string, traceId: string, options?: { signal?: AbortSignal; tries?: number }): Promise<AdminChangeViewWire>;
  startSlackConfirmation(changeId: string, traceId: string): Promise<AdminChangeViewWire>;
  applyChange(changeId: string, body: ApplyAdminChangeRequest, traceId: string): Promise<AdminChangeViewWire>;
  declineChange(changeId: string, body: DeclineAdminChangeRequest, traceId: string): Promise<AdminChangeViewWire>;
  changes(query: AdminChangesQuery): Promise<AdminChangesResponseWire>;
}

const ChangeView = AdminChangeResponseWireSchema.transform((value) => value.change);
/** Q9, E15: the change refusals keep their own code; the broker's words name the change. */
const CHANGE_CODES = new Set(["CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE"] as const);
/** Input the control plane refuses on a change: the broker's words say which. */
const CHANGE_INVALID = new Set(["NOT_FOUND", "PROJECT_REVISION_MISMATCH", "WORKSPACE_BUSY", "IDEMPOTENCY_CONFLICT"]);
export const PROJECT_ADMIN_STEP = "ask an AgentX admin who administers that project to make this change";
/** A transient failure of a step on a planned change: nothing applied, and the change is still pending. */
export const CHANGE_PENDING_STEP = "nothing was applied and the change is still pending until it expires; ask for the change again to confirm it";

/** The broker's catch-all refusal for a path it does not serve: a control plane from before 25d. */
const NOT_AN_ADMIN_ROUTE = "this endpoint serves administration only";
const REQUEST_TIMEOUT_MS = 30_000;
/** No call, retries included, takes longer than this (the developer client's DEADLINE_MS). */
const DEADLINE_MS = 45_000;

function refusal(status: number, value: unknown, secret: string, pending = false): ToolError {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = plainText(error?.message, `AgentX answered HTTP ${status}`, [secret]);
  if (status === 401 || code === "AUTH_REQUIRED") return new ToolError("ADMIN_REQUIRED", "AgentX refused this computer's admin sign-in, or it has expired", ADMIN_SIGN_IN_STEP);
  if (code === "FORBIDDEN" && message.includes(NOT_AN_ADMIN_ROUTE)) return new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin read routes yet", UPGRADE_AGENTX_STEP);
  if (code !== undefined && (CHANGE_CODES as Set<string>).has(code)) return new ToolError(code as ToolErrorCode, message);
  if (code === "SLACK_UNAVAILABLE") return new ToolError("SLACK_UNAVAILABLE", message);
  // FR-015: the admin may change only projects they administer.
  if (code === "FORBIDDEN" && message.includes("membership")) return new ToolError("ADMIN_REQUIRED", message, PROJECT_ADMIN_STEP);
  // A NOT_FOUND from requireMembership reads "project not found" for a project the admin does not administer.
  if (code !== undefined && CHANGE_INVALID.has(code)) return new ToolError("INVALID_REQUEST", message);
  if (code === "FORBIDDEN") return new ToolError("ADMIN_REQUIRED", `AgentX refused: ${message}`, ADMIN_SIGN_IN_STEP);
  if (code === "CONFIG_INVALID") return new ToolError("INVALID_REQUEST", message);
  // The broker answers RUNTIME_UNAVAILABLE only when nothing applied and the change is still pending.
  if (pending && code === "RUNTIME_UNAVAILABLE") return new ToolError("CONTROL_PLANE_UNAVAILABLE", message, CHANGE_PENDING_STEP);
  return new ToolError("CONTROL_PLANE_UNAVAILABLE", message, status >= 500 ? NEXT_STEPS.CONTROL_PLANE_UNAVAILABLE : UNEXPECTED_ANSWER_STEP);
}

/** The request's own timeout, and the caller's signal when it gave one: whichever ends first. */
const withCaller = (timeout: AbortSignal, caller: AbortSignal | undefined): AbortSignal => (caller === undefined ? timeout : AbortSignal.any([timeout, caller]));

const search = (values: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

export function httpAdminClient(options: { session(): Promise<AdminSession>; fetch: typeof fetch; traceId?(): string; tries?: number; sleep?(ms: number): Promise<void>; now?(): number; deadlineMs?: number }): AdminControlPlaneClient {
  const tries = Math.max(1, options.tries ?? 3);
  const now = (): number => (options.now ? options.now() : Date.now());
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const sleep = (ms: number): Promise<void> => (options.sleep ? options.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function send<T>(schema: z.ZodType<T>, method: "GET" | "POST", path: string, body: unknown, traceId: string | undefined, attempts: number, extra: { signal?: AbortSignal; pending?: boolean } = {}): Promise<T> {
    // A ToolError from the session (ADMIN_REQUIRED: no admin sign-in held, Task 16) passes through.
    const session = await options.session();
    const where = plainText(session.baseUrl, "its URL", [session.accessToken]);
    const started = now();
    /** Waits before the next try, or answers false when there is no try left or no time for one. */
    const again = async (attempt: number): Promise<boolean> => {
      const delay = 250 * attempt;
      if (attempt >= attempts || now() - started + delay >= deadlineMs) return false;
      await sleep(delay);
      return true;
    };
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await options.fetch(`${session.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "x-agentx-trace-id": traceId ?? options.traceId?.() ?? randomUUID(),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Each try gets what is left of the deadline, at most 30 seconds.
          signal: withCaller(AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadlineMs - (now() - started)))), extra.signal),
        });
        text = await response.text().catch(() => "");
      } catch {
        // The fetch error's own words are never shown: they can quote the request.
        if (await again(attempt)) continue;
        throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${where}${attempt > 1 ? ` after ${attempt} tries` : ""}`);
      }
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = undefined; }
      if (response.status >= 500 && await again(attempt)) continue;
      if (!response.ok) throw refusal(response.status, value, session.accessToken, extra.pending);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", "AgentX answered with something this version of the CLI cannot read; upgrade it", NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }
  const get = <T>(schema: z.ZodType<T>, path: string): Promise<T> => send(schema, "GET", path, undefined, undefined, tries);
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
    // Only the proposal is retried: its requestId makes a repeat the same request. An apply, a
    // decline or a Slack step is sent once. changeId is a UUID the control plane made.
    proposeChange: (request, traceId) => send(ChangeView, "POST", "/v1/admin/changes", request, traceId, tries),
    getChange: (changeId, traceId, poll) => send(ChangeView, "GET", `/v1/admin/changes/${encodeURIComponent(changeId)}`, undefined, traceId, Math.max(1, poll?.tries ?? tries), poll?.signal === undefined ? {} : { signal: poll.signal }),
    startSlackConfirmation: (changeId, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${encodeURIComponent(changeId)}/slack`, {}, traceId, 1, { pending: true }),
    applyChange: (changeId, body, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${encodeURIComponent(changeId)}/apply`, body, traceId, 1, { pending: true }),
    declineChange: (changeId, body, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${encodeURIComponent(changeId)}/decline`, body, traceId, 1, { pending: true }),
    changes: (query) => send(AdminChangesResponseWireSchema, "GET", `/v1/admin/changes${search({ since: query.since, until: query.until, admin: query.admin, outcome: query.outcome, limit: query.limit, cursor: query.cursor })}`, undefined, undefined, tries),
  };
}
