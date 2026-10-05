// Spec 025 FR-030: the developer tools, written against ControlPlaneClient so the stdio server
// now and the hosted endpoint later use the same definitions (FR-027). Descriptions are written
// for the AI tool that reads them: when to use the tool, and what to do next.
import {
  DEFAULT_DEVELOPER_TASK_POLICY, DEVELOPER_EVENTS_DEFAULT, DEVELOPER_EVENTS_MAX, DEVELOPER_TASK_LIST_DEFAULT, DEVELOPER_TASK_LIST_MAX,
  DEVELOPER_WAIT_MAX_SECONDS, DeveloperInstructionsSchema, DeveloperTaskStatusSchema, SHARED_BY_POLICY, VIEW_ONLY_BY_POLICY, inertName, type DeveloperTaskView,
} from "@agentx/contracts";
import { z } from "zod";
import type { AdminControlPlaneClient } from "./admin-client.js";
import type { ControlPlaneClient } from "./client.js";
import { isExpiredNotice } from "./admin-expiry.js";
import { adminApiFits, type Compatibility } from "./compatibility.js";
import { ToolError, plainText } from "./errors.js";
import type { RequestIdMemory } from "./request-ids.js";
import { waitForTask } from "./wait.js";

export interface ToolContext {
  client: ControlPlaneClient;
  clientName: string | undefined;
  serverVersion: string;
  /** Owner decision 7: this computer holds an unexpired admin sign-in for the environment. */
  adminSignedIn(): Promise<boolean>;
  /**
   * Issue #218: a sentence saying the stored admin sign-in expired (when, and the command), or
   * expires within a few minutes; undefined otherwise, or when the server cannot tell.
   */
  adminSignInNotice?(): Promise<string | undefined>;
  compatibility(): Promise<Compatibility>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  newRequestId(): string;
  /** Spec 025 A14: the admin sign-in's client; absent when the server has none. */
  admin?: AdminControlPlaneClient;
  /** Spec 025 FR-051: the MCP client's own version, as it reported it. */
  clientVersion?: string;
  /**
   * Spec 025 FR-041: the confirmation methods the environment allows and the signed-in admin can
   * use (Slack needs their Slack link). The server adds the client's own: the pop-up needs a
   * client that declared form elicitation. Absent, no change can be confirmed.
   */
  confirmation?(): Promise<{ elicitation: boolean; slack: boolean }>;
}
export interface ToolCall {
  signal: AbortSignal;
  progress?(progress: number, total: number | undefined, message: string): Promise<void>;
  /** The server's memory of request IDs made for calls that left request_id out. */
  requestIds?: RequestIdMemory;
  log?(entry: Record<string, unknown>): void;
  /**
   * Spec 025 FR-041: the client's own pop-up, asking yes or no; absent when the client declared no
   * form elicitation. "failed" when it could not be shown or answered in time.
   */
  elicit?(message: string, timeoutMs: number, signal: AbortSignal): Promise<"accept" | "decline" | "cancel" | "failed">;
}
export interface ToolResult { structured: Record<string, unknown>; text: string }
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler(context: ToolContext, input: Record<string, unknown>, call: ToolCall): Promise<ToolResult>;
}

const taskIdInput = z.string().min(1).max(100).describe("the task ID that agentx_start_task or agentx_list_tasks gave");
const requestIdInput = z.string().uuid().optional().describe("a UUID of your choosing; send the same one again to retry this call safely. When left out, an identical call within 15 minutes counts as a retry of the first");
const waitInput = (min: number) => z.number().int().min(min).max(DEVELOPER_WAIT_MAX_SECONDS);
const eventsInput = z.number().int().min(0).max(DEVELOPER_EVENTS_MAX).optional().describe("how many recent progress events to show, 0 to 50; 10 by default");
const instructionsInput = z.string().min(1).describe("complete instructions for the remote worker, at most 65,536 bytes; it gets them exactly as written and cannot see this conversation");

const TaskShape = {
  task_id: z.string(), title: z.string(), project: z.string(), status: DeveloperTaskStatusSchema,
  failure: z.object({ category: z.string(), stage: z.string().optional(), message: z.string() }).optional(),
  starting_revision: z.number(), client: z.string(), shared: z.boolean(), share_mode: z.string().nullable(),
  share_reason: z.string().optional(), share_mode_reason: z.string().optional(),
  channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  thread_url: z.string().optional(), share_posting: z.boolean().optional(), share_post_failed: z.boolean().optional(),
  channel_turns: z.array(z.object({ author: z.string(), slack_user: z.string(), at: z.string(), request: z.string(), outcome: z.string() })).optional(),
  closing: z.boolean().optional(), created_at: z.string(), updated_at: z.string().describe("when the latest request on this task started; share changes do not move it"),
  events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() })),
  summary: z.string().optional(),
  changed_files: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number(), removed: z.number() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().optional() })).optional(),
  pull_requests: z.array(z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() })).optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  workflow: z.object({ stage: z.string(), state: z.string(), revision: z.number(), block_reason: z.string().optional(), plan: z.object({ sha256: z.string(), version: z.number(), content: z.string().optional() }).optional() }).optional(),
  /** Only on start, continue and wait, which may wait (R21). */
  timed_out: z.boolean().optional(),
  /** A wait that stopped early because checking on the task failed; not a timeout. */
  wait_failed: z.object({ code: z.string(), message: z.string() }).optional(),
};
/** Start and continue also say which request ID reached AgentX, for a retry. */
const ActionShape = { ...TaskShape, request_id: z.string() };
const RETRY = "If the call fails or times out, send your own request_id, or repeat the call unchanged: an identical call within 15 minutes is taken as the same request";

/** The one place a wire view (camelCase) becomes a tool output (snake_case). */
function taskOutput(task: DeveloperTaskView, timedOut?: boolean): Record<string, unknown> {
  return {
    task_id: task.taskId, title: task.title, project: task.project, status: task.status,
    ...(task.failure === undefined ? {} : { failure: task.failure }),
    starting_revision: task.startingRevision, client: task.client,
    shared: task.shared, share_mode: task.share?.mode ?? null,
    // C6, C21: why the policy changed what was asked, the channel (a private one by ID only, R10),
    // and the thread link once the notifier has posted it (Q6: never on the start's own answer).
    ...(task.share === undefined ? {} : {
      ...(task.share.sharedReason === "required" ? { share_reason: SHARED_BY_POLICY } : {}),
      ...(task.share.modeReason === "continue_not_allowed" ? { share_mode_reason: VIEW_ONLY_BY_POLICY } : {}),
      channel: { id: task.share.channelId, ...(task.share.channelName === undefined ? {} : { name: task.share.channelName }) },
      ...(task.share.threadUrl !== undefined ? { thread_url: task.share.threadUrl } : task.share.postFailed === true ? { share_post_failed: true } : { share_posting: true }),
    }),
    ...(task.channelTurns === undefined ? {} : {
      // Final review M7: a teammate's display name is marked inert, as TASK_BUSY marks it.
      channel_turns: task.channelTurns.map((turn) => ({ author: turn.author.name === undefined ? turn.author.slackUserId : inertName(turn.author.name), slack_user: turn.author.slackUserId, at: turn.at, request: turn.request, outcome: turn.outcome })),
    }),
    ...(task.closing === true ? { closing: true } : {}),
    created_at: task.createdAt, updated_at: task.updatedAt, events: task.events,
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    ...(task.changedFiles === undefined ? {} : { changed_files: task.changedFiles }),
    ...(task.artifacts === undefined ? {} : { artifacts: task.artifacts }),
    ...(task.pullRequests === undefined ? {} : { pull_requests: task.pullRequests }),
    ...(task.unpublished === undefined ? {} : { unpublished: task.unpublished }),
    ...(task.workflow === undefined ? {} : {
      workflow: {
        stage: task.workflow.stage, state: task.workflow.state, revision: task.workflow.revision,
        ...(task.workflow.blockReason === undefined ? {} : { block_reason: task.workflow.blockReason }),
        ...(task.workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1) === undefined ? {} : {
          plan: { sha256: task.workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!.sha256, version: task.workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!.version, ...(task.workflow.planContent === undefined ? {} : { content: task.workflow.planContent }) },
        }),
      },
    }),
    ...(timedOut === undefined ? {} : { timed_out: timedOut }),
  };
}

/** What the AI tool can do next with a task in this state. */
function nextFor(task: DeveloperTaskView): string {
  if (task.workflow?.state === "WAITING" && task.workflow.stage === "PLAN_REVIEW") {
    return "Review the attached plan, then use agentx_decide_workflow with its exact plan sha256 and expected revision before any code implementation starts.";
  }
  if (task.workflow?.state === "BLOCKED" && task.workflow.stage === "PLAN") return `The plan run was interrupted or could not save its plan. To recover, use agentx_retry_workflow to start another read-only planning run.`;
  if (task.workflow?.state === "BLOCKED") return `The workflow is blocked: ${task.workflow.blockReason ?? "required evidence is missing"}. Review it before continuing.`;
  if (task.closing === true) return "It is closing: check with agentx_get_task, which shows CLOSED when done.";
  switch (task.status) {
    case "STARTING":
    case "RUNNING":
      return "Check it with agentx_get_task, or wait with agentx_wait_for_task.";
    case "SUCCEEDED":
      return "Read the summary and changed files, then open a pull request with agentx_open_pull_request, send more work with agentx_continue_task, or close it with agentx_close_task.";
    case "CLOSED":
      return "Its workspace is released.";
    default:
      // #154: a failure during setup (setup_failed, or compute lost before setup finished) leaves
      // nothing to continue. #213: its workspace was released when setup failed.
      return task.failure?.category === "setup_failed" || task.failure?.stage === "setup"
        ? "It never started, and its workspace was released, so it no longer counts toward your workspace limit. Start a new task with agentx_start_task, and close this one with agentx_close_task."
        : "Send new instructions with agentx_continue_task, or close it with agentx_close_task.";
  }
}

/** C6, C21: where the task is shared, and why the policy changed what was asked. */
function shareText(task: DeveloperTaskView): string {
  const share = task.share;
  if (share === undefined) return "";
  // R10: AgentX sends a channel's name only when the developer may see it.
  const where = share.channelName === undefined ? `channel ${share.channelId}` : `#${share.channelName}`;
  const mode = share.mode === "view" ? "view only" : "open to the channel";
  const why = [
    ...(share.sharedReason === "required" ? [`shared because it is ${SHARED_BY_POLICY}`] : []),
    ...(share.modeReason === "continue_not_allowed" ? [`view only because ${VIEW_ONLY_BY_POLICY}`] : []),
  ];
  const thread = share.threadUrl !== undefined
    ? ` Thread: ${share.threadUrl}.`
    : share.postFailed === true ? " AgentX could not post the thread in Slack." : " The Slack thread link appears in agentx_get_task within a few seconds.";
  return ` Shared in ${where}, ${mode}${why.length === 0 ? "" : ` (${why.join("; ")})`}.${thread}`;
}

function taskText(task: DeveloperTaskView, timedOut?: boolean): string {
  const failure = task.failure === undefined ? "" : ` (${task.failure.category}: ${task.failure.message})`;
  const waited = timedOut === true ? " The wait ended first; the task keeps running." : "";
  const summary = task.summary === undefined ? "" : ` Summary: ${task.summary}`;
  return `Task ${task.taskId} "${task.title}" on ${task.project} is ${task.status}${failure}.${waited}${shareText(task)} ${nextFor(task)}${summary}`;
}

function instructions(value: unknown): string {
  const parsed = DeveloperInstructionsSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("INVALID_REQUEST", `instructions: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/**
 * The caller's request_id, else one remembered for this call's content for 15 minutes, so an
 * unchanged retry (after the AI tool's own timeout, say) reaches AgentX as the same request.
 */
export function requestIdFor(context: ToolContext, call: ToolCall, input: Record<string, unknown>, content: readonly unknown[], group?: string): string {
  const given = input.request_id as string | undefined;
  if (given !== undefined) return given;
  return call.requestIds === undefined ? context.newRequestId() : call.requestIds.idFor(content, context.now(), () => context.newRequestId(), group);
}
const optional = (value: unknown) => value ?? null;
/** Issue 196: the statuses a cancel answers with only when the task had already finished. */
const ALREADY_FINISHED: ReadonlySet<DeveloperTaskView["status"]> = new Set(["SUCCEEDED", "FAILED"]);
/** What makes a cancel the same cancel: the tool and its task (final review M3). */
const cancelContent = (taskId: unknown): readonly unknown[] => ["agentx_cancel_task", taskId];
/** What makes a share the same share: the task, the mode asked for and the channel named. */
const shareContent = (taskId: unknown, mode: unknown, channel: unknown): readonly unknown[] => ["agentx_share_task", taskId, optional(mode), optional(channel)];
/** Every share of one task, forgotten together after a share succeeds (final review M1). */
const shareGroup = (taskId: string): string => `agentx_share_task:${taskId}`;
const eventsOf = (input: Record<string, unknown>) => (input.events as number | undefined) ?? DEVELOPER_EVENTS_DEFAULT;

/**
 * A wait's answer. A failed read during the wait still answers with the last view seen, marked
 * as a failed check rather than a timeout: after a start or continue, an error would make the AI
 * tool send the action again.
 */
async function waitResult(context: ToolContext, call: ToolCall, tool: string, taskId: string, waitSeconds: number, events: number, first?: DeveloperTaskView): Promise<ToolResult> {
  const waited = await waitForTask({
    client: context.client, taskId, waitSeconds, events, signal: call.signal, now: () => context.now(), sleep: (ms, signal) => context.sleep(ms, signal),
    ...(first === undefined ? {} : { first }),
    ...(call.progress === undefined ? {} : { progress: (elapsed: number, total: number, message: string) => call.progress!(elapsed, total, message) }),
  });
  if (waited.failure === undefined) return { structured: taskOutput(waited.task, waited.timedOut), text: taskText(waited.task, waited.timedOut) };
  const failure = waited.failure instanceof ToolError ? waited.failure : new ToolError("CONTROL_PLANE_UNAVAILABLE", "an unexpected problem");
  call.log?.({ event: "tool.wait_failed", tool, code: failure.code });
  const task = waited.task;
  return {
    structured: { ...taskOutput(task, false), wait_failed: { code: failure.code, message: failure.message } },
    text: `Task ${task.taskId} "${task.title}" on ${task.project} was ${task.status} when the wait stopped early, because checking on it failed: ${failure.message}. This is not a timeout, and the task keeps running; check it with agentx_get_task.`,
  };
}

/** The optional wait after a start or continue, from the view the action returned. */
async function afterAction(context: ToolContext, call: ToolCall, tool: string, task: DeveloperTaskView, waitSeconds: number, requestId: string): Promise<ToolResult> {
  const result = waitSeconds === 0 ? { structured: taskOutput(task), text: taskText(task) } : await waitResult(context, call, tool, task.taskId, waitSeconds, DEVELOPER_EVENTS_DEFAULT, task);
  return { structured: { ...result.structured, request_id: requestId }, text: result.text };
}

/** Whoami's sentence on the admin sign-in: held or not, with #218's expiry notice when there is one. */
function adminSentence(admin: boolean, notice: string | undefined): string {
  // Only the expired notice replaces "holds no": one about to expire raced the held check.
  if (!admin) return notice !== undefined && isExpiredNotice(notice) ? notice : "This computer holds no admin sign-in.";
  return `This computer also holds an unexpired admin sign-in.${notice === undefined ? "" : ` ${notice}`}`;
}

export const DEVELOPER_TOOLS: readonly ToolDefinition[] = [
  {
    name: "agentx_whoami",
    title: "Who am I in AgentX",
    description:
      "Shows which AgentX environment this computer is signed in to and as whom: your name, how you signed in, your linked Slack user, whether this computer also holds an unexpired admin sign-in, and the server and AgentX API versions, with a notice when a newer AgentX CLI is available. Use it to check the setup, or when another AgentX tool says to sign in or upgrade.",
    inputSchema: {},
    outputSchema: {
      environment: z.string(), developer_name: z.string(), sign_in_method: z.string(), slack_user: z.string().optional(), admin: z.boolean(),
      server_version: z.string(), control_plane_api_version: z.string(), upgrade_notice: z.string().optional(),
    },
    async handler(context) {
      const [compatibility, projects, admin, notice] = await Promise.all([context.compatibility(), context.client.projects(), context.adminSignedIn(), context.adminSignInNotice?.()]);
      const { developer } = projects;
      const method = developer.provider === "slack" ? "Slack" : "your company sign-in";
      return {
        structured: {
          environment: compatibility.env, developer_name: developer.name, sign_in_method: developer.provider,
          ...(developer.slackUserId === undefined ? {} : { slack_user: developer.slackUserId }), admin,
          server_version: context.serverVersion, control_plane_api_version: compatibility.apiVersion,
          ...(compatibility.notice === undefined ? {} : { upgrade_notice: compatibility.notice }),
        },
        // Spec 025 A1: an admin whose AgentX lacks a fitting admin API learns why no admin tool shows.
        // Issue #218: an expired admin sign-in says so and when, never "holds no"; one about to expire says when.
        text: `Signed in to AgentX ${compatibility.env} as ${developer.name} with ${method}. ${adminSentence(admin, notice)}${compatibility.notice === undefined ? "" : ` Note: ${compatibility.notice}.`}${admin && adminApiFits(compatibility.adminApiVersion) !== "fits" ? " AgentX has no admin tools yet; ask your AgentX admin to upgrade AgentX." : ""}`,
      };
    },
  },
  {
    name: "agentx_list_projects",
    title: "List AgentX projects",
    description:
      "Lists the AgentX projects you can hand coding tasks to, with each project's Slack channels and task policy. Use it before agentx_start_task to get a project's exact name. A project with tasks_enabled false cannot take tasks from an AI tool; use its Slack channel instead. With share_policy required, every task is shared to the project's channel.",
    inputSchema: {},
    outputSchema: {
      projects: z.array(z.object({
        name: z.string(), access: z.string(),
        bound_channels: z.array(z.object({ id: z.string(), name: z.string().optional(), private: z.boolean().optional() })),
        tasks_enabled: z.boolean(), share_policy: z.string(), share_mode_policy: z.object({ default: z.string(), allow_continue: z.boolean() }),
      })),
      notices: z.array(z.string()),
    },
    async handler(context) {
      const response = await context.client.projects();
      const projects = response.projects.map((project) => {
        // R28: there is no project description. A project without a policy is closed to tasks,
        // as the broker's fail-closed policy treats it.
        const policy = project.tasks ?? { ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false };
        return {
          name: project.name, access: project.access,
          bound_channels: project.channels.map((channel) => ({ id: channel.channelId, ...(channel.name === undefined ? {} : { name: channel.name }), ...(channel.isPrivate === undefined ? {} : { private: channel.isPrivate }) })),
          tasks_enabled: policy.enabled,
          share_policy: policy.share,
          share_mode_policy: { default: policy.shareMode.default, allow_continue: policy.shareMode.allowContinue },
        };
      });
      const notice = response.notices.includes("slack_unavailable") ? " Slack could not be reached, so projects you use through a Slack channel may be missing; try again in a few minutes." : "";
      const list = projects.length === 0 ? "You cannot use any AgentX project yet: join a project's Slack channel, or ask an AgentX admin for access." : `You can use: ${projects.map((project) => project.name).join(", ")}.`;
      return { structured: { projects, notices: response.notices }, text: `${list}${notice}` };
    },
  },
  {
    name: "agentx_start_task",
    title: "Hand a coding task to AgentX",
    description:
      `Hands a coding task to AgentX, which runs it in a private remote workspace on the project's repositories. The task is private to you unless you share it, or the project requires sharing. Write complete instructions: the remote worker gets them exactly as written and cannot see this conversation. By default it answers at once with a task ID while the task runs; then check it with agentx_get_task or wait with agentx_wait_for_task. To wait for a small task in the same call, set wait_seconds (up to 600); if the wait ends first, the result says timed_out and the task keeps running. ${RETRY}, so no second task starts; to run the same instructions again as new work, send a new request_id. When the task ends, open a pull request with agentx_open_pull_request or send more work with agentx_continue_task, and close it with agentx_close_task when done, since each open task counts against your limit.`,
    inputSchema: {
      project: z.string().min(1).max(200).describe("the project's exact name, from agentx_list_projects"),
      instructions: instructionsInput,
      title: z.string().max(120).optional().describe("a short title, at most 120 characters; the first line of the instructions when left out"),
      share_to_channel: z.boolean().optional().describe("post the task in the project's Slack channel, where AgentX replies as it runs; false by default"),
      share_mode: z.enum(["view", "continue"]).optional().describe("view (the channel watches) or continue (channel members may mention AgentX in the thread to steer the task); the project's default when left out, and view when the project does not allow continue"),
      channel: z.string().min(1).max(80).optional().describe("which bound channel to share in, by name or ID; needed only when the project has several"),
      wait_seconds: waitInput(0).optional().describe("seconds to wait for the task to end, 0 to 600; 0 (answer at once) by default"),
      request_id: requestIdInput,
    },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const text = instructions(input.instructions);
      // Everything but wait_seconds: a retry with another wait is still the same start.
      const id = requestIdFor(context, call, input, ["agentx_start_task", input.project, text, optional(input.title), optional(input.share_to_channel), optional(input.share_mode), optional(input.channel)]);
      const task = await context.client.startTask({
        requestId: id,
        project: input.project as string,
        instructions: text,
        ...(input.title === undefined ? {} : { title: input.title as string }),
        // R25: sent as it came; the broker maps it to one of four fixed names.
        ...(context.clientName === undefined ? {} : { client: context.clientName.slice(0, 200) }),
        ...(input.share_to_channel === undefined ? {} : { shareToChannel: input.share_to_channel as boolean }),
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      return afterAction(context, call, "agentx_start_task", task, (input.wait_seconds as number | undefined) ?? 0, id);
    },
  },
  {
    name: "agentx_start_workflow",
    title: "Start a human-gated AgentX delivery workflow",
    description: "Starts a native AgentX task-to-PR workflow. AgentX first inspects the request with read-only tools and saves a plan. The task owner reviews the complete plan and approves its exact digest and workflow revision with agentx_decide_workflow before implementation. Interrupted planning can be retried with agentx_retry_workflow. After implementation, AgentX blocks before PR publication until candidate-bound verification and review are qualified. Use agentx_start_task for the existing task flow.",
    inputSchema: {
      project: z.string().min(1).max(200).describe("the project's exact name, from agentx_list_projects"),
      instructions: instructionsInput,
      title: z.string().max(120).optional(),
      share_to_channel: z.boolean().optional(),
      share_mode: z.enum(["view", "continue"]).optional(),
      channel: z.string().min(1).max(80).optional(),
      wait_seconds: waitInput(0).optional(),
      request_id: requestIdInput,
    },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const text = instructions(input.instructions);
      const id = requestIdFor(context, call, input, ["agentx_start_workflow", input.project, text, optional(input.title), optional(input.share_to_channel), optional(input.share_mode), optional(input.channel)]);
      const task = await context.client.startTask({
        requestId: id, project: input.project as string, instructions: text, workflow: true,
        ...(input.title === undefined ? {} : { title: input.title as string }),
        ...(context.clientName === undefined ? {} : { client: context.clientName.slice(0, 200) }),
        ...(input.share_to_channel === undefined ? {} : { shareToChannel: input.share_to_channel as boolean }),
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      return afterAction(context, call, "agentx_start_workflow", task, (input.wait_seconds as number | undefined) ?? 0, id);
    },
  },
  {
    name: "agentx_get_task",
    title: "Check an AgentX task",
    description:
      "Shows one of your tasks, its latest progress, and any native workflow stage. For an agentx_start_workflow task, it includes the complete current plan, its sha256 digest and workflow revision while the owner review gate is open. After work ends it shows the worker's summary, changed files, artifacts and any pull requests. For a shared task it shows the channel, sharing mode, thread link and channel turns.",
    inputSchema: { task_id: taskIdInput, events: eventsInput },
    outputSchema: TaskShape,
    async handler(context, input) {
      const task = await context.client.getTask(input.task_id as string, eventsOf(input));
      return { structured: taskOutput(task), text: taskText(task) };
    },
  },
  {
    name: "agentx_wait_for_task",
    title: "Wait for an AgentX task",
    description:
      "Waits up to wait_seconds (1 to 600) for one of your tasks to end, sending progress while it waits, then shows the task as agentx_get_task does. If the task is still running when the wait ends, that is not an error: the result says timed_out and the task keeps running, so wait again or check later with agentx_get_task. Cancelling this call stops only the wait, never the task. Use agentx_get_task, not this tool, to follow a pull request or a close.",
    inputSchema: { task_id: taskIdInput, wait_seconds: waitInput(1).describe("seconds to wait for the task to end, 1 to 600"), events: eventsInput },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      return waitResult(context, call, "agentx_wait_for_task", input.task_id as string, input.wait_seconds as number, eventsOf(input));
    },
  },
  {
    name: "agentx_list_tasks",
    title: "List my AgentX tasks",
    description:
      "Lists the tasks you started from AI tools, newest first, with each task's ID, title, project, status and times. Use it to find a task ID, or to find open tasks you no longer need and can close with agentx_close_task. Filter by project or status; limit is 1 to 50, 20 by default.",
    inputSchema: {
      project: z.string().max(200).optional().describe("only this project's tasks"),
      status: DeveloperTaskStatusSchema.optional().describe("only tasks with this status"),
      limit: z.number().int().min(1).max(DEVELOPER_TASK_LIST_MAX).optional().describe("how many tasks to show, 1 to 50; 20 by default"),
    },
    outputSchema: { tasks: z.array(z.object({ task_id: z.string(), title: z.string(), project: z.string(), status: z.string(), created_at: z.string(), updated_at: z.string().describe("when the latest request on this task started; share changes do not move it"), shared: z.boolean() })) },
    async handler(context, input) {
      const tasks = await context.client.listTasks({
        limit: (input.limit as number | undefined) ?? DEVELOPER_TASK_LIST_DEFAULT,
        ...(input.project === undefined ? {} : { project: input.project as string }),
        ...(input.status === undefined ? {} : { status: input.status as DeveloperTaskView["status"] }),
      });
      return {
        structured: { tasks: tasks.map((task) => ({ task_id: task.taskId, title: task.title, project: task.project, status: task.status, created_at: task.createdAt, updated_at: task.updatedAt, shared: task.shared })) },
        text: tasks.length === 0 ? "You have no AgentX tasks that match." : tasks.map((task) => `${task.taskId} ${task.status} ${task.project}: ${task.title}`).join("\n"),
      };
    },
  },
  {
    name: "agentx_continue_task",
    title: "Continue an AgentX task",
    description:
      `Sends more instructions to one of your tasks once it has ended. They run in the same workspace, on the same branch, exactly as written, so write them in full. Answers like agentx_start_task: at once by default, or after waiting up to wait_seconds (up to 600). A task that is still running answers TASK_BUSY: wait for it with agentx_wait_for_task first. A task whose setup failed cannot be continued: close it and start a new one. ${RETRY}, so the instructions run once; to run the same instructions again, send a new request_id.`,
    inputSchema: {
      task_id: taskIdInput,
      instructions: instructionsInput,
      wait_seconds: waitInput(0).optional().describe("seconds to wait for the task to end, 0 to 600; 0 (answer at once) by default"),
      request_id: requestIdInput,
    },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const text = instructions(input.instructions);
      const id = requestIdFor(context, call, input, ["agentx_continue_task", input.task_id, text]);
      const task = await context.client.continueTask(input.task_id as string, { requestId: id, instructions: text });
      // A new turn runs: a cancel after it must stop it, not repeat the cancel before it.
      call.requestIds?.forget(cancelContent(input.task_id));
      return afterAction(context, call, "agentx_continue_task", task, (input.wait_seconds as number | undefined) ?? 0, id);
    },
  },
  {
    name: "agentx_decide_workflow",
    title: "Approve or respond to an AgentX plan",
    description: "Records your decision on the current plan. APPROVE starts implementation only when the exact plan sha256 and workflow revision match. REQUEST_CHANGES asks AgentX to replace the plan without editing files. REJECT closes this workflow. SKIP is refused unless the project explicitly allows it. Use the plan digest and revision shown by agentx_get_task.",
    inputSchema: {
      task_id: taskIdInput,
      request_id: z.string().uuid().describe("UUID for safe retry; repeat the same request unchanged if the call times out"),
      expected_revision: z.number().int().positive(),
      decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]),
      reason: z.string().trim().min(1).max(500),
      artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
    },
    outputSchema: ActionShape,
    async handler(context, input) {
      const task = await context.client.decideWorkflowTask(input.task_id as string, {
        requestId: input.request_id as string,
        expectedRevision: input.expected_revision as number,
        decision: input.decision as "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "SKIP",
        reason: input.reason as string,
        ...(input.artifact_digest === undefined ? {} : { artifactDigest: input.artifact_digest as string }),
      });
      return { structured: { ...taskOutput(task), request_id: input.request_id }, text: `${taskText(task)} ${nextFor(task)}` };
    },
  },
  {
    name: "agentx_review_workflow_candidate",
    title: "Run independent code and security reviews",
    description: "Starts a separate read-only review operation after checks pass. It reviews the current candidate and cannot edit it. Use only when agentx_get_task shows stage REVIEW and state WAITING.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput, instructions: instructionsInput },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const instructions = input.instructions as string;
      const id = requestIdFor(context, call, input, ["agentx_review_workflow_candidate", input.task_id, instructions]);
      const task = await context.client.startWorkflowReviewTask(input.task_id as string, { requestId: id, instructions });
      return afterAction(context, call, "agentx_review_workflow_candidate", task, 0, id);
    },
  },
  {
    name: "agentx_retry_workflow",
    title: "Retry a blocked AgentX plan",
    description: "Restarts a blocked planning stage using the instructions you provide. AgentX keeps this run read-only. Use it after agentx_get_task shows a blocked PLAN stage; the operation starts again only if the workspace is ready.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput, instructions: instructionsInput },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const instructions = input.instructions as string;
      const id = requestIdFor(context, call, input, ["agentx_retry_workflow", input.task_id, instructions]);
      const task = await context.client.retryWorkflowTask(input.task_id as string, { requestId: id, instructions });
      return afterAction(context, call, "agentx_retry_workflow", task, 0, id);
    },
  },
  {
    name: "agentx_cancel_task",
    title: "Cancel an AgentX task",
    description:
      "Stops the work one of your tasks is running now, and shows its status after the request. The workspace and its changes stay, so you can still continue the task, open a pull request, or close it with agentx_close_task. Cancelling a task that is not running changes nothing.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      // The remembered ID when left out (final review M3), as start and continue do: an AI tool's
      // retry reaches AgentX as the same cancel. A second cancel within 15 minutes is a no-op.
      const task = await context.client.cancelTask(input.task_id as string, requestIdFor(context, call, input, cancelContent(input.task_id)));
      // Issue 196: a task that had already finished keeps its result; say so plainly. CANCELLED is
      // left out (a task stopped before its instructions ran reads CANCELLED at once), and so is
      // INTERRUPTED (a queued cancel that failed ends so, and a retried cancel may read it).
      const finished = ALREADY_FINISHED.has(task.status) ? `The task had already finished as ${task.status}, so nothing was cancelled. ` : "";
      return { structured: taskOutput(task), text: `${finished}${taskText(task)}` };
    },
  },
  {
    name: "agentx_close_task",
    title: "Close an AgentX task",
    description:
      "Closes one of your tasks and releases its workspace, so it stops counting against your limit of open tasks. AgentX first checks the workspace for work that is not in a pull request, and does not close a task that has some. Answers at once while the close runs: check the outcome with agentx_get_task, which shows status CLOSED when done, or unpublished listing each repository and why. To keep unpublished work, open a pull request with agentx_open_pull_request first; to drop it, continue the task with instructions to discard the changes, then close it again.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput },
    outputSchema: { ...TaskShape, closed: z.boolean() },
    async handler(context, input) {
      const taskId = input.task_id as string;
      // R22: no wait. A repeated request_id returns the same close and its outcome.
      // A fresh ID when left out: closing again after publishing is a new request, and a repeat
      // on a closing task returns that close (Task 12).
      const answer = await context.client.closeTask(taskId, (input.request_id as string | undefined) ?? context.newRequestId());
      const unpublished = answer.unpublished ?? answer.task.unpublished;
      const task = unpublished === undefined ? answer.task : { ...answer.task, unpublished };
      // AgentX's own words, when it gives them, say why the task is not closed yet and what next.
      const text = answer.closed
        ? `Task ${taskId} is closed; its workspace is released.`
        : answer.message !== undefined
          ? `Task ${taskId}: ${plainText(answer.message, "AgentX has not closed it yet; check with agentx_get_task")}`
          : unpublished !== undefined
            ? `Task ${taskId} was not closed: unpublished work in ${unpublished.map((entry) => `${entry.repository} (${entry.reasons.join(", ")})`).join("; ")}. Open a pull request with agentx_open_pull_request first, or continue the task with instructions to discard the changes, then close it again.`
            : `Closing task ${taskId}: AgentX is checking the workspace for unpublished work. Check with agentx_get_task; it shows CLOSED when done.`;
      return { structured: { ...taskOutput(task), closed: answer.closed }, text };
    },
  },
  {
    name: "agentx_share_task",
    title: "Share an AgentX task to its Slack channel",
    description:
      `Shares one of your tasks to its project's Slack channel, or changes how a shared task is shared. view lets the channel watch while you drive the task from here; continue also lets channel members mention AgentX in the thread to steer it, one request at a time. On a shared task it changes the mode, within the project's policy; the channel cannot change. Answers at once: AgentX posts the thread within seconds, and agentx_get_task then shows its link. Switching to view makes channel messages that are still waiting get a notice instead of running. ${RETRY}.`,
    inputSchema: {
      task_id: taskIdInput,
      share_mode: z.enum(["view", "continue"]).optional().describe("view or continue; for a new share, the project's default when left out"),
      channel: z.string().min(1).max(80).optional().describe("which bound channel, by name or ID; needed only when the project has several"),
      request_id: requestIdInput,
    },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const taskId = input.task_id as string;
      const content = shareContent(taskId, input.share_mode, input.channel);
      const id = requestIdFor(context, call, input, content, shareGroup(taskId));
      const task = await context.client.shareTask(taskId, {
        requestId: id,
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      // The share changed: a later call asking for an earlier mode is a new change, not a retry of
      // the earlier call, whose stored answer would leave the thread in this mode (as cancel after
      // continue). Every other share of this task is forgotten, however it spelled the channel;
      // only this call's own retry still reaches AgentX as the same request.
      call.requestIds?.forgetGroup(shareGroup(taskId), content);
      return { structured: { ...taskOutput(task), request_id: id }, text: taskText(task) };
    },
  },
  {
    name: "agentx_open_pull_request",
    title: "Open a pull request from an AgentX task",
    description:
      `Opens a pull request with one of your task's changes, through AgentX's GitHub App, as a draft unless draft is false. Use it once the task has ended and you have read its summary and changed files. Answers at once with the publish operation's ID and status (ACCEPTED when just started): check with agentx_get_task, whose pull_requests lists the URL once it is published. ${RETRY}, so it gives the same operation, never a second pull request. repository is needed only when the project has several repositories.`,
    inputSchema: {
      task_id: taskIdInput,
      title: z.string().min(1).max(256).describe("the pull request's title"),
      body: z.string().optional().describe("the pull request's description, in Markdown; AgentX adds a line saying who asked for it"),
      repository: z.string().max(63).optional().describe("the repository's name in the project; needed only when the project has several"),
      draft: z.boolean().optional().describe("open it as a draft; true by default"),
      request_id: requestIdInput,
    },
    outputSchema: {
      operation_id: z.string(), operation_status: z.string(),
      pull_request: z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() }).optional(),
      task: z.object(TaskShape),
      request_id: z.string(),
    },
    async handler(context, input, call) {
      const taskId = input.task_id as string;
      const draft = (input.draft as boolean | undefined) ?? true;
      const id = requestIdFor(context, call, input, ["agentx_open_pull_request", taskId, input.title, optional(input.body), optional(input.repository), draft]);
      // R22: no wait. A repeated request_id returns the same operation, with the URL once published.
      const answer = await context.client.openPullRequest(taskId, {
        requestId: id,
        title: input.title as string,
        draft,
        ...(input.body === undefined ? {} : { body: input.body as string }),
        ...(input.repository === undefined ? {} : { repository: input.repository as string }),
      });
      return {
        structured: {
          operation_id: answer.operationId, operation_status: answer.operationStatus,
          ...(answer.pullRequest === undefined ? {} : { pull_request: answer.pullRequest }),
          task: taskOutput(answer.task),
          request_id: id,
        },
        text: answer.pullRequest !== undefined
          ? `The pull request for task ${taskId} is ${answer.pullRequest.url} (${answer.pullRequest.state}).`
          : `Opening a pull request for task ${taskId} (operation ${answer.operationId}, ${answer.operationStatus}). Check with agentx_get_task; its URL appears there once it is published.`,
      };
    },
  },
];
