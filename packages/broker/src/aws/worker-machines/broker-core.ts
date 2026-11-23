// L1c: the broker's existing session manager, restricted to its own record reads and deleter execution.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MachineError } from "@agentx/contracts";
import type { SessionManager } from "../sessions.js";
import { BROKER_DISPATCH_ONLY_WORDS, BROKER_LIVE_HEALTH_WORDS, type SessionWorkerFleetDependencies } from "./session-worker-machines.js";
import { workspaceCompanyReader } from "./workspace-company.js";

export interface BrokerCoreWorkerMachinesDependencies {
  /** Pass the ec2Sessions already held by broker.ts. No new clients or grants. */
  sessions: Pick<SessionManager, "get" | "deleteSession" | "requestStop">;
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
}

/**
 * L6's CodeModuleDeps.workerMachines piece; codeModules constructs its SessionWorkerFleet.
 * Capabilities: VM isolation; stop marks the session STOPPING for the reaper to end the instance (the volume is KEPT); terminate (a Close) goes through the deleter (instance AND volume); record health only.
 * No start, signing, post, direct EC2 stop or live ping. Every operation checks the workspace META company afresh.
 */
export function brokerCoreWorkerMachines(deps: BrokerCoreWorkerMachinesDependencies): SessionWorkerFleetDependencies {
  const companyOf = workspaceCompanyReader(deps.documentClient, deps.tableName);
  const dispatchOnly = async (): Promise<never> => { throw new MachineError("rejected", BROKER_DISPATCH_ONLY_WORDS); };
  const liveHealthUnavailable = async (): Promise<never> => { throw new MachineError("unavailable", BROKER_LIVE_HEALTH_WORDS); };
  const existingOperation = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch { throw new MachineError("unavailable", "the broker could not read or cancel the worker session"); }
  };
  return {
    brokerOnly: true,
    companyOfWorkspace: (workspaceId) => existingOperation(() => companyOf(workspaceId)),
    sessions: {
      get: (workspaceId) => existingOperation(() => deps.sessions.get(workspaceId)),
      deleteSession: (workspaceId) => existingOperation(() => deps.sessions.deleteSession(workspaceId)),
      requestStop: (workspaceId) => existingOperation(() => deps.sessions.requestStop(workspaceId)),
      ensureSession: dispatchOnly,
      claimStop: dispatchOnly,
      markStopped: dispatchOnly,
    },
    binding: dispatchOnly,
    stopInstance: dispatchOnly,
    sign: dispatchOnly,
    post: dispatchOnly,
    ping: liveHealthUnavailable,
  };
}
