// Issue #437: one conversation's current state, read from Rovara's own records (the thread's workspace, its
// operations and pull requests, the pending confirmation, and the newest event the sender handled), so a service that
// drives conversations on its own can tell where a task stands even after it missed an event.
import {
  CONVERSATION_STATE_THREAD_ATTRIBUTES,
  CONVERSATION_STATE_WORKSPACE_ATTRIBUTES,
  confirmationApprovalKind,
  confirmationDigest,
  confirmationKey,
  conversationOwnerIssuer,
  conversationSubject,
  pendingConfirmationFromItem,
  taskResultChecks,
  type ChannelEvent,
  type ConversationRef,
  type ConversationState,
  type ConversationTaskStatus,
  type ConversationWorkspaceState,
} from "@agentx/contracts";
import { slackThreadKey } from "./failed-preparation.js";
import { ownerKeyForSubject } from "./lambda.js";

type Item = Record<string, unknown>;

export interface ConversationStateDependencies {
  /** The state table, by key, with only `attributes`. */
  getState(key: { pk: string; sk: string }, attributes: readonly string[]): Promise<Item | undefined>;
  /** The state table: every item under `pk` whose sort key starts with `prefix`, with only `attributes`. */
  queryState(pk: string, prefix: string, attributes: readonly string[]): Promise<Item[]>;
  /** The Slack threads table, which keeps a conversation's confirmation. */
  getThread(key: { pk: string; sk: string }): Promise<Item | undefined>;
  /** The channel state table, which keeps the newest event per conversation. */
  getChannelState(key: { pk: string; sk: string }): Promise<Item | undefined>;
  now(): number;
}

/** Where the event sender keeps the newest event it handled for a conversation. */
export function lastEventKey(conversation: ConversationRef): { pk: string; sk: string } {
  return { pk: `LAST_EVENT#${conversation.channel}`, sk: conversationSubject(conversation) };
}

/** The item the sender writes; only newer events replace it (FIFO keeps them in order, the condition makes sure). */
export function lastEventItem(event: Extract<ChannelEvent, { conversation: ConversationRef }>): Item {
  return { ...lastEventKey(event.conversation), eventId: event.id, type: event.type, createdAt: event.createdAt };
}

const WORKSPACE_STATE: Record<string, ConversationWorkspaceState> = {
  PREPARING: "preparing", RESUMING: "preparing", UNPREPARED: "preparing",
  READY: "ready", BUSY: "ready", STOPPED: "ready",
  CLOSING: "closing", CLOSED: "closed",
  PREPARATION_FAILED: "failed", UNHEALTHY: "failed",
};
const TASK_STATUS: Record<string, ConversationTaskStatus> = {
  ACCEPTED: "queued", DISPATCHING: "queued", RUNNING: "running", CANCEL_REQUESTED: "running",
  SUCCEEDED: "succeeded", FAILED: "failed", INTERRUPTED: "failed", CANCELLED: "cancelled",
};
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
/** The operations that are a conversation's work; preparing, stopping and closing compute are the workspace's. */
const TASK_KINDS = new Set(["task", "publish", "maintain"]);
const CHECK_STATUS = { verified: "passed", regression: "failed", not_verified: "unknown" } as const;
const GITHUB_PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export async function readConversationState(deps: ConversationStateDependencies, conversation: ConversationRef): Promise<ConversationState> {
  const subject = conversationSubject(conversation);
  const ownerKey = ownerKeyForSubject(conversationOwnerIssuer(conversation.channel), subject);
  const [thread, confirmationItem, last] = await Promise.all([
    deps.getState(slackThreadKey(ownerKey), CONVERSATION_STATE_THREAD_ATTRIBUTES),
    deps.getThread(confirmationKey(subject)),
    deps.getChannelState(lastEventKey(conversation)),
  ]);
  const workspaceId = text(thread?.workspaceId);

  let workspace: ConversationState["workspace"] = null;
  let task: ConversationState["task"] = null;
  let checks: ConversationState["checks"] = null;
  let pullRequests: ConversationState["pullRequests"] = [];
  if (workspaceId !== undefined) {
    const [meta, operations, pulls] = await Promise.all([
      deps.getState({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }, CONVERSATION_STATE_WORKSPACE_ATTRIBUTES),
      deps.queryState(`WORKSPACE#${workspaceId}`, "OPERATION#", CONVERSATION_STATE_WORKSPACE_ATTRIBUTES),
      deps.queryState(`WORKSPACE#${workspaceId}`, "PULL_REQUEST#", CONVERSATION_STATE_WORKSPACE_ATTRIBUTES),
    ]);
    const state = WORKSPACE_STATE[text(meta?.status) ?? ""];
    // A thread the conversation closed keeps its record; its workspace may already be gone.
    workspace = state !== undefined ? { state } : thread?.closedAt !== undefined ? { state: "closed" } : null;
    const work = operations
      .filter((item) => item.entityType === "OPERATION" && TASK_KINDS.has(text(item.kind) ?? "") && text(item.id) !== undefined && text(item.createdAt) !== undefined)
      .sort((a, b) => text(a.createdAt)!.localeCompare(text(b.createdAt)!));
    const latest = work.at(-1);
    const status = latest === undefined ? undefined : TASK_STATUS[text(latest.status) ?? ""];
    if (latest !== undefined && status !== undefined) {
      task = {
        taskId: text(latest.id)!, kind: text(latest.kind)!, status, startedAt: text(latest.createdAt)!,
        ...(TERMINAL.has(status) && text(latest.updatedAt) !== undefined ? { endedAt: text(latest.updatedAt)! } : {}),
      };
    }
    const checked = [...work].reverse().find((item) => taskResultChecks(item.result) !== undefined);
    const report = checked === undefined ? undefined : taskResultChecks(checked.result);
    if (checked !== undefined && report !== undefined) checks = { taskId: text(checked.id)!, status: CHECK_STATUS[report.status] };
    pullRequests = pulls.flatMap((item) => {
      const url = text(item.url) ?? "";
      const repository = GITHUB_PULL.exec(url)?.[1];
      const state = item.state === "open" || item.state === "closed" || item.state === "merged" ? item.state : undefined;
      const headSha = text(item.expectedHeadCommit);
      const baseBranch = text(item.baseBranch);
      if (repository === undefined || state === undefined || headSha === undefined || baseBranch === undefined || typeof item.number !== "number") return [];
      const taskId = text(item.createdByOperationId);
      return [{ repository, number: item.number, url, state, headSha, baseBranch, ...(taskId === undefined ? {} : { taskId }) }];
    });
  }

  // A confirmation waits only until it is answered, used or expired.
  const confirmation = pendingConfirmationFromItem(confirmationItem);
  const open = confirmation !== undefined && confirmation.retiredAt === undefined && confirmation.usedBy === undefined && Date.parse(confirmation.expiresAt) > deps.now();
  const pendingDecision = open
    ? { requestId: confirmation.confirmationId, kind: confirmationApprovalKind(confirmation), expectedRevision: 1, artifactDigest: confirmationDigest(confirmation), expiresAt: confirmation.expiresAt }
    : null;

  const lastId = text(last?.eventId);
  const lastType = text(last?.type);
  const lastAt = text(last?.createdAt);
  return {
    conversation, workspace, task, pendingDecision, checks, pullRequests,
    lastEvent: lastId === undefined || lastType === undefined || lastAt === undefined ? null : { id: lastId, type: lastType, createdAt: lastAt },
  };
}
