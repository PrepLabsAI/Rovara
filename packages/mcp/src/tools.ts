// Spec 025 FR-030: the developer tools, written against ControlPlaneClient so the stdio server
// now and the hosted endpoint later use the same definitions (FR-027). Descriptions are written
// for the AI tool that reads them: when to use the tool, and what to do next.
import {
  DEFAULT_DEVELOPER_TASK_POLICY, DEVELOPER_EVENTS_DEFAULT, DEVELOPER_EVENTS_MAX, DEVELOPER_TASK_LIST_DEFAULT, DEVELOPER_TASK_LIST_MAX,
  DEVELOPER_WAIT_MAX_SECONDS, DeveloperInstructionsSchema, DeveloperTaskStatusSchema, type DeveloperTaskView,
} from "@agentx/contracts";
import { z } from "zod";
import type { ControlPlaneClient } from "./client.js";
import type { Compatibility } from "./compatibility.js";
import { ToolError } from "./errors.js";
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
export interface ToolCall { signal: AbortSignal; progress?(progress: number, total: number | undefined, message: string): Promise<void> }
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
const requestIdInput = z.string().uuid().optional().describe("a UUID; send the same one again to retry this call safely without repeating it. One is made when left out");
const waitInput = (min: number) => z.number().int().min(min).max(DEVELOPER_WAIT_MAX_SECONDS);
const eventsInput = z.number().int().min(0).max(DEVELOPER_EVENTS_MAX).optional().describe("how many recent progress events to show, 0 to 50; 10 by default");
const instructionsInput = z.string().min(1).describe("complete instructions for the remote worker, at most 65,536 bytes; it gets them exactly as written and cannot see this conversation");

const TaskShape = {
  task_id: z.string(), title: z.string(), project: z.string(), status: DeveloperTaskStatusSchema,
  failure: z.object({ category: z.string(), message: z.string() }).optional(),
  starting_revision: z.number(), client: z.string(), shared: z.boolean(), share_mode: z.string().nullable(),
  closing: z.boolean().optional(), created_at: z.string(), updated_at: z.string(),
  events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() })),
  summary: z.string().optional(),
  changed_files: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number(), removed: z.number() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().optional() })).optional(),
  pull_requests: z.array(z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() })).optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** Only on start, continue and wait, which may wait (R21). */
  timed_out: z.boolean().optional(),
};

/** The one place a wire view (camelCase) becomes a tool output (snake_case). */
function taskOutput(task: DeveloperTaskView, timedOut?: boolean): Record<string, unknown> {
  return {
    task_id: task.taskId, title: task.title, project: task.project, status: task.status,
    ...(task.failure === undefined ? {} : { failure: task.failure }),
    // Tasks are private in 25b; sharing, and so a share mode, arrive in 25c.
    starting_revision: task.startingRevision, client: task.client, shared: task.shared, share_mode: null,
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

function taskText(task: DeveloperTaskView, timedOut?: boolean): string {
  const failure = task.failure === undefined ? "" : ` (${task.failure.category}: ${task.failure.message})`;
  const waited = timedOut === true ? " The wait ended first; the task keeps running." : "";
  const summary = task.summary === undefined ? "" : ` Summary: ${task.summary}`;
  return `Task ${task.taskId} "${task.title}" on ${task.project} is ${task.status}${failure}.${waited} ${nextFor(task)}${summary}`;
}

function instructions(value: unknown): string {
  const parsed = DeveloperInstructionsSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("INVALID_REQUEST", `instructions: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

const requestId = (context: ToolContext, input: Record<string, unknown>) => (input.request_id as string | undefined) ?? context.newRequestId();
const eventsOf = (input: Record<string, unknown>) => (input.events as number | undefined) ?? DEVELOPER_EVENTS_DEFAULT;

async function wait(context: ToolContext, call: ToolCall, taskId: string, waitSeconds: number, events: number) {
  return waitForTask({
    client: context.client, taskId, waitSeconds, events, signal: call.signal, now: () => context.now(), sleep: (ms, signal) => context.sleep(ms, signal),
    ...(call.progress === undefined ? {} : { progress: (elapsed: number, total: number, message: string) => call.progress!(elapsed, total, message) }),
  });
}

/**
 * The optional wait after a start or continue. The action already happened, so a failed check
 * during the wait still answers with the task: an error here would make the AI tool try the
 * start again and start a second task.
 */
async function afterAction(context: ToolContext, call: ToolCall, task: DeveloperTaskView, waitSeconds: number): Promise<ToolResult> {
  if (waitSeconds === 0) return { structured: taskOutput(task), text: taskText(task) };
  try {
    const waited = await wait(context, call, task.taskId, waitSeconds, DEVELOPER_EVENTS_DEFAULT);
    return { structured: taskOutput(waited.task, waited.timedOut), text: taskText(waited.task, waited.timedOut) };
  } catch (error) {
    const why = error instanceof ToolError ? error.message : "an unexpected problem";
    return {
      structured: taskOutput(task, true),
      text: `Task ${task.taskId} "${task.title}" on ${task.project} was accepted, but the wait stopped early: ${why}. The task keeps running; check it with agentx_get_task.`,
    };
  }
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
      "Lists the AgentX projects you can hand coding tasks to, with each project's Slack channels and task policy. Use it before agentx_start_task to get a project's exact name. A project with tasks_enabled false, or with share_policy required, cannot take tasks from an AI tool yet; use its Slack channel instead.",
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
      "Hands a coding task to AgentX, which runs it in a private remote workspace on the project's repositories. The task is private to you. Write complete instructions: the remote worker gets them exactly as written and cannot see this conversation. By default it answers at once with a task ID while the task runs; then check it with agentx_get_task or wait with agentx_wait_for_task. To wait for a small task in the same call, set wait_seconds (up to 600); if the wait ends first, the result says timed_out and the task keeps running. If the call itself fails or times out, retry with the same request_id so no second task starts. When the task ends, open a pull request with agentx_open_pull_request or send more work with agentx_continue_task, and close it with agentx_close_task when done, since each open task counts against your limit.",
    inputSchema: {
      project: z.string().min(1).max(200).describe("the project's exact name, from agentx_list_projects"),
      instructions: instructionsInput,
      title: z.string().max(120).optional().describe("a short title, at most 120 characters; the first line of the instructions when left out"),
      share_to_channel: z.boolean().optional().describe("not available yet: AgentX refuses a start that asks to share, so leave it out"),
      share_mode: z.enum(["view", "continue"]).optional().describe("for sharing, which is not available yet; leave it out"),
      channel: z.string().max(80).optional().describe("for sharing, which is not available yet; leave it out"),
      wait_seconds: waitInput(0).optional().describe("seconds to wait for the task to end, 0 to 600; 0 (answer at once) by default"),
      request_id: requestIdInput,
    },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      const task = await context.client.startTask({
        requestId: requestId(context, input),
        project: input.project as string,
        instructions: instructions(input.instructions),
        ...(input.title === undefined ? {} : { title: input.title as string }),
        // R25: sent as it came; the broker maps it to one of four fixed names.
        ...(context.clientName === undefined ? {} : { client: context.clientName.slice(0, 200) }),
        ...(input.share_to_channel === undefined ? {} : { shareToChannel: input.share_to_channel as boolean }),
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      return afterAction(context, call, task, (input.wait_seconds as number | undefined) ?? 0);
    },
  },
  {
    name: "agentx_get_task",
    title: "Check an AgentX task",
    description:
      "Shows one of your tasks: its status (STARTING, RUNNING, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED or CLOSED), any failure, and its latest progress. Once the task ends it also shows the worker's summary, the changed files with line counts, artifacts, and pull requests with their URLs. Use it to check on a task, to find a pull request's URL after agentx_open_pull_request, and to see how agentx_close_task went: status CLOSED when done, or unpublished listing each repository and why it was not closed.",
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
      const waited = await wait(context, call, input.task_id as string, input.wait_seconds as number, eventsOf(input));
      return { structured: taskOutput(waited.task, waited.timedOut), text: taskText(waited.task, waited.timedOut) };
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
      "Sends more instructions to one of your tasks once it has ended. They run in the same workspace, on the same branch, exactly as written, so write them in full. Answers like agentx_start_task: at once by default, or after waiting up to wait_seconds (up to 600). A task that is still running answers TASK_BUSY: wait for it with agentx_wait_for_task first. A task whose setup failed cannot be continued: close it and start a new one.",
    inputSchema: {
      task_id: taskIdInput,
      instructions: instructionsInput,
      wait_seconds: waitInput(0).optional().describe("seconds to wait for the task to end, 0 to 600; 0 (answer at once) by default"),
      request_id: requestIdInput,
    },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      const task = await context.client.continueTask(input.task_id as string, { requestId: requestId(context, input), instructions: instructions(input.instructions) });
      return afterAction(context, call, task, (input.wait_seconds as number | undefined) ?? 0);
    },
  },
  {
    name: "agentx_cancel_task",
    title: "Cancel an AgentX task",
    description:
      "Stops the work one of your tasks is running now, and shows its status after the request. The workspace and its changes stay, so you can still continue the task, open a pull request, or close it with agentx_close_task. Cancelling a task that is not running changes nothing.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput },
    outputSchema: TaskShape,
    async handler(context, input) {
      const task = await context.client.cancelTask(input.task_id as string, requestId(context, input));
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
      const answer = await context.client.closeTask(taskId, requestId(context, input));
      const unpublished = answer.unpublished ?? answer.task.unpublished;
      const task = unpublished === undefined ? answer.task : { ...answer.task, unpublished };
      const text = answer.closed
        ? `Task ${taskId} is closed; its workspace is released.`
        : unpublished !== undefined
          ? `Task ${taskId} was not closed: unpublished work in ${unpublished.map((entry) => `${entry.repository} (${entry.reasons.join(", ")})`).join("; ")}. Open a pull request with agentx_open_pull_request first, or continue the task with instructions to discard the changes, then close it again.`
          : `Closing task ${taskId}: AgentX is checking the workspace for unpublished work. Check with agentx_get_task; it shows CLOSED when done.`;
      return { structured: { ...taskOutput(task), closed: answer.closed }, text };
    },
  },
  {
    name: "agentx_open_pull_request",
    title: "Open a pull request from an AgentX task",
    description:
      "Opens a pull request with one of your task's changes, through AgentX's GitHub App, as a draft unless draft is false. Use it once the task has ended and you have read its summary and changed files. Answers at once with the publish operation's ID and status (ACCEPTED when just started): check with agentx_get_task, whose pull_requests lists the URL once it is published. If the call fails or times out, retry with the same request_id to get the same operation, never a second pull request. repository is needed only when the project has several repositories.",
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
    },
    async handler(context, input) {
      const taskId = input.task_id as string;
      // R22: no wait. A repeated request_id returns the same operation, with the URL once published.
      const answer = await context.client.openPullRequest(taskId, {
        requestId: requestId(context, input),
        title: input.title as string,
        draft: (input.draft as boolean | undefined) ?? true,
        ...(input.body === undefined ? {} : { body: input.body as string }),
        ...(input.repository === undefined ? {} : { repository: input.repository as string }),
      });
      return {
        structured: {
          operation_id: answer.operationId, operation_status: answer.operationStatus,
          ...(answer.pullRequest === undefined ? {} : { pull_request: answer.pullRequest }),
          task: taskOutput(answer.task),
        },
        text: answer.pullRequest !== undefined
          ? `The pull request for task ${taskId} is ${answer.pullRequest.url} (${answer.pullRequest.state}).`
          : `Opening a pull request for task ${taskId} (operation ${answer.operationId}, ${answer.operationStatus}). Check with agentx_get_task; its URL appears there once it is published.`,
      };
    },
  },
];
