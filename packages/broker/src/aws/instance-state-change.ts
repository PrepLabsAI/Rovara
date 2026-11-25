// WORKER-DELIVERY-IDENTITY step 0 (ii): an EC2 instance that is stopping, shutting down or terminated is marked lost within seconds, not at the reconciler's next run (up to 10 minutes later).
//
// An EventBridge rule on "EC2 Instance State-change Notification" calls this. The event carries no tags, so the rule cannot be scoped to our workers; the scope is the lookup: only an instance that a READY
// session in THIS environment's State table names is touched (instance ids are unique, and another environment's or another system's instance has no row here). It does exactly what the reconciler does for a
// READY session whose instance is gone: the conditional READY to STOPPED for that instance, then the active operation failed with the fixed words (session-lost.ts). A session that moved on first (a stop
// claim, a new generation, the reconciler's own repair) is left alone, so a normal stop (the row is STOPPING before the instance ends) and a repeated event do nothing. EventBridge delivery is best effort and a
// failed run is retried by the service; the reconciler stays as the backstop.
import { markSessionLost, type SessionLostPorts } from "./session-lost.js";
import type { SessionManager } from "./sessions.js";

/** The states that end a worker's usefulness. `stopped` is not listed: a worker is terminated, never stopped and restarted (a stop of the session keeps the volume, not the instance). */
export const ENDED_INSTANCE_STATES: ReadonlySet<string> = new Set(["stopping", "shutting-down", "terminated"]);
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/u;

/** The part of EventBridge's "EC2 Instance State-change Notification" this reads; the rest of the envelope (version, id, account, time, region, resources) is carried and ignored. */
export interface InstanceStateChangeEvent {
  [field: string]: unknown;
  source?: unknown;
  "detail-type"?: unknown;
  detail?: { "instance-id"?: unknown; state?: unknown } | undefined;
}

export type InstanceStateChangeOutcome = "ignored" | "no_session" | "already_moved" | "marked_lost";

export interface InstanceStateChangeDependencies extends SessionLostPorts {
  sessions: Pick<SessionManager, "findReadyByInstance" | "markLost">;
  /** The reconciler's metric for a lost instance (its LostInstancesAlarm reads it), so an instance this handler marks first still alarms. */
  emit: (metrics: Record<string, number>) => void;
  log: (entry: Record<string, unknown>) => void;
}

export function createInstanceStateChangeHandler(dependencies: InstanceStateChangeDependencies) {
  return async (event: InstanceStateChangeEvent): Promise<InstanceStateChangeOutcome> => {
    const instanceId = event.detail?.["instance-id"];
    const state = event.detail?.state;
    // Anything but a worker-ending state of a well-formed instance id is not this handler's: the rule already filters, and a hand-sent event is held to the same shape.
    if (event.source !== "aws.ec2" || typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId) || typeof state !== "string" || !ENDED_INSTANCE_STATES.has(state)) return "ignored";
    const session = await dependencies.sessions.findReadyByInstance(instanceId);
    if (session === undefined) return "no_session";
    const loss = await markSessionLost(dependencies, session);
    if (!loss.marked) return "already_moved";
    dependencies.emit({ ReconcilerLostInstances: 1, InstanceStateChangeLost: 1 });
    dependencies.log({ event: "instance_state_change.marked_lost", workspaceId: session.workspaceId, instanceId, state, failedOperationId: loss.failedOperationId });
    return "marked_lost";
  };
}
