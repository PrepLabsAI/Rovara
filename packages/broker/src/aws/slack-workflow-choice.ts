// Gap 3: starting a task from Slack. A plain @AgentX request starts a task and asks Quick or Full (buttons, or a
// loose `quick` / `full` reply from the requester); `chat:` reaches the chat agent. Shared by the Events API
// ingress and the interactivity handler.
import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SlackMessageTimestampSchema, SlackThreadSchema, SlackUserIdSchema, workflowRequestId, type SlackThread } from "@agentx/contracts";
import { WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION } from "../developer/workflow-actions.js";
import { answeredWorkflowCard } from "../developer/workflow-messages.js";

export type WorkflowPath = "QUICK" | "FULL";

export { WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION };

/** How long a Quick or Full choice waits for its requester. */
const WORKFLOW_CHOICE_RETENTION_SECONDS = 24 * 60 * 60;
/** How long one answer holds the request while it starts, so a second answer at the same time starts nothing. */
const WORKFLOW_CHOICE_START_LEASE_SECONDS = 30;
/** Broker refusals that the same request would meet again: the choice is dropped, so the thread is free for a new one. */
const TERMINAL_START_REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "CHANNEL_REQUIRED", "PROJECT_TASKS_DISABLED", "WORKSPACE_BUSY"]);

const PATH_REPLY = /^(?:let['’]?s\s+(?:go\s+|do\s+)?)?(quick|full)(?:\s+(?:please|pls|path|mode|one))?[\s.!]*$/i;

/** A requester's loose answer to the Quick or Full question ("quick", "Full please", "let's do full"), or undefined. */
export function parseWorkflowPathReply(text: string): WorkflowPath | undefined {
  const match = PATH_REPLY.exec(text.trim());
  if (match === null) return undefined;
  return match[1]!.toUpperCase() === "FULL" ? "FULL" : "QUICK";
}

export type WorkflowStartRequest = { kind: "start"; path?: WorkflowPath; instructions: string } | { kind: "chat"; text: string };

/**
 * What an @AgentX request asks for: `chat:` goes to the chat agent; `quick:`, `full:`, `workflow quick:` and
 * `workflow full:` start a task on that path; `workflow:` and any other request start a task that asks Quick or Full.
 */
export function parseWorkflowStartRequest(text: string): WorkflowStartRequest {
  const trimmed = text.trim();
  const chat = /^chat\s*:([\s\S]*)$/i.exec(trimmed);
  if (chat !== null) return { kind: "chat", text: chat[1]!.trim() };
  const withPath = /^(?:workflow\s+)?(quick|full)\s*:([\s\S]*)$/i.exec(trimmed);
  if (withPath !== null) return { kind: "start", path: withPath[1]!.toUpperCase() === "FULL" ? "FULL" : "QUICK", instructions: withPath[2]!.trim() };
  const bare = /^workflow\s*:([\s\S]*)$/i.exec(trimmed);
  return { kind: "start", instructions: bare === null ? trimmed : bare[1]!.trim() };
}

const QUESTION_TEXT = "How should I handle this?\n"
  + "• *Quick*: I write a short coding plan for you to approve, then code it, run the checks and reviews, and open a draft PR.\n"
  + "• *Full*: I write requirements, then a design, then a coding plan, and you approve each one before any code changes.";
const CHOICE_TEXT = `${QUESTION_TEXT}\nPick a button, or reply \`quick\` or \`full\`.`;

/** The Quick or Full question, with a button for each path bound to this one saved request. */
export function workflowChoiceMessage(input: { choiceId: string; requesterId: string }): { text: string; blocks: Array<Record<string, unknown>> } {
  const value = JSON.stringify({ choiceId: input.choiceId });
  return {
    text: CHOICE_TEXT,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: CHOICE_TEXT } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Only <@${input.requesterId}> can choose.` }] },
      { type: "actions", elements: [
        { type: "button", action_id: WORKFLOW_PATH_QUICK_ACTION, style: "primary", text: { type: "plain_text", text: "Quick" }, value },
        { type: "button", action_id: WORKFLOW_PATH_FULL_ACTION, text: { type: "plain_text", text: "Full" }, value },
      ] },
    ],
  };
}

/** What happens first on `path`, in one sentence. */
function firstStep(path: WorkflowPath): string {
  return path === "FULL"
    ? "I'll write the requirements here first; nothing changes in the code until you approve each step."
    : "I'll write a short coding plan here first; nothing changes in the code until you approve it.";
}

/**
 * Task 15/19: the Quick or Full question once `userId` answered it (by button or by reply): the question kept, its
 * buttons gone, and who chose which path beneath it, with the first step.
 */
export function workflowChoiceAnsweredMessage(userId: string, path: WorkflowPath): { text: string; blocks: Array<Record<string, unknown>> } {
  const chosen = workflowChosenNotice(userId, path);
  return { text: chosen, blocks: answeredWorkflowCard(QUESTION_TEXT, chosen) };
}

/** The one-line confirmation that a task started on `path`. */
export function workflowStartedNotice(path: WorkflowPath): string {
  return `Started on ${path === "FULL" ? "Full" : "Quick"}. ${firstStep(path)}`;
}

/** What replaces the Quick or Full question once `userId` chose: their choice and the first step, in one line. */
export function workflowChosenNotice(userId: string, path: WorkflowPath): string {
  return `<@${userId}> chose ${path === "FULL" ? "Full" : "Quick"}. ${firstStep(path)}`;
}

/** Why a task could not start, in plain words; anything unexpected carries `reference` (the Slack event ID) for an admin. */
export function workflowStartFailureNotice(code: string, reference: string): string {
  if (code === "WORKSPACE_LIMIT") return "You've reached your open-task limit. Close a finished AgentX task, then try again.";
  if (code === "WORKSPACE_BUSY") return "This thread already has a task. Start a new request in the channel.";
  if (code === "FORBIDDEN" || code === "CHANNEL_REQUIRED") return "This channel isn't connected to an AgentX project you can use. Ask an AgentX admin to check the channel.";
  if (code === "PROJECT_TASKS_DISABLED") return "AgentX tasks aren't turned on for this project. Ask an AgentX admin to turn them on.";
  return `I couldn't start this task. Try again in a minute; if it keeps failing, give an AgentX admin this reference: ${reference}.`;
}

/** Said when a thread already has a request waiting for its Quick or Full choice. */
export const WORKFLOW_CHOICE_WAITING_NOTICE = "This thread already has a request waiting for Quick or Full. Answer that one, or start a new request in the channel.";

/** What an answer that started nothing hears, by outcome. */
export function workflowChoiceRefusal(outcome: Exclude<WorkflowChoiceOutcome, "started">): string {
  if (outcome === "not_requester") return "Only the person who asked can choose.";
  if (outcome === "other_path") return "The other choice was already picked for this request, and it didn't start. Pick that one again to retry, or start a new request in the channel.";
  if (outcome === "starting") return "This request is already starting.";
  return "This choice is no longer waiting.";
}

/** A thread already has a request waiting for its Quick or Full choice. */
export class WorkflowChoiceWaitingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("a Quick or Full choice is already waiting in this Slack thread", options);
    this.name = "WorkflowChoiceWaitingError";
  }
}

export class SlackWorkflowStartError extends Error {
  constructor(readonly code: string) {
    super(`Slack workflow start failed: ${code}`);
    this.name = "SlackWorkflowStartError";
  }
}

export type SlackWorkflowStartInput = { thread: SlackThread; userId: string; instructions: string; workflowPath: WorkflowPath; requestId: string };
/** The broker's answer to a direct invoke, as its handler returns it. */
export type BrokerReply = { statusCode?: number; body?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The broker request ID for a Slack workflow start: a UUID passes through, and anything else (a Slack event ID)
 * becomes a UUID derived from it, so Slack's retry of the same event reaches the broker as the same request.
 */
export function slackWorkflowStartRequestId(requestId: string): string {
  return UUID_PATTERN.test(requestId) ? requestId : workflowRequestId("agentx-slack-workflow-start", requestId);
}

/**
 * Start a Slack workflow through the broker's `start-workflow` event, with `invoke` delivering the event and
 * returning the broker's answer. A refusal throws SlackWorkflowStartError with the broker's error code.
 */
export async function startWorkflowThroughBroker(invoke: (event: Record<string, unknown>) => Promise<BrokerReply>, input: SlackWorkflowStartInput): Promise<void> {
  const reply = await invoke({ source: "agentx.slack-ingress", action: "start-workflow", ...input, requestId: slackWorkflowStartRequestId(input.requestId) });
  if (reply.statusCode !== 200 && reply.statusCode !== 201) {
    let code = "UNKNOWN";
    try {
      const body = asRecord(JSON.parse(reply.body ?? "{}"));
      const problem = asRecord(body.error);
      if (typeof problem.code === "string") code = problem.code;
    } catch { /* Keep the safe generic failure when the broker response is malformed. */ }
    throw new SlackWorkflowStartError(code);
  }
}

/**
 * "none": nothing is waiting (or the answer names an older request). "other_path": the other path was already picked
 * (its start was refused and can be retried). "starting": another answer is starting the request right now.
 */
export type WorkflowChoiceOutcome = "started" | "none" | "not_requester" | "other_path" | "starting";

/** A waiting request its requester chose a path for: what starts, and the question's message when it is known. */
export interface ChosenRequest { choiceId: string; instructions: string; requestId: string; messageTs?: string }

/** A request waiting in its thread for its requester's Quick or Full choice. */
export interface WorkflowChoiceStore {
  /** Throws WorkflowChoiceWaitingError when a choice is already waiting in the thread. */
  save(input: { thread: SlackThread; userId: string; instructions: string }): Promise<{ choiceId: string }>;
  pending(thread: SlackThread): Promise<{ choiceId: string; userId: string } | undefined>;
  /**
   * Fixes the path for the waiting request and holds it while it starts (a short lease), returning it to start. The
   * same path again, once `release`d, returns it again, so a start that failed can be retried.
   */
  choose(input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId?: string }): Promise<ChosenRequest | Exclude<WorkflowChoiceOutcome, "started">>;
  /** Task 19: the question's own message, so a typed answer can take its buttons away. */
  attachQuestion(thread: SlackThread, choiceId: string, messageTs: string): Promise<void>;
  /** Task 19: the request `choose` holds for `userId` on `workflowPath`, read again where its start runs; else undefined. */
  held(input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId: string }): Promise<ChosenRequest | undefined>;
  /** Ends the hold `choose` took, after a start that did not go through. */
  release(thread: SlackThread, choiceId: string): Promise<void>;
  /** Forgets the request once its task started. */
  complete(thread: SlackThread, workflowPath: WorkflowPath): Promise<void>;
  /** Forgets a request whose question could not be posted, or whose start can never go through. */
  discard(thread: SlackThread, choiceId: string): Promise<void>;
}

type DocumentClient = { send(command: unknown): Promise<unknown> };

function chosenRequest(item: Record<string, unknown>): ChosenRequest {
  return { choiceId: item.choiceId as string, instructions: item.instructions as string, requestId: item.requestId as string,
    ...(typeof item.messageTs === "string" ? { messageTs: item.messageTs } : {}) };
}

function choiceKey(thread: SlackThread): { pk: string; sk: string } {
  return { pk: `WORKFLOW_CHOICE#${thread.teamId}#${thread.channelId}#${thread.threadTs}`, sk: "META" };
}

function conditionFailed(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/** The choice store on the Slack threads table, one item per thread that expires after a day. */
export function createDynamoWorkflowChoiceStore(input: { documentClient: DocumentClient; tableName: string; now?: () => number }): WorkflowChoiceStore {
  const { documentClient, tableName } = input;
  const now = input.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1_000);
  const read = async (thread: SlackThread): Promise<Record<string, unknown> | undefined> => {
    const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: choiceKey(thread), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const item = response.Item;
    if (item === undefined || typeof item.choiceId !== "string" || typeof item.userId !== "string" || typeof item.instructions !== "string"
      || typeof item.requestId !== "string" || typeof item.expiresAt !== "number" || item.expiresAt <= nowSeconds()
      || item.teamId !== thread.teamId || item.channelId !== thread.channelId || item.threadTs !== thread.threadTs) return undefined;
    return item;
  };
  return {
    async save({ thread, userId, instructions }) {
      const choiceId = randomUUID();
      const at = now();
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            ...choiceKey(thread), entityType: "WORKFLOW_PATH_CHOICE", choiceId, teamId: thread.teamId, channelId: thread.channelId,
            threadTs: thread.threadTs, userId, instructions, requestId: choiceId, createdAt: new Date(at).toISOString(),
            expiresAt: Math.floor(at / 1_000) + WORKFLOW_CHOICE_RETENTION_SECONDS,
          },
          // An expired choice the table has not removed yet does not block a new one.
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": Math.floor(at / 1_000) },
        }));
      } catch (error) {
        if (conditionFailed(error)) throw new WorkflowChoiceWaitingError({ cause: error });
        throw error;
      }
      return { choiceId };
    },
    async pending(thread) {
      const item = await read(thread);
      return item === undefined ? undefined : { choiceId: item.choiceId as string, userId: item.userId as string };
    },
    async choose({ thread, userId, workflowPath, choiceId }) {
      const refusal = (item: Record<string, unknown> | undefined): Exclude<WorkflowChoiceOutcome, "started"> | undefined => {
        if (item === undefined || (choiceId !== undefined && item.choiceId !== choiceId)) return "none";
        if (item.userId !== userId) return "not_requester";
        if (item.selectedPath !== undefined && item.selectedPath !== workflowPath) return "other_path";
        if (typeof item.startingUntil === "number" && item.startingUntil > nowSeconds()) return "starting";
        return undefined;
      };
      const item = await read(thread);
      const early = refusal(item);
      if (early !== undefined || item === undefined) return early ?? "none";
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: choiceKey(thread),
          UpdateExpression: "SET selectedPath = if_not_exists(selectedPath, :path), startingUntil = :until",
          ConditionExpression: "choiceId = :choiceId AND expiresAt > :now AND (attribute_not_exists(selectedPath) OR selectedPath = :path)"
            + " AND (attribute_not_exists(startingUntil) OR startingUntil <= :now)",
          ExpressionAttributeValues: { ":path": workflowPath, ":choiceId": item.choiceId, ":now": nowSeconds(), ":until": nowSeconds() + WORKFLOW_CHOICE_START_LEASE_SECONDS },
        }));
      } catch (error) {
        // Another answer got there first: say what it did.
        if (conditionFailed(error)) return refusal(await read(thread)) ?? "starting";
        throw error;
      }
      return chosenRequest(item);
    },
    async attachQuestion(thread, choiceId, messageTs) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: choiceKey(thread), UpdateExpression: "SET messageTs = :ts",
          ConditionExpression: "choiceId = :choiceId", ExpressionAttributeValues: { ":ts": messageTs, ":choiceId": choiceId },
        }));
      } catch (error) {
        // Already answered and forgotten: nothing is left to attach to.
        if (!conditionFailed(error)) throw error;
      }
    },
    async held({ thread, userId, workflowPath, choiceId }) {
      const item = await read(thread);
      if (item === undefined || item.choiceId !== choiceId || item.userId !== userId || item.selectedPath !== workflowPath) return undefined;
      return chosenRequest(item);
    },
    async release(thread, choiceId) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: choiceKey(thread), UpdateExpression: "REMOVE startingUntil",
          ConditionExpression: "choiceId = :choiceId", ExpressionAttributeValues: { ":choiceId": choiceId },
        }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
    },
    async complete(thread, workflowPath) {
      try {
        await documentClient.send(new DeleteCommand({ TableName: tableName, Key: choiceKey(thread), ConditionExpression: "selectedPath = :path", ExpressionAttributeValues: { ":path": workflowPath } }));
      } catch (error) {
        // Already removed (a repeated answer): nothing is left to forget.
        if (!conditionFailed(error)) throw error;
      }
    },
    async discard(thread, choiceId) {
      try {
        await documentClient.send(new DeleteCommand({ TableName: tableName, Key: choiceKey(thread), ConditionExpression: "choiceId = :choiceId", ExpressionAttributeValues: { ":choiceId": choiceId } }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
    },
  };
}

/**
 * Saves the request and asks its requester Quick or Full in the thread; a question Slack refused leaves nothing waiting.
 * The question's message is kept with the request (best effort), so a typed answer can take its buttons away.
 */
export async function offerWorkflowChoice(
  deps: { store: WorkflowChoiceStore; postMessage(input: { channel: string; threadTs: string; text: string; blocks: Array<Record<string, unknown>> }): Promise<{ ts?: string } | void> },
  input: { thread: SlackThread; userId: string; instructions: string },
): Promise<void> {
  const { choiceId } = await deps.store.save(input);
  let posted: { ts?: string } | void;
  try {
    posted = await deps.postMessage({ channel: input.thread.channelId, threadTs: input.thread.threadTs, ...workflowChoiceMessage({ choiceId, requesterId: input.userId }) });
  } catch (error) {
    await deps.store.discard(input.thread, choiceId).catch(() => undefined);
    throw error;
  }
  if (typeof posted?.ts !== "string") return;
  try {
    await deps.store.attachQuestion(input.thread, choiceId, posted.ts);
  } catch (error) {
    // The question is asked; only its buttons stay after a typed answer.
    logChoice("workflow.choice_question_unrecorded", error);
  }
}

/** What finishing a chosen request needs: the store, the broker start, and (optionally) the question's edit. */
export interface ChosenWorkflowDependencies {
  store: WorkflowChoiceStore;
  startWorkflow(input: SlackWorkflowStartInput): Promise<void>;
  /** Replaces the Quick or Full question once its request started (chat.update); best effort. */
  updateQuestion?(input: { channel: string; ts: string; text: string; blocks: Array<Record<string, unknown>> }): Promise<void>;
}

/**
 * Starts a request `choose` holds and forgets it. A failed start throws (a refusal as SlackWorkflowStartError): a
 * refusal the same request would meet again drops the choice; any other failure leaves it waiting on that path, so the
 * same answer can be given again. Once started, the question (when its message is known) loses its buttons.
 */
export async function finishChosenWorkflow(
  deps: ChosenWorkflowDependencies,
  input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath },
  chosen: ChosenRequest,
): Promise<void> {
  try {
    await deps.startWorkflow({ thread: input.thread, userId: input.userId, instructions: chosen.instructions, workflowPath: input.workflowPath, requestId: chosen.requestId });
  } catch (error) {
    const terminal = error instanceof SlackWorkflowStartError && TERMINAL_START_REFUSALS.has(error.code);
    try {
      await (terminal ? deps.store.discard(input.thread, chosen.choiceId) : deps.store.release(input.thread, chosen.choiceId));
    } catch (storeError) {
      // The start's own failure is what the person hears; a held choice frees itself when its short lease ends.
      logChoice("workflow.choice_release_failed", storeError);
    }
    throw error;
  }
  try {
    await deps.store.complete(input.thread, input.workflowPath);
  } catch (error) {
    // The task started; the leftover choice only answers "already starting" or expires.
    logChoice("workflow.choice_complete_failed", error);
  }
  if (chosen.messageTs !== undefined && deps.updateQuestion !== undefined) {
    try {
      await deps.updateQuestion({ channel: input.thread.channelId, ts: chosen.messageTs, ...workflowChoiceAnsweredMessage(input.userId, input.workflowPath) });
    } catch (error) {
      // The task started; a question left with its buttons only answers "no longer waiting" if pressed again.
      logChoice("workflow.choice_question_update_failed", error);
    }
  }
}

/**
 * The requester's Quick or Full choice: starts the saved request on that path and forgets it (see
 * `finishChosenWorkflow`). Used where the start may run before the answer (a typed reply).
 */
export async function startChosenWorkflow(
  deps: ChosenWorkflowDependencies,
  input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId?: string; messageTs?: string },
): Promise<WorkflowChoiceOutcome> {
  const chosen = await deps.store.choose(input);
  if (typeof chosen === "string") return chosen;
  // A button press names the question's message itself, in case it was never recorded with the request.
  await finishChosenWorkflow(deps, input, { ...chosen, ...(chosen.messageTs === undefined && input.messageTs !== undefined ? { messageTs: input.messageTs } : {}) });
  return "started";
}

/** Task 19: a Quick or Full button press whose start runs after Slack has its answer (an asynchronous self-invoke). */
export interface HandedOffWorkflowStart {
  source: "agentx.slack-interactivity";
  action: "start-chosen-workflow";
  thread: SlackThread;
  userId: string;
  workflowPath: WorkflowPath;
  choiceId: string;
  /** Slack's response URL of the press, for telling the member privately if the start fails. */
  responseUrl: string;
  /** The question's message, which loses its buttons once the task started. */
  messageTs?: string;
}

export function isHandedOffWorkflowStart(event: unknown): event is HandedOffWorkflowStart {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // Never an HTTP request: API Gateway's events always carry a requestContext. Only Slack's own response URLs.
  return value.source === "agentx.slack-interactivity" && value.action === "start-chosen-workflow" && value.requestContext === undefined
    && SlackThreadSchema.safeParse(value.thread).success && SlackUserIdSchema.safeParse(value.userId).success
    && (value.workflowPath === "QUICK" || value.workflowPath === "FULL") && typeof value.choiceId === "string" && UUID_PATTERN.test(value.choiceId)
    && typeof value.responseUrl === "string" && value.responseUrl.startsWith("https://hooks.slack.com/")
    && (value.messageTs === undefined || SlackMessageTimestampSchema.safeParse(value.messageTs).success);
}

/**
 * Gap 10h for Quick or Full buttons: takes the requester's choice (the store's short hold) while Slack waits, and hands
 * the start itself to `handOff`, which runs it after Slack has its answer. "started" means the start is on its way.
 */
export async function handOffChosenWorkflow(
  deps: { store: WorkflowChoiceStore; handOff(event: HandedOffWorkflowStart): Promise<void> },
  input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId: string; responseUrl: string; messageTs?: string },
): Promise<WorkflowChoiceOutcome> {
  const chosen = await deps.store.choose(input);
  if (typeof chosen === "string") return chosen;
  try {
    await deps.handOff({ source: "agentx.slack-interactivity", action: "start-chosen-workflow", thread: input.thread, userId: input.userId,
      workflowPath: input.workflowPath, choiceId: chosen.choiceId, responseUrl: input.responseUrl, ...(input.messageTs === undefined ? {} : { messageTs: input.messageTs }) });
  } catch (error) {
    // Nothing will start it: free the hold so the same answer can be given again at once.
    await deps.store.release(input.thread, chosen.choiceId).catch((releaseError: unknown) => logChoice("workflow.choice_release_failed", releaseError));
    throw error;
  }
  return "started";
}

/**
 * Runs a handed-off start: reads the held request again (only the requester's, on the path they chose), starts it, and
 * tells the member privately, through the press's response URL, when the start failed or was refused.
 */
export async function runHandedOffWorkflowStart(
  deps: ChosenWorkflowDependencies & { respondEphemeral(responseUrl: string, text: string): Promise<void> },
  event: HandedOffWorkflowStart,
): Promise<"started" | "none" | "failed"> {
  const input = { thread: event.thread, userId: event.userId, workflowPath: event.workflowPath };
  const tell = async (text: string) => {
    try {
      await deps.respondEphemeral(event.responseUrl, text);
    } catch (error) {
      logChoice("workflow.choice_failure_notice_failed", error);
    }
  };
  let chosen: ChosenRequest | undefined;
  try {
    chosen = await deps.store.held({ ...input, choiceId: event.choiceId });
  } catch (error) {
    logChoice("workflow.choice_read_failed", error);
    await tell(workflowStartFailureNotice("UNKNOWN", event.choiceId));
    return "failed";
  }
  if (chosen === undefined) return "none";
  try {
    await finishChosenWorkflow(deps, input, { ...chosen, ...(chosen.messageTs === undefined && event.messageTs !== undefined ? { messageTs: event.messageTs } : {}) });
  } catch (error) {
    logChoice("workflow.choice_start_failed", error);
    await tell(workflowStartFailureNotice(error instanceof SlackWorkflowStartError ? error.code : "UNKNOWN", event.choiceId));
    return "failed";
  }
  return "started";
}

function logChoice(event: string, error: unknown): void {
  console.log(JSON.stringify({ component: "slack-workflow-choice", event, errorName: error instanceof Error ? error.name : "unknown" }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
