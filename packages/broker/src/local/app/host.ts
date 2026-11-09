// Lane L9-wire: the task flow's side of a session's stop, retry and message (L6b's `SessionControlHost`). Each runs only after the sessions module checked who is asking.
import { change, when } from "@agentx/contracts";
import type { SessionControlHost } from "../../core/sessions/control.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationKey, workspaceKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "../../core/task-flow/records.js";
import { recordOperationResult } from "../../core/task-flow/results.js";
import { blockTaskWorkflow } from "../../core/task-flow/stage-machine.js";
import { iso } from "../../core/task-flow/support.js";
import { retryBlockedStep } from "./retry.js";

/** A person may message a session this many times an hour, and a task keeps this many messages: a live message can mean paid model work. */
export const MESSAGES_PER_HOUR = 20;
export const MESSAGES_PER_TASK = 200;

export const MESSAGE_NOT_PASSED_ON = "Rovara does not pass messages to a running step on this computer yet. Your message is saved on the session.";
export const MESSAGE_RATE_LIMITED = "You have sent a lot of messages to this task in the last hour. Wait a little, then try again.";

export function createSessionControlHost(deps: TaskFlowDeps): SessionControlHost {
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
      await retryBlockedStep(deps, taskId);
    },

    async deliverMessage(taskId, message) {
      const at = iso(deps);
      const hour = at.slice(0, 13);
      const counter = { pk: `DEVTASK#${taskId}`, sk: `MESSAGE_RATE#${hour}` };
      // The count and the message are one write, so two messages racing cannot both pass the last slot.
      const total = { pk: `DEVTASK#${taskId}`, sk: "MESSAGE_TOTAL" };
      const counted = await deps.store.transact([
        { kind: "update", key: counter, ops: [change.add("count", 1), change.setIfAbsent("expiresAt", Math.floor(Date.parse(at) / 1000) + 7_200)], condition: when.or(when.notExists("count"), when.lt("count", MESSAGES_PER_HOUR)) },
        { kind: "update", key: total, ops: [change.add("count", 1)], condition: when.or(when.notExists("count"), when.lt("count", MESSAGES_PER_TASK)) },
        { kind: "put", item: { pk: `DEVTASK#${taskId}`, sk: `MESSAGE#${at}#${message.messageId}`, entityType: "TASK_MESSAGE", messageId: message.messageId, text: message.text, createdAt: at }, condition: when.absent() },
      ]);
      if (!counted.applied) {
        // A repeat of a message already saved is not a new message.
        const saved = await deps.store.get({ pk: `DEVTASK#${taskId}`, sk: `MESSAGE#${at}#${message.messageId}` });
        if (saved === undefined) return { state: "not_delivered" as const, reason: MESSAGE_RATE_LIMITED };
      }
      return { state: "not_delivered" as const, reason: MESSAGE_NOT_PASSED_ON };
    },
  };
}

