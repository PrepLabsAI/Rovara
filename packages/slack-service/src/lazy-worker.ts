import type { SlackWorkspaceLimit } from "@agentx/contracts";
import type { WorkerAccess, WorkerRefusal } from "@agentx/orchestrator";
import { deterministicUuid } from "./ids.js";
import {
  NEW_WORKSPACE_MESSAGE,
  PREPARATION_SLOW_MESSAGE,
  STILL_PREPARING_MESSAGE,
  WORKSPACE_UNCONFIRMED_MESSAGE,
  limitMessage,
  preparationFailedMessage,
} from "./messages.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

const READY_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);
/** How long a turn waits for mid-turn setup before it answers without the worker. */
export const DEFAULT_WAIT_DEADLINE_MILLISECONDS = 15 * 60 * 1_000;
const CONTINUE = "Do not retry this tool in this turn; answer any part of the request that does not need the worker, and say the coding part did not run.";

/** The member limit links the member's existing threads, which AgentX has already posted. */
export const LIMIT_REFUSAL: WorkerRefusal = {
  status: "WORKSPACE_LIMIT_REACHED",
  message: `No coding work can run in this thread because the workspace limit is reached. AgentX has told the member in the thread and linked their existing threads. ${CONTINUE}`,
};

/** The organization limit links no threads, so its refusal text drops the linked-threads clause. */
export const ORGANIZATION_LIMIT_REFUSAL: WorkerRefusal = {
  status: "WORKSPACE_LIMIT_REACHED",
  message: `No coding work can run in this thread because the workspace limit is reached. AgentX has told the member in the thread. ${CONTINUE}`,
};

function limitRefusal(limit: SlackWorkspaceLimit): WorkerRefusal {
  return limit === "ORGANIZATION" ? ORGANIZATION_LIMIT_REFUSAL : LIMIT_REFUSAL;
}

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
    if (!input.api.prepareWorkspace) {
      input.log("workspace.unavailable", { eventId: input.eventId, reason: "no prepareWorkspace" });
      return unavailableRefusal("this Slack service cannot prepare workspaces");
    }
    let result: Awaited<ReturnType<NonNullable<ThreadServiceApi["prepareWorkspace"]>>>;
    try {
      result = await input.api.prepareWorkspace(deterministicUuid(`${input.eventId}:prepare`));
    } catch (error) {
      input.log("workspace.preparation_failed", { eventId: input.eventId, errorName: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
    if (result.outcome === "LIMIT_REACHED") {
      input.log("request.limit_reached", { eventId: input.eventId, limit: result.limit, maximum: result.maximum });
      await input.post(limitMessage(result));
      return limitRefusal(result.limit);
    }
    if (result.outcome === "CLOSED") return unavailableRefusal("this thread's workspace is closed; start a new Slack thread for coding work");
    // Spec 025 C11: a shared task's thread that stopped taking requests mid-turn. The next message
    // gets the thread's notice from the ensure route.
    if (result.outcome === "VIEW_ONLY") {
      return unavailableRefusal(result.closed ? "the task this thread followed is closed" : "this thread only follows a task a developer is driving from their AI tool");
    }
    if (result.status === "PREPARING" && result.operationId) {
      await input.post(result.created ? NEW_WORKSPACE_MESSAGE : STILL_PREPARING_MESSAGE);
      const controller = new AbortController();
      let prepared: { status: string } | "TIMED_OUT";
      try {
        prepared = await withDeadline(
          input.api.waitForOperation(result.workspaceId, result.operationId, controller.signal),
          input.waitDeadlineMilliseconds ?? DEFAULT_WAIT_DEADLINE_MILLISECONDS,
          controller,
        );
      } catch (error) {
        input.log("workspace.preparation_failed", { eventId: input.eventId, errorName: error instanceof Error ? error.name : "unknown" });
        await input.post(WORKSPACE_UNCONFIRMED_MESSAGE);
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
 * Settles with the wait's answer, or "TIMED_OUT" once the deadline passes. Once the deadline
 * passes, `controller` is aborted so the background poll stops instead of continuing forever.
 */
export async function withDeadline<T>(wait: Promise<T>, milliseconds: number, controller: AbortController): Promise<T | "TIMED_OUT"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"TIMED_OUT">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("TIMED_OUT");
    }, milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
