// Lane L9-wire: the task flow's side of a session's stop, retry and message (L6b's `SessionControlHost`). Each runs only after the sessions module checked who is asking.
import { INDEX_EXPIRY_ATTRIBUTE, WORKFLOW_THREAD_NOTES_MAX, change, when, type TransactItem } from "@agentx/contracts";
import type { SessionMembers } from "../../core/sessions/access.js";
import { createSessionControl, type MessagePlan, type SessionControlHost } from "../../core/sessions/control.js";
import { sendLiveSteer } from "../../core/sessions/live-steer.js";
import { noteKey, sessionNoteItems } from "../../core/sessions/notes.js";
import { PLAIN_TASK_REASON, SESSION_ENDED_REASON, TASK_FULL_REASON, routeOfTask } from "../../core/sessions/steer.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { cancelTask } from "../../core/task-flow/cancel.js";
import { closeTask } from "../../core/task-flow/close.js";
import { readTask } from "../../core/task-flow/reads.js";
import { retryBlockedStep } from "./retry.js";

/** A person may message a session this many times an hour (a token bucket), and a task keeps this many messages: a live message can mean paid model work. */
export const MESSAGES_PER_HOUR = 20;
export const MESSAGES_PER_TASK = WORKFLOW_THREAD_NOTES_MAX;
export const MESSAGE_RATE_LIMITED = "You have sent a lot of messages to this task in the last hour. Wait a little, then try again.";

export function createSessionControlHost(deps: TaskFlowDeps, options: { expectedRevision?: number } = {}): SessionControlHost {
  return {
    async cancelTask(taskId): Promise<{ nothingRunning: boolean; message?: string }> {
      return cancelTask(deps, taskId);
    },

    async closeTask(taskId, _requestId, principal) {
      await closeTask(deps, { principal, client: "app" }, taskId);
    },

    async retryWorkflow(taskId) {
      await retryBlockedStep(deps, taskId, options.expectedRevision);
    },

    /**
     * Where a message goes: the task keeps it as a note (`NOTE#<messageId>`, the count on the task) that its next step reads, and a step that is running now takes it live through the worker (when the
     * worker lists `task.liveSteer.v1`). The rate limit is L9-wire's, unchanged: a token bucket of `MESSAGES_PER_HOUR`, and at most `WORKFLOW_THREAD_NOTES_MAX` notes a task. The note, the count and the token go in the message's own
     * transaction (the items), so nothing is counted for a message that is not saved.
     */
    async planMessage(taskId, message): Promise<MessagePlan> {
      const task = await readTask(deps, taskId);
      const route = routeOfTask({ sessionId: message.sessionId }, task);
      if (route.kind === "ended") return { state: "not_delivered", reason: SESSION_ENDED_REASON };
      if (route.kind === "not_delivered") return { state: "not_delivered", reason: route.reason };
      const nowMs = (deps.now?.() ?? new Date()).getTime();
      // A repeat of a message already saved (a crash between its note and its session message) is answered again and not counted.
      const saved = await deps.store.get(noteKey(taskId, message.messageId));
      if (saved !== undefined) return { state: saved["liveDeliveredAt"] === undefined ? "queued" : "delivered" };
      const bucketKey = { pk: `DEVTASK#${taskId}`, sk: "MESSAGE_BUCKET" };
      const bucket = await deps.store.get(bucketKey);
      // A token bucket: MESSAGES_PER_HOUR messages at most, refilled evenly over the hour (so no burst of twice the limit across an hour boundary). The write is conditioned on the bucket as it was read, so two messages racing
      // cannot both take the last token (the loser's transaction fails and the message is planned again).
      const tokens = bucket === undefined ? MESSAGES_PER_HOUR : Math.min(MESSAGES_PER_HOUR, Number(bucket["tokens"]) + ((nowMs - Number(bucket["at"])) * MESSAGES_PER_HOUR) / 3_600_000);
      if (!(tokens >= 1)) return { state: "not_delivered", reason: MESSAGE_RATE_LIMITED };
      const built = sessionNoteItems(task, { taskId, source: "app", developerId: message.author.developerId, name: message.author.name, isOwner: message.owner, sessionId: message.sessionId, messageId: message.messageId, text: message.text }, nowMs);
      if (built.outcome === "refused") return { state: "not_delivered", reason: built.reason === "full" ? TASK_FULL_REASON : built.reason === "closed" ? SESSION_ENDED_REASON : PLAIN_TASK_REASON };
      const token: TransactItem = {
        kind: "put", item: { ...bucketKey, entityType: "MESSAGE_BUCKET", tokens: tokens - 1, at: nowMs, version: bucket === undefined ? 1 : Number(bucket["version"]) + 1, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + 2 * 3_600 },
        condition: bucket === undefined ? when.absent() : when.eq("version", Number(bucket["version"])),
      };
      return {
        state: "queued", items: [token, ...built.items],
        async goLive() {
          const sent = await sendLiveSteer({ ...deps, ...(deps.liveSteer === undefined ? {} : { enabled: deps.liveSteer }) }, { taskId, messageId: message.messageId, text: message.text, owner: message.owner, developerId: message.author.developerId });
          if (sent !== "steered") return { taken: false };
          return { taken: true, items: [{ kind: "update", key: noteKey(taskId, message.messageId), ops: [change.set("liveDeliveredAt", (deps.now?.() ?? new Date()).toISOString())] }] };
        },
      };
    },
  };
}

/** The session control (who may stop, retry or message; the request recorded once under its id, with the event and the audit step) over this install's flow. Every route that stops or retries uses this one. */
export function createLocalSessionControl(deps: TaskFlowDeps, options: { expectedRevision?: number; members?: SessionMembers | undefined } = {}) {
  return createSessionControl({ store: deps.store, audit: deps.audit, host: createSessionControlHost(deps, options), members: options.members, now: deps.now ?? (() => new Date()) });
}
