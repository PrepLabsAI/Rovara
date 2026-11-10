// Lane L9-wire: the task flow's side of a session's stop, retry and message (L6b's `SessionControlHost`). Each runs only after the sessions module checked who is asking.
import { INDEX_EXPIRY_ATTRIBUTE, change, when } from "@agentx/contracts";
import { createSessionControl, type SessionControlHost } from "../../core/sessions/control.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationKey, workspaceKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "../../core/task-flow/records.js";
import { recordOperationResult } from "../../core/task-flow/results.js";
import { blockTaskWorkflow } from "../../core/task-flow/stage-machine.js";
import { iso } from "../../core/task-flow/support.js";
import { retryBlockedStep } from "./retry.js";

/** A person may message a session this many times an hour (a token bucket), and a task keeps this many messages: a live message can mean paid model work. */
export const MESSAGES_PER_HOUR = 20;
export const MESSAGES_PER_TASK = 200;

export const MESSAGE_NOT_PASSED_ON = "Rovara does not pass messages to a running step on this computer yet. Your message is saved on the session.";
export const MESSAGE_RATE_LIMITED = "You have sent a lot of messages to this task in the last hour. Wait a little, then try again.";

export function createSessionControlHost(deps: TaskFlowDeps, options: { expectedRevision?: number } = {}): SessionControlHost {
  return {
    async cancelTask(taskId): Promise<{ nothingRunning: boolean; message?: string }> {
      const task = await readTask(deps, taskId);
      if (task === undefined || task.closedAt !== undefined) return { nothingRunning: true };
      const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(task.workspaceId)));
      if (workspace === undefined || workspace.activeOperationId === null) return { nothingRunning: true };
      const operation = fromDocument<OperationRecord>(await deps.store.get(operationKey(workspace.id, workspace.activeOperationId)));
      if (operation === undefined) return { nothingRunning: true };
      // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own.
      await deps.store.update({
        key: operationKey(workspace.id, operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
        condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
      });
      // The machine keeps its volume; the next step wakes it. A machine that is already gone is the same as one stopped.
      if (workspace.machine !== undefined) await deps.machines.stop(workspace.machine.machineId).catch(() => undefined);
      await recordOperationResult(deps, { workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, status: "CANCELLED" });
      // A workflow step that was stopped has nothing running: it waits for the owner's Retry.
      const workflow = (await readTask(deps, taskId))?.workflow;
      if (workflow !== undefined && (workflow.state === "RUNNING" || workflow.state === "READY")) await blockTaskWorkflow(deps, taskId, workflow.revision, "You stopped this step. Retry to run it again.");
      return { nothingRunning: false };
    },

    async retryWorkflow(taskId) {
      await retryBlockedStep(deps, taskId, options.expectedRevision);
    },

    async deliverMessage(taskId, message) {
      const pk = `DEVTASK#${taskId}`;
      const messageKey = { pk, sk: `MESSAGE#${message.messageId}` };
      const answer = { state: "not_delivered" as const, reason: MESSAGE_NOT_PASSED_ON };
      // A repeat of a message already saved is answered again and not counted.
      if ((await deps.store.get(messageKey)) !== undefined) return answer;
      const bucketKey = { pk, sk: "MESSAGE_BUCKET" };
      const totalKey = { pk, sk: "MESSAGE_TOTAL" };
      // A token bucket: MESSAGES_PER_HOUR messages at most, refilled evenly over the hour (so no burst of twice the limit across an hour boundary). The write is conditioned on the
      // bucket as it was read, so two messages racing cannot both take the last token.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const now = (deps.now?.() ?? new Date()).getTime();
        const bucket = await deps.store.get(bucketKey);
        const tokens = bucket === undefined ? MESSAGES_PER_HOUR : Math.min(MESSAGES_PER_HOUR, Number(bucket["tokens"]) + ((now - Number(bucket["at"])) * MESSAGES_PER_HOUR) / 3_600_000);
        if (!(tokens >= 1)) return { state: "not_delivered" as const, reason: MESSAGE_RATE_LIMITED };
        const counted = await deps.store.transact([
          { kind: "put", item: { ...bucketKey, entityType: "MESSAGE_BUCKET", tokens: tokens - 1, at: now, version: bucket === undefined ? 1 : Number(bucket["version"]) + 1, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + 2 * 3_600 }, condition: bucket === undefined ? when.absent() : when.eq("version", Number(bucket["version"])) },
          { kind: "update", key: totalKey, ops: [change.add("count", 1)], condition: when.or(when.notExists("count"), when.lt("count", MESSAGES_PER_TASK)) },
          // The saved message expires with the rest of a task's short-lived records.
          { kind: "put", item: { ...messageKey, entityType: "TASK_MESSAGE", messageId: message.messageId, text: message.text, createdAt: iso(deps), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + MESSAGE_KEEP_SECONDS }, condition: when.absent() },
        ]);
        if (counted.applied) return answer;
        if ((await deps.store.get(messageKey)) !== undefined) return answer;
      }
      return { state: "not_delivered" as const, reason: MESSAGE_RATE_LIMITED };
    },
  };
}

const MESSAGE_KEEP_SECONDS = 30 * 86_400;

/** The session control (who may stop, retry or message; the request recorded once under its id, with the event and the audit step) over this install's flow. Every route that stops or retries uses this one. */
export function createLocalSessionControl(deps: TaskFlowDeps, options: { expectedRevision?: number } = {}) {
  return createSessionControl({ store: deps.store, audit: deps.audit, host: createSessionControlHost(deps, options), now: deps.now ?? (() => new Date()) });
}
