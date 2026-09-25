import type { WorkerAccess, WorkerRefusal } from "@agentx/orchestrator";
import { deterministicUuid } from "./ids.js";
import { NEW_WORKSPACE_MESSAGE, PREPARATION_SLOW_MESSAGE, STILL_PREPARING_MESSAGE, limitMessage, preparationFailedMessage } from "./messages.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

const READY_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);
/** How long a turn waits for mid-turn setup before it answers without the worker. */
export const DEFAULT_WAIT_DEADLINE_MILLISECONDS = 15 * 60 * 1_000;
const CONTINUE = "Do not retry this tool in this turn; answer any part of the request that does not need the worker, and say the coding part did not run.";

export const LIMIT_REFUSAL: WorkerRefusal = {
  status: "WORKSPACE_LIMIT_REACHED",
  message: `No coding work can run in this thread because the workspace limit is reached. AgentX has told the member in the thread and linked their existing threads. ${CONTINUE}`,
};

export function unavailableRefusal(reason: string): WorkerRefusal {
  return { status: "WORKSPACE_UNAVAILABLE", message: `No coding work can run in this thread right now: ${reason}. ${CONTINUE}` };
}

/**
 * Spec 014: a turn's handle on a thread whose compute is not prepared. The first tool that needs
 * the worker prepares it; parallel calls share that one attempt, and its outcome, including a
 * refusal or an error, holds for the rest of the turn. The next Slack message tries again.
 * The wait for setup is bounded, so a slow setup never holds the turn open for good.
 */
export function createLazyWorker(input: {
  api: Pick<ThreadServiceApi, "prepareWorkspace" | "waitForOperation">;
  post: (text: string) => Promise<void>;
  log: ServiceLog;
  eventId: string;
  waitDeadlineMilliseconds?: number;
}): WorkerAccess {
  let ready = false;
  let attempt: Promise<WorkerRefusal | undefined> | undefined;

  async function prepare(): Promise<WorkerRefusal | undefined> {
    if (!input.api.prepareWorkspace) return unavailableRefusal("this Slack service cannot prepare workspaces");
    const result = await input.api.prepareWorkspace(deterministicUuid(`${input.eventId}:prepare`));
    if (result.outcome === "LIMIT_REACHED") {
      input.log("request.limit_reached", { eventId: input.eventId, limit: result.limit, maximum: result.maximum });
      await input.post(limitMessage(result));
      return LIMIT_REFUSAL;
    }
    if (result.outcome === "CLOSED") return unavailableRefusal("this thread's workspace is closed; start a new Slack thread for coding work");
    if (result.status === "PREPARING" && result.operationId) {
      await input.post(result.created ? NEW_WORKSPACE_MESSAGE : STILL_PREPARING_MESSAGE);
      let prepared: { status: string } | "TIMED_OUT";
      try {
        prepared = await withDeadline(
          input.api.waitForOperation(result.workspaceId, result.operationId),
          input.waitDeadlineMilliseconds ?? DEFAULT_WAIT_DEADLINE_MILLISECONDS,
        );
      } catch (error) {
        input.log("workspace.preparation_failed", { eventId: input.eventId, errorName: error instanceof Error ? error.name : "unknown" });
        await input.post(preparationFailedMessage("UNCONFIRMED"));
        return unavailableRefusal("workspace setup could not be confirmed");
      }
      if (prepared === "TIMED_OUT") {
        input.log("workspace.preparation_slow", { eventId: input.eventId });
        await input.post(PREPARATION_SLOW_MESSAGE);
        return unavailableRefusal("workspace setup is taking longer than expected; it continues in the background");
      }
      if (prepared.status !== "SUCCEEDED") {
        input.log("workspace.preparation_failed", { eventId: input.eventId, status: prepared.status });
        await input.post(preparationFailedMessage(prepared.status));
        return unavailableRefusal(`workspace setup ${prepared.status.toLowerCase()}`);
      }
      return undefined;
    }
    if (READY_STATUSES.has(result.status)) return undefined;
    input.log("workspace.unavailable", { eventId: input.eventId, status: result.status });
    return unavailableRefusal(`this thread's workspace is ${result.status}`);
  }

  return {
    prepared: () => ready,
    ensureReady() {
      if (ready) return Promise.resolve(undefined);
      attempt ??= prepare().then((refusal) => {
        if (refusal === undefined) ready = true;
        return refusal;
      });
      return attempt;
    },
  };
}

/**
 * Settles with the wait's answer, or "TIMED_OUT" once the deadline passes. The wait itself is not
 * cancelled; it ends on its own when the operation reaches a terminal status.
 */
async function withDeadline<T>(wait: Promise<T>, milliseconds: number): Promise<T | "TIMED_OUT"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"TIMED_OUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMED_OUT"), milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
