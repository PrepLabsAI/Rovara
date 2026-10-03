// packages/mcp/src/change-tools.ts
// Spec 025 FR-030: the admin change tools. Each call plans the change, gets a confirmation the
// model cannot give (the client's pop-up, or the Slack Confirm button), and only then applies it,
// all in one call (FR-039 to FR-041). No tool applies or declines a change directly, and no tool
// input reaches the apply or the decline: only confirmChange's human answer does (SC-005).
// agentx_admin_changes reads the audit records (FR-052).
import { ADMIN_LIST_MAX, AdminChangeOutcomeSchema, type AdminChangeInput } from "@agentx/contracts";
import { z } from "zod";
import { adminOf } from "./admin-tools.js";
import { confirmChange, changeError, type ConfirmationOutcome } from "./confirmation.js";
import { APPLY_UNKNOWN_STEP } from "./admin-client.js";
import { ToolError } from "./errors.js";
import { requestIdFor, type ToolCall, type ToolContext, type ToolDefinition, type ToolResult } from "./tools.js";

const requestIdInput = z.string().uuid().optional().describe("a UUID of your choosing; send the same one again to retry safely. When left out, an identical call within 15 minutes counts as a retry of the first");
const ChangeShape = { change_id: z.string(), outcome: z.enum(["applied", "awaiting_confirmation"]), effect: z.string(), method: z.string().optional(), result: z.record(z.string(), z.unknown()).optional(), expires_at: z.string(), request_id: z.string() };
const HOW = "It first shows exactly what will change and asks you to confirm in a pop-up, or with the Confirm button AgentX sends you in Slack; nothing changes until you do. If you confirm in Slack after this call stops waiting, the change still applies within 10 minutes; check it with agentx_admin_changes.";
/** A retry that met a change AgentX is applying right now (a Slack press, say). */
const APPLYING_STEP = "check its outcome with agentx_admin_changes in a minute; a change applies at most once";

/** What makes a change call the same call: the change itself (B3's memory key). */
const contentOf = (change: AdminChangeInput): readonly unknown[] => ["admin_change", change];

async function runChange(context: ToolContext, call: ToolCall, input: Record<string, unknown>, change: AdminChangeInput): Promise<ToolResult> {
  const admin = adminOf(context);
  // FR-041: the pop-up only in a client that declared it and where the environment allows it;
  // Slack only where the environment allows it and the admin has a Slack link.
  const allowed = (await context.confirmation?.()) ?? { elicitation: false, slack: false };
  const methods = [...(call.elicit !== undefined && allowed.elicitation ? ["elicitation" as const] : []), ...(allowed.slack ? ["slack" as const] : [])];
  if (methods.length === 0) throw new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session");
  // FR-052: one trace ID for the whole tool call: the proposal, the apply, the Slack step and every poll.
  const traceId = context.newRequestId();
  const content = contentOf(change);
  const requestId = requestIdFor(context, call, input, content);
  let settled: ConfirmationOutcome | undefined;
  /**
   * A change AgentX is applying has not ended either: a retry learns its outcome (review fix 1).
   * Nor has one whose apply was sent with no answer back (final review I1): it may have applied.
   */
  let applying = false;
  try {
    const planned = await admin.proposeChange({
      requestId, change, methods,
      client: { cliVersion: context.serverVersion, ...(context.clientName === undefined ? {} : { mcpClient: { name: context.clientName.slice(0, 200), ...(context.clientVersion === undefined ? {} : { version: context.clientVersion.slice(0, 64) }) } }) },
    }, traceId);
    // A repeated request ID answers a change already decided.
    if (planned.status === "pending") {
      settled = await confirmChange({
        admin, change: planned, traceId,
        ...(call.elicit === undefined ? {} : { elicit: call.elicit.bind(call) }),
        ...(call.progress === undefined ? {} : { progress: call.progress.bind(call) }),
        // The wait's sleep gets the tool call's own signal, so a cancel ends it at once.
        sleep: (ms, signal) => context.sleep(ms, signal), now: () => context.now(), signal: call.signal,
        ...(call.log === undefined ? {} : { log: call.log.bind(call) }),
      });
    } else if (planned.status === "applied") {
      settled = { outcome: "applied", change: planned };
    } else if (planned.status === "applying") {
      applying = true;
      throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `change ${planned.changeId}: AgentX is applying it now`, APPLYING_STEP);
    } else {
      throw changeError(planned);
    }
  } catch (error) {
    if (error instanceof ToolError && error.nextStep === APPLY_UNKNOWN_STEP) applying = true;
    throw error;
  } finally {
    // B3, FR-049: a change that ended (applied, declined, expired, stale, refused or failed) is
    // forgotten, so asking for it again plans a new change. Only one still waiting for its Slack
    // Confirm, one AgentX is applying, or one whose apply's outcome is unknown, keeps its request
    // ID, so an unchanged retry is that same change.
    if (settled?.outcome !== "awaiting_confirmation" && !applying) call.requestIds?.forget(content);
  }
  const view = settled.change;
  return {
    structured: {
      change_id: view.changeId, outcome: settled.outcome, effect: view.effect, expires_at: view.expiresAt, request_id: requestId,
      ...(view.methodUsed === undefined ? {} : { method: view.methodUsed }), ...(view.result === undefined ? {} : { result: view.result }),
    },
    text: settled.outcome === "applied"
      ? `Applied change ${view.changeId}: ${view.effect}`
      : `Change ${view.changeId} is waiting for your Confirm in Slack until ${view.expiresAt}: ${view.effect} Check it with agentx_admin_changes.`,
  };
}

const tool = (name: string, title: string, what: string, inputSchema: z.ZodRawShape, toChange: (input: Record<string, unknown>) => AdminChangeInput): ToolDefinition => ({
  name, title, description: `${what} ${HOW}`, inputSchema: { ...inputSchema, request_id: requestIdInput }, outputSchema: ChangeShape,
  // SC-005: only the fields each tool names reach the change; anything else the model sends is dropped.
  handler: (context, input, call) => runChange(context, call, input, toChange(input)),
});
const text = (value: unknown) => value as string;
/** The broker strips a leading "#" from a channel's name. */
const CHANNEL_NAME = "or a public channel's name, with or without #";

export const ADMIN_CHANGE_TOOLS: readonly ToolDefinition[] = [
  tool("agentx_admin_register_project_revision", "Register an AgentX project revision",
    "Registers a new revision of an existing project from its full definition, keeping the project's worker settings. The confirmation shows the new revision number, each changed field, and the registration preflight's findings.",
    { definition: z.record(z.string(), z.unknown()).describe("the whole project definition, with name and the next revision number") },
    (input) => ({ kind: "register_project_revision", definition: input.definition as Record<string, unknown> })),
  tool("agentx_admin_bind_channel", "Bind a Slack channel to an AgentX project",
    "Binds a Slack channel to a project, so new threads there use the project's latest revision. The confirmation shows the channel, what it is bound to today, and the revision new threads will use.",
    { channel: z.string().min(1).max(80).describe(`a channel ID such as C0123456789, ${CHANNEL_NAME}`), project: z.string().min(1).max(63).describe("the project's exact name") },
    (input) => ({ kind: "bind_channel", channel: text(input.channel), project: text(input.project) })),
  tool("agentx_admin_unbind_channel", "Unbind a Slack channel",
    "Removes a channel's binding: new messages there get no reply, and existing thread workspaces are kept.",
    { channel: z.string().min(1).max(80).describe(`a channel ID, ${CHANNEL_NAME}`) },
    (input) => ({ kind: "unbind_channel", channel: text(input.channel) })),
  tool("agentx_admin_register_credential", "Register an AgentX connector credential",
    "Registers a connector credential by reference, type and secret name. Never pass a secret's value: AgentX refuses any input that looks like one. The confirmation shows whether the secret exists and reads as that type, and which projects name the reference.",
    { ref: z.string().min(1).max(63).describe("the credential reference connectors name"), type: z.string().min(1).max(64).describe("static-secret, oauth-client-credentials or oauth-refresh-token"), secret_name: z.string().min(1).max(512).describe("the secret's name under the connector secret prefix, never its value"), host: z.string().min(1).max(253).optional().describe("the one MCP host the credential may be sent to, such as mcp.sentry.dev; required by a generic mcp connector") },
    (input) => ({ kind: "register_credential", ref: text(input.ref), type: text(input.type), secretName: text(input.secret_name), ...(input.host === undefined ? {} : { host: text(input.host) }) })),
  tool("agentx_admin_stop_workspace", "Stop a workspace's running task",
    "Cancels the task running in a workspace; its compute stops on its own when idle. The confirmation shows the workspace, its project, owner and status, and the task that will be cancelled.",
    { workspace_id: z.string().uuid().describe("the workspace ID, from agentx_admin_list_workspaces") },
    (input) => ({ kind: "stop_workspace", workspaceId: text(input.workspace_id) })),
  tool("agentx_admin_grant_project_access", "Grant a developer access to an AgentX project",
    "Lets a developer hand tasks to a project from their AI tool, whatever channels they are in. Name them by Slack user ID (which works before their first sign-in), by the email they signed in with, or by developer ID. The confirmation shows who they are and their current access.",
    { project: z.string().min(1).max(63).describe("the project's exact name"), developer: z.string().min(1).max(254).describe("a Slack user ID such as U0123456789, an email, or a developer ID") },
    (input) => ({ kind: "grant_project_access", project: text(input.project), developer: text(input.developer) })),
  tool("agentx_admin_revoke_project_access", "Revoke a developer's granted project access",
    "Removes a developer's grant for a project; their running tasks keep running, and channel membership may still give them access, which the confirmation says.",
    { project: z.string().min(1).max(63).describe("the project's exact name"), developer: z.string().min(1).max(254).describe("a Slack user ID, an email, or a developer ID") },
    (input) => ({ kind: "revoke_project_access", project: text(input.project), developer: text(input.developer) })),
  tool("agentx_admin_revoke_signin", "End a developer's AgentX sign-in",
    "Ends every AgentX sign-in session a developer has, at once; they may sign in again. Their running tasks keep running.",
    { developer: z.string().min(1).max(254).describe("a Slack user ID, an email, or a developer ID") },
    (input) => ({ kind: "revoke_signin", developer: text(input.developer) })),
  tool("agentx_admin_set_workspace_limits", "Set AgentX's workspace limits",
    "Changes how many workspaces one person, and the whole organization, may have open. It takes effect at the next workspace creation, with no stack update; existing workspaces keep running. The confirmation shows the current and new limits, the counts, and who is already at or over the new limit.",
    { per_person: z.number().int().min(1).max(50).optional().describe("the per-person limit, 1 to 50"), per_organization: z.number().int().min(1).max(1_000).optional().describe("the organization limit, 1 to 1,000") },
    (input) => {
      if (input.per_person === undefined && input.per_organization === undefined) throw new ToolError("INVALID_REQUEST", "give per_person, per_organization or both");
      return { kind: "set_workspace_limits", ...(input.per_person === undefined ? {} : { perPerson: input.per_person as number }), ...(input.per_organization === undefined ? {} : { perOrganization: input.per_organization as number }) };
    }),
];

export const ADMIN_AUDIT_TOOLS: readonly ToolDefinition[] = [{
  name: "agentx_admin_changes",
  title: "Read AgentX admin change records",
  description: "Lists admin change records, newest first: who asked and from which client, the exact change, how it was confirmed (and by which Slack user), its outcome with the time of each step, the result or error, refused attempts, and its trace ID. since defaults to 7 days ago; records are kept 30 days. Send next_cursor back as cursor for more.",
  inputSchema: {
    since: z.string().datetime({ offset: true }).optional().describe("ISO time to start from; 7 days ago by default"),
    until: z.string().datetime({ offset: true }).optional().describe("ISO time to stop at"),
    admin: z.string().min(1).max(256).optional().describe("only changes this admin asked for, by their sign-in subject"),
    outcome: AdminChangeOutcomeSchema.optional().describe("confirmed, declined, expired or failed"),
    limit: z.number().int().min(1).max(ADMIN_LIST_MAX).optional().describe("how many to show, 1 to 100; 25 by default"),
    cursor: z.string().min(1).max(2_048).optional().describe("next_cursor from the previous call"),
  },
  outputSchema: { changes: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().optional() },
  async handler(context, input) {
    const since = (input.since as string | undefined) ?? new Date(context.now() - 7 * 86_400_000).toISOString();
    const page = await adminOf(context).changes({ since, ...Object.fromEntries(["until", "admin", "outcome", "limit", "cursor"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) });
    const changes = page.changes.map((record) => ({
      change_id: record.changeId, kind: record.kind, status: record.status, ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      admin: record.admin.displayName ?? record.admin.subject, client: record.client, change: record.change, effect: record.effect,
      methods_offered: record.methodsOffered, ...(record.methodUsed === undefined ? {} : { method_used: record.methodUsed }), ...(record.pressedBy === undefined ? {} : { pressed_by: record.pressedBy }),
      proposed_at: record.proposedAt, ...Object.fromEntries((["confirmationRequestedAt", "answeredAt", "appliedAt", "failedAt", "expiredAt"] as const).filter((key) => record[key] !== undefined).map((key) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), record[key]])),
      ...(record.result === undefined ? {} : { result: record.result }), ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.refusedAttempts === undefined ? {} : { refused_attempts: record.refusedAttempts }), trace_id: record.traceId,
    }));
    return {
      structured: { changes, ...(page.cursor === undefined ? {} : { next_cursor: page.cursor }) },
      text: `${changes.length} change record${changes.length === 1 ? "" : "s"}.${page.cursor === undefined ? "" : " More remain: call again with cursor set to next_cursor."}`,
    };
  },
}];
