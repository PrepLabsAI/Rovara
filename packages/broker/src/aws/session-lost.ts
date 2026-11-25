// WORKER-DELIVERY-IDENTITY step 0: one way to end a READY session whose machine is gone, `markSessionLost`: the conditional READY to STOPPED, then the workspace's active operation failed with fixed words.
// The reconciler (every 10 minutes, and now in the same run that terminates an unresponsive worker) and the instance state-change handler (seconds after EC2 says the instance is stopping, shutting down
// or terminated) call it. The dispatcher's machine check (before a POST) does the first half itself (`markLost`, machine-check.ts) and ends the delivery's own operation through the outbox
// (`failOperation`, machine-check-aws.ts), which for a cancel also fails the workspace's active operation (the task the cancel targets). So a stale READY row never outlives the machine by more than the
// time it takes to run one of them.
import type { WorkspaceSession } from "@agentx/contracts";
import type { SessionManager } from "./sessions.js";

/** The words a running operation is failed with when its worker's machine is lost. Fixed: nothing from EC2 or the worker is part of them. */
export const COMPUTE_LOST_WORDS = "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request";

/** The part of a READY session the conditional `markLost` holds to: it changes the row only while it is still this workspace's session of this generation, on this instance. */
export type LostMachine = Pick<WorkspaceSession, "workspaceId" | "generation" | "instanceId">;

export interface SessionLostPorts {
  sessions: Pick<SessionManager, "markLost">;
  /** Fails the workspace's active operation and releases it; returns the operation ID, if any (outbox-failure.ts `failActiveOperation`). */
  failActiveOperation: (workspaceId: string, error: string) => Promise<string | undefined>;
}

export type SessionLoss = { marked: false } | { marked: true; failedOperationId: string | undefined };

/**
 * READY to STOPPED for the instance seen, then the active operation is failed with the fixed words. `marked: false` when the row had already moved on (another repair, a new generation, a stop
 * claim): nothing is failed then, because whoever moved it owns what happens to its operation.
 */
export async function markSessionLost(ports: SessionLostPorts, seen: LostMachine): Promise<SessionLoss> {
  if (!(await ports.sessions.markLost(seen))) return { marked: false };
  return { marked: true, failedOperationId: await ports.failActiveOperation(seen.workspaceId, COMPUTE_LOST_WORDS) };
}
