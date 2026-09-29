// Spec 025 FR-030: the developer tools, written against ControlPlaneClient so the stdio server
// now and the hosted endpoint later use the same definitions (FR-027). Descriptions are written
// for the AI tool that reads them: when to use the tool, and what to do next.
import {
  DEFAULT_DEVELOPER_TASK_POLICY, DEVELOPER_EVENTS_DEFAULT, DEVELOPER_EVENTS_MAX, DEVELOPER_TASK_LIST_DEFAULT, DEVELOPER_TASK_LIST_MAX,
  DEVELOPER_WAIT_MAX_SECONDS, DeveloperInstructionsSchema, DeveloperTaskStatusSchema, SHARED_BY_POLICY, VIEW_ONLY_BY_POLICY, inertName, type DeveloperTaskView,
} from "@agentx/contracts";
import { z } from "zod";
import type { ControlPlaneClient } from "./client.js";
import type { Compatibility } from "./compatibility.js";
import { ToolError, plainText } from "./errors.js";
import type { RequestIdMemory } from "./request-ids.js";
import { waitForTask } from "./wait.js";

export interface ToolContext {
  client: ControlPlaneClient;
  clientName: string | undefined;
  serverVersion: string;
  /** Owner decision 7: this computer holds an unexpired admin sign-in for the environment. */
  adminSignedIn(): Promise<boolean>;
  compatibility(): Promise<Compatibility>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  newRequestId(): string;
}
export interface ToolCall {
  signal: AbortSignal;
  progress?(progress: number, total: number | undefined, message: string): Promise<void>;
  /** The server's memory of request IDs made for calls that left request_id out. */
  requestIds?: RequestIdMemory;
  log?(entry: Record<string, unknown>): void;
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
  failure: z.object({ category: z.string(), message: z.string() }).optional(),
  starting_revision: z.number(), client: z.string(), shared: z.boolean(), share_mode: z.string().nullable(),
  share_reason: z.string().optional(), share_mode_reason: z.string().optional(),
  channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  thread_url: z.string().optional(), share_posting: z.boolean().optional(), share_post_failed: z.boolean().optional(),
  channel_turns: z.array(z.object({ author: z.string(), slack_user: z.string(), at: z.string(), request: z.string(), outcome: z.string() })).optional(),
  closing: z.boolean().optional(), created_at: z.string(), updated_at: z.string(),
  events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() })),
  summary: z.string().optional(),
  changed_files: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number(), removed: z.number() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().optional() })).optional(),
  pull_requests: z.array(z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() })).optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
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
    ...(timedOut === undefined ? {} : { timed_out: timedOut }),
  };
}

/** What the AI tool can do next with a task in this state. */
function nextFor(task: DeveloperTaskView): string {
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
      return task.failure?.category === "setup_failed"
        ? "It never started: close it with agentx_close_task and start a new one."
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
function requestIdFor(context: ToolContext, call: ToolCall, input: Record<string, unknown>, content: readonly unknown[], group?: string): string {
  const given = input.request_id as string | undefined;
  if (given !== undefined) return given;
  return call.requestIds === undefined ? context.newRequestId() : call.requestIds.idFor(content, context.now(), () => context.newRequestId(), group);
}
const optional = (value: unknown) => value ?? null;
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
      const [compatibility, projects, admin] = await Promise.all([context.compatibility(), context.client.projects(), context.adminSignedIn()]);
      const { developer } = projects;
      const method = developer.provider === "slack" ? "Slack" : "your company sign-in";
      return {
        structured: {
          environment: compatibility.env, developer_name: developer.name, sign_in_method: developer.provider,
          ...(developer.slackUserId === undefined ? {} : { slack_user: developer.slackUserId }), admin,
          server_version: context.serverVersion, control_plane_api_version: compatibility.apiVersion,
          ...(compatibility.notice === undefined ? {} : { upgrade_notice: compatibility.notice }),
        },
        text: `Signed in to AgentX ${compatibility.env} as ${developer.name} with ${method}. This computer ${admin ? "also holds an unexpired" : "holds no"} admin sign-in.${compatibility.notice === undefined ? "" : ` Note: ${compatibility.notice}.`}`,
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
    name: "agentx_get_task",
    title: "Check an AgentX task",
    description:
      "Shows one of your tasks: its status (STARTING, RUNNING, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED or CLOSED), any failure, and its latest progress. Once the task ends it also shows the worker's summary, the changed files with line counts, artifacts, and pull requests with their URLs. Use it to check on a task, to find a pull request's URL after agentx_open_pull_request, and to see how agentx_close_task went: status CLOSED when done, or unpublished listing each repository and why it was not closed. For a shared task it shows the channel, the mode, the thread link once posted, and in continue mode the channel's turns.",
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
    outputSchema: { tasks: z.array(z.object({ task_id: z.string(), title: z.string(), project: z.string(), status: z.string(), created_at: z.string(), updated_at: z.string(), shared: z.boolean() })) },
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
      return { structured: taskOutput(task), text: taskText(task) };
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
