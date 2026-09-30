// packages/mcp/src/admin-tools.ts
// Spec 025 FR-030: the admin read tools. They change nothing and need no confirmation (US5); the
// server offers them only while an admin sign-in is held (FR-028, A15). Every result goes through
// the server's redaction and caps (FR-029, A16).
import {
  ADMIN_FAILURES_DEFAULT_LIMIT, ADMIN_LIST_MAX, ADMIN_WORKSPACES_DEFAULT_LIMIT, AdminUsageGroupBySchema, WorkspaceStatusSchema, inertName,
  type AdminRequester, type AdminUsageGroupBy,
} from "@agentx/contracts";
import { z } from "zod";
import { ADMIN_SIGN_IN_STEP, type AdminControlPlaneClient } from "./admin-client.js";
import { ToolError } from "./errors.js";
import type { ToolContext, ToolDefinition } from "./tools.js";

export function adminOf(context: ToolContext): AdminControlPlaneClient {
  if (context.admin === undefined) throw new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
  return context.admin;
}

const time = z.string().datetime({ offset: true });
const limitInput = (fallback: number) => z.number().int().min(1).max(ADMIN_LIST_MAX).optional().describe(`how many to show, 1 to 100; ${fallback} by default`);
const projectInput = z.string().min(1).max(63).optional().describe("only this project, by its exact name");
const given = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

function requesterText(requester: AdminRequester): string {
  if (requester.kind === "slack") return `Slack member ${requester.userId}`;
  if (requester.kind === "developer") return `${requester.name === undefined ? requester.developerId.slice(0, 12) : inertName(requester.name)} (developer)`;
  return "nobody recorded";
}

export const ADMIN_READ_TOOLS: readonly ToolDefinition[] = [
  {
    name: "agentx_admin_health",
    title: "Check AgentX health",
    description: "Shows whether AgentX is healthy: the API versions, the environment's alarms and their states, dead-letter queue depths, whether the Slack bot token and the GitHub App work, the worker mode and its latest dispatch failure, and open workspaces by status. Use it first when something seems wrong; then look at agentx_admin_failed_tasks for what failed.",
    inputSchema: {},
    outputSchema: {
      version: z.object({ developer_api: z.string(), admin_api: z.string(), release: z.string().optional() }),
      alarms: z.array(z.object({ name: z.string(), state: z.string() })), alarms_check: z.object({ status: z.string(), detail: z.string().optional() }),
      dead_letter_queues: z.array(z.object({ name: z.string(), depth: z.number().nullable() })),
      // Ruling R18: the queues' own check; absent from an older control plane's answer.
      dead_letter_queues_check: z.object({ status: z.string(), detail: z.string().optional() }).optional(),
      slack: z.object({ status: z.string(), detail: z.string().optional() }), github: z.object({ status: z.string(), detail: z.string().optional() }),
      worker_modes: z.array(z.object({ mode: z.string(), configured: z.boolean(), latest_dispatch_failure: z.object({ at: z.string(), operation_id: z.string(), error: z.string() }).optional() })),
      workspaces: z.record(z.string(), z.number()), workspaces_truncated: z.boolean(),
    },
    async handler(context) {
      const health = await adminOf(context).health();
      const firing = health.alarms.filter((alarm) => alarm.state === "ALARM").map((alarm) => alarm.name);
      return {
        structured: {
          version: given({ developer_api: health.version.developerApi, admin_api: health.version.adminApi, release: health.version.release }),
          alarms: health.alarms, alarms_check: health.alarmsCheck, dead_letter_queues: health.deadLetterQueues,
          ...(health.deadLetterQueuesCheck === undefined ? {} : { dead_letter_queues_check: health.deadLetterQueuesCheck }),
          slack: health.slack, github: health.github,
          worker_modes: health.workerModes.map((mode) => given({ mode: mode.mode, configured: mode.configured, latest_dispatch_failure: mode.latestDispatchFailure === undefined ? undefined : { at: mode.latestDispatchFailure.at, operation_id: mode.latestDispatchFailure.operationId, error: mode.latestDispatchFailure.error } })),
          workspaces: health.workspaces, workspaces_truncated: health.workspacesTruncated,
        },
        text: `AgentX API ${health.version.developerApi}, admin API ${health.version.adminApi}. Alarms: ${firing.length === 0 ? "none firing" : `in ALARM: ${firing.join(", ")}`}. Dead-letter queues: ${health.deadLetterQueuesCheck?.status ?? "not reported by this AgentX"}. Slack: ${health.slack.status}. GitHub App: ${health.github.status}. Open workspaces: ${Object.entries(health.workspaces).map(([status, count]) => `${status} ${count}`).join(", ") || "none"}.`,
      };
    },
  },
  {
    name: "agentx_admin_failed_tasks",
    title: "List failed AgentX tasks",
    description: "Lists operations that ended FAILED or INTERRUPTED, newest first: when, the project, where it came from (slack or ai_tool), who asked, the workspace, the operation kind, the failure category and the redacted error. since defaults to 24 hours ago; AgentX keeps 30 days. To see what happened around a failure, pass its turn_record's thread or task_id to agentx_admin_turns. Use it when a task or a Slack turn went wrong, or after agentx_admin_health shows a problem.",
    inputSchema: {
      since: time.optional().describe("ISO time to start from; 24 hours ago by default"),
      until: time.optional().describe("ISO time to stop at; now by default"),
      project: projectInput,
      limit: limitInput(ADMIN_FAILURES_DEFAULT_LIMIT),
    },
    outputSchema: {
      failures: z.array(z.object({
        time: z.string(), project: z.string(), origin: z.string(), requester: z.string(), workspace_id: z.string(), operation_id: z.string(),
        operation_kind: z.string(), category: z.string(), error: z.string(), turn_record: z.object({ thread: z.string().optional(), task_id: z.string().optional() }),
      })),
      since: z.string(), until: z.string(),
      skipped: z.number().optional(),
    },
    async handler(context, input) {
      const answer = await adminOf(context).failures(given({ since: input.since as string | undefined, until: input.until as string | undefined, project: input.project as string | undefined, limit: input.limit as number | undefined }));
      const failures = answer.failures.map((failure) => ({
        time: failure.endedAt, project: failure.project, origin: failure.origin, requester: requesterText(failure.requester), workspace_id: failure.workspaceId, operation_id: failure.operationId,
        operation_kind: failure.kind, category: failure.category, error: failure.error, turn_record: given({ thread: failure.thread, task_id: failure.taskId }),
      }));
      const byCategory = new Map<string, number>();
      for (const failure of failures) byCategory.set(failure.category, (byCategory.get(failure.category) ?? 0) + 1);
      return {
        structured: given({ failures, since: answer.since, until: answer.until, skipped: answer.skipped }),
        text: failures.length === 0 ? `No failures from ${answer.since} to ${answer.until}.` : `${failures.length} failure${failures.length === 1 ? "" : "s"} from ${answer.since} to ${answer.until}: ${[...byCategory].map(([category, count]) => `${category} ${count}`).join(", ")}.`,
      };
    },
  },
  {
    name: "agentx_admin_turns",
    title: "Read AgentX turn records",
    description: "Reads turn records, newest first: what each Slack turn was asked, offered, chose and answered, and each action from an AI tool. They hold request and response text, already redacted. Narrow them with until, project, origin (slack or ai_tool), thread (a Slack thread subject) or task_id (a task's own records and its channel turns); send next_cursor back as cursor for more. since is required; AgentX keeps 30 days. Use it to see what a failure's thread or task asked and answered; then compare with agentx_admin_failed_tasks.",
    inputSchema: {
      since: time.describe("ISO time to start from, within the last 30 days"),
      until: time.optional().describe("ISO time to stop at"),
      project: projectInput,
      origin: z.enum(["slack", "ai_tool"]).optional().describe("only Slack turns, or only actions from AI tools"),
      thread: z.string().min(1).max(128).optional().describe("a Slack thread subject such as T0123456789/C0123456789/1695500000.000100"),
      task_id: z.string().uuid().optional().describe("a task's ID: its own records and its channel turns"),
      limit: limitInput(ADMIN_LIST_MAX),
      cursor: z.string().min(1).max(2_048).optional().describe("next_cursor from the previous call"),
    },
    outputSchema: { turns: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().optional(), skipped: z.number().optional() },
    async handler(context, input) {
      if (input.thread !== undefined && input.task_id !== undefined) throw new ToolError("INVALID_REQUEST", "send thread or task_id, not both");
      const page = await adminOf(context).turns(given({
        since: input.since as string, until: input.until as string | undefined, project: input.project as string | undefined, origin: input.origin as "slack" | "ai_tool" | undefined,
        thread: input.thread as string | undefined, task: input.task_id as string | undefined, limit: input.limit as number | undefined, cursor: input.cursor as string | undefined,
      }));
      return {
        structured: given({ turns: page.turns, next_cursor: page.cursor, skipped: page.skipped }),
        text: `${page.turns.length} turn record${page.turns.length === 1 ? "" : "s"}.${page.cursor === undefined ? "" : " More remain: call again with cursor set to next_cursor."}`,
      };
    },
  },
  {
    name: "agentx_admin_usage",
    title: "Show AgentX usage",
    description: "Adds up AgentX usage per project, requester, origin or day: Slack turns, worker tasks, total task time, model input and output tokens, and cost in US dollars as the usage records carry it (a cost the provider did not give is counted in cost_unknown). since defaults to 7 days ago; AgentX keeps 30 days. Use it to see who and what is spending; then look at agentx_admin_turns or agentx_admin_list_workspaces for the detail.",
    inputSchema: {
      group_by: AdminUsageGroupBySchema.describe("project, requester, origin or day"),
      since: time.optional().describe("ISO time to start from; 7 days ago by default"),
      until: time.optional().describe("ISO time to stop at; now by default"),
    },
    outputSchema: {
      group_by: z.string(), since: z.string(), until: z.string(), truncated: z.boolean(),
      groups: z.array(z.object({ key: z.string(), turns: z.number(), tasks: z.number(), task_duration_ms: z.number(), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number(), cost_unknown: z.number() })),
      skipped: z.number().optional(),
    },
    async handler(context, input) {
      const usage = await adminOf(context).usage(given({ groupBy: input.group_by as AdminUsageGroupBy, since: input.since as string | undefined, until: input.until as string | undefined }));
      const groups = usage.groups.map((group) => ({ key: group.key, turns: group.turns, tasks: group.tasks, task_duration_ms: group.taskDurationMs, input_tokens: group.inputTokens, output_tokens: group.outputTokens, cost_usd: group.costUsd, cost_unknown: group.costUnknown }));
      const total = groups.reduce((sum, group) => sum + group.cost_usd, 0);
      // The route adds skipped (unreadable items) beside the contract's fields; the answer is loose.
      const skipped = typeof usage.skipped === "number" ? usage.skipped : undefined;
      return {
        structured: given({ group_by: usage.groupBy, since: usage.since, until: usage.until, truncated: usage.truncated, groups, skipped }),
        text: `${groups.length} group${groups.length === 1 ? "" : "s"} by ${usage.groupBy}, about $${total.toFixed(2)} in all${usage.truncated ? ", from the first 5,000 records of each kind" : ""}.`,
      };
    },
  },
  {
    name: "agentx_admin_list_projects",
    title: "List AgentX projects (admin)",
    description: "Lists every registered project an admin can see: its latest revision, when it was registered, its repositories, worker mode, connectors, and its policy for tasks from AI tools. Use it before changing a project, or to find why a developer cannot use one; then see its channels with agentx_admin_list_channels.",
    inputSchema: {},
    outputSchema: {
      projects: z.array(z.object({
        name: z.string(), latest_revision: z.number(), registered_at: z.string(), repositories: z.array(z.object({ name: z.string(), url: z.string() })),
        runtime_mode: z.string(), connectors: z.array(z.object({ name: z.string(), type: z.string() })),
        developer_tasks: z.object({ enabled: z.boolean(), share: z.string(), share_mode: z.object({ default: z.string(), allow_continue: z.boolean() }), channel_members_may_use: z.boolean() }),
      })),
    },
    async handler(context) {
      const { projects } = await adminOf(context).projects();
      return {
        structured: { projects: projects.map((project) => ({
          name: project.name, latest_revision: project.latestRevision, registered_at: project.registeredAt, repositories: project.repositories, runtime_mode: project.runtimeMode, connectors: project.connectors,
          developer_tasks: { enabled: project.developerTasks.enabled, share: project.developerTasks.share, share_mode: { default: project.developerTasks.shareMode.default, allow_continue: project.developerTasks.shareMode.allowContinue }, channel_members_may_use: project.developerTasks.channelMembersMayUse },
        })) },
        text: projects.length === 0 ? "No registered projects." : projects.map((project) => `${project.name} revision ${project.latestRevision}`).join(", "),
      };
    },
  },
  {
    name: "agentx_admin_list_channels",
    title: "List AgentX channel bindings",
    description: "Lists the Slack channels bound to projects: the channel's ID, its name when it is public or when your linked Slack user is a member of the private channel (otherwise a private channel is shown by ID only), the project, and when the binding last changed. Use it to find which channel a project answers in, or why a channel does not answer; then check the project with agentx_admin_list_projects.",
    inputSchema: {},
    outputSchema: { bindings: z.array(z.object({ channel_id: z.string(), channel_name: z.string().optional(), private: z.boolean().optional(), project: z.string(), updated_at: z.string() })), notices: z.array(z.string()) },
    async handler(context) {
      const answer = await adminOf(context).bindings();
      const bindings = answer.bindings.map((binding) => given({ channel_id: binding.channelId, channel_name: binding.channelName, private: binding.private, project: binding.projectName, updated_at: binding.updatedAt }));
      const note = answer.notices.includes("channel_names_unavailable") ? " Channel names could not be read, so channels are listed by ID." : "";
      return { structured: { bindings, notices: answer.notices }, text: `${bindings.length} bound channel${bindings.length === 1 ? "" : "s"}.${note}` };
    },
  },
  {
    name: "agentx_admin_list_credentials",
    title: "List AgentX connector credentials",
    description: "Lists connector credentials by reference, type and secret name, and when each was registered. It never shows a secret's value. Use it when a connector cannot reach its service; then check which projects use the connector with agentx_admin_list_projects.",
    inputSchema: {},
    // Keyed `references`, not `credentials`: FR-029's redactSecrets replaces any value under a
    // credential-named key, so a `credentials` list would always read [REDACTED].
    outputSchema: { references: z.array(z.object({ ref: z.string(), type: z.string(), secret_name: z.string(), registered_at: z.string().optional(), built_in: z.boolean().optional() })) },
    async handler(context) {
      const { credentials } = await adminOf(context).credentials();
      return {
        structured: { references: credentials.map((entry) => given({ ref: entry.ref, type: entry.type, secret_name: entry.secretName, registered_at: entry.registeredAt, built_in: entry.builtIn })) },
        // FR-029's redactText reads "credential: x" as a secret pair, so the colon follows "registered".
        text: credentials.length === 0 ? "No connector credentials registered." : `${credentials.length} connector credential${credentials.length === 1 ? "" : "s"} registered: ${credentials.map((entry) => `${entry.ref} (${entry.type})`).join(", ")}.`,
      };
    },
  },
  {
    name: "agentx_admin_list_workspaces",
    title: "List AgentX workspaces",
    description: "Lists workspaces, newest activity first: the ID, project, origin, owner (a Slack thread link, or the developer who started the task), status and last activity, with the current workspace limits and counts. Closed workspaces are left out unless status is CLOSED. A task's title and results stay private to its developer. Use it when a developer or the organization hits the workspace limit; then look at a workspace's turns with agentx_admin_turns.",
    inputSchema: {
      project: projectInput,
      status: WorkspaceStatusSchema.optional().describe("only workspaces with this status"),
      limit: limitInput(ADMIN_WORKSPACES_DEFAULT_LIMIT),
    },
    outputSchema: {
      workspaces: z.array(z.object({ id: z.string(), project: z.string(), origin: z.string(), owner: z.object({ thread_url: z.string().optional(), task_id: z.string().optional(), developer: z.string().optional() }), status: z.string(), busy: z.boolean(), last_activity_at: z.string() })),
      limits: z.object({ per_person: z.number(), per_organization: z.number(), source: z.string() }),
      counts: z.object({ organization: z.number(), developer_organization: z.number().optional() }),
      truncated: z.boolean(),
    },
    async handler(context, input) {
      const answer = await adminOf(context).workspaces(given({ project: input.project as string | undefined, status: input.status as string | undefined, limit: input.limit as number | undefined }));
      return {
        structured: {
          workspaces: answer.workspaces.map((workspace) => ({
            id: workspace.id, project: workspace.project, origin: workspace.origin,
            owner: given({ thread_url: workspace.owner.threadUrl, task_id: workspace.owner.taskId, developer: workspace.owner.developerName === undefined ? undefined : inertName(workspace.owner.developerName) }),
            status: workspace.status, busy: workspace.busy, last_activity_at: workspace.lastActivityAt,
          })),
          limits: { per_person: answer.limits.perPerson, per_organization: answer.limits.perOrganization, source: answer.limits.source },
          counts: given({ organization: answer.counts.organization, developer_organization: answer.counts.developerOrganization }),
          truncated: answer.truncated,
        },
        text: `${answer.workspaces.length} workspace${answer.workspaces.length === 1 ? "" : "s"}${answer.truncated ? " shown; more exist" : ""}. Limits: ${answer.limits.perPerson} per person, ${answer.limits.perOrganization} for the organization (${answer.limits.source === "setting" ? "set by an admin" : "install defaults"}).`,
      };
    },
  },
];
