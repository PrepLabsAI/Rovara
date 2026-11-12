// Lane L6a, task flow core: the flow as one object, built from the plug-in registry or from ports given directly.
import {
  IMPLICIT_COMPANY_ID,
  OUTBOX_PENDING_INDEX,
  type AdapterRegistry,
  type IndexDefinition,
  type OrgId,
  type RegistryView,
} from "@agentx/contracts";
import { createTransactionalOutbox } from "../../ports/transactional-outbox.js";
import { createBuildSteps } from "../build-step/index.js";
import { createOwnerTaskAccess } from "./access.js";
import { closeTask } from "./close.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { WORKFLOW_DISPATCH_INDEX } from "./dispatch-rows.js";
import { runDispatchOnce, type DispatchReport } from "./dispatch.js";
import { getTask, listTasks } from "./reads.js";
import { recordOperationResult } from "./results.js";
import type { OperationResult } from "./outcome.js";
import { runDueDispatches } from "./stage-machine.js";
import { sweepLostRuns } from "./run-watch.js";
import { startTask } from "./start.js";
import { WORKSPACE_PROJECT_INDEX } from "@agentx/contracts";

/** The secondary indexes a document store must keep for the flow. The outbox and the dispatch rows need theirs; the by-project index lists workspaces. */
export const TASK_FLOW_INDEXES: readonly IndexDefinition[] = [
  OUTBOX_PENDING_INDEX,
  WORKFLOW_DISPATCH_INDEX,
  { name: WORKSPACE_PROJECT_INDEX.name, partitionAttribute: WORKSPACE_PROJECT_INDEX.partitionKey, sortAttribute: WORKSPACE_PROJECT_INDEX.sortKey, sortType: "string" },
];

export interface TaskFlow {
  readonly deps: TaskFlowDeps;
  start(caller: TaskCaller, request: unknown): ReturnType<typeof startTask>;
  get(caller: TaskCaller, taskId: string): ReturnType<typeof getTask>;
  list(caller: TaskCaller, options?: { limit?: number; cursor?: string }): ReturnType<typeof listTasks>;
  close(caller: TaskCaller, taskId: string): ReturnType<typeof closeTask>;
  /** The callback layer's entry for a worker's terminal result. */
  recordResult(result: OperationResult): ReturnType<typeof recordOperationResult>;
  /** One pass of the dispatch consumer: receives messages and hands their operations to worker machines. */
  dispatchOnce(options?: { maxMessages?: number; waitSeconds?: number }): Promise<DispatchReport>;
  /** One pass of the recovery sweep over due workflow dispatch rows. */
  sweepOnce(options?: { limit?: number }): ReturnType<typeof runDueDispatches>;
  /** One pass of the run-lost watchdog: an operation whose worker machine is lost or unhealthy past the grace period ends INTERRUPTED. */
  sweepRunsOnce(options?: { limit?: number; graceSeconds?: number }): ReturnType<typeof sweepLostRuns>;
  /** Hands pending outbox messages to their queues (call from a timer; a start also relays its own). */
  relayOnce(options?: { limit?: number }): ReturnType<TaskFlowDeps["outbox"]["relay"]>;
}

export function createTaskFlow(deps: TaskFlowDeps): TaskFlow {
  // The steps after the plan are part of the flow: an install that does not give its own gets the build step. (Set on the object given, so every holder of it sees the same flow.)
  deps.buildSteps ??= createBuildSteps();
  for (const index of TASK_FLOW_INDEXES) {
    const kept = deps.store.indexes.find((candidate) => candidate.name === index.name);
    if (kept === undefined || kept.partitionAttribute !== index.partitionAttribute || kept.sortAttribute !== index.sortAttribute) throw new Error(`the document store must keep the ${index.name} index`);
  }
  if (Buffer.byteLength(deps.callbackSigningKey) < 32) throw new Error("the callback signing key must be at least 32 bytes");
  return {
    deps,
    start: (caller, request) => startTask(deps, caller, request),
    get: (caller, taskId) => getTask(deps, caller, taskId),
    list: (caller, options) => listTasks(deps, caller, options),
    close: (caller, taskId) => closeTask(deps, caller, taskId),
    recordResult: (result) => recordOperationResult(deps, result),
    dispatchOnce: (options) => runDispatchOnce(deps, options),
    sweepOnce: (options) => runDueDispatches(deps, options),
    sweepRunsOnce: (options) => sweepLostRuns(deps, options),
    relayOnce: (options) => deps.outbox.relay({ companyId: deps.companyId, ...(options?.limit === undefined ? {} : { limit: options.limit }) }),
  };
}

export type RegistryTaskFlowOptions = Omit<TaskFlowDeps, "store" | "queues" | "outbox" | "machines" | "admission" | "audit" | "access" | "companyId" | "codeHosts"> & {
  companyId?: OrgId;
  access?: TaskFlowDeps["access"];
  /** The `worker-machines` adapter to use when several are registered (the point holds many). Absent: the only one. */
  machinesName?: string;
  /** Refuse a start whose repository names a code host nobody registered. Default true; an install with no code host adapter at all (a laptop before one is set up) turns it off. */
  checkCodeHosts?: boolean;
};

/**
 * The flow over what the registry holds: the one `storage`, `queue`, `worker-machines`, `admission` and `audit-sink` adapter, and the code hosts
 * it registered. The outbox is built over the store and the queues. A registry that lacks one of the points throws, naming it.
 */
export function createTaskFlowFromRegistry(registry: AdapterRegistry | RegistryView, options: RegistryTaskFlowOptions): TaskFlow {
  const { machinesName, checkCodeHosts, ...rest } = options;
  const store = registry.require("storage");
  const queues = registry.require("queue");
  return createTaskFlow({
    ...rest,
    companyId: options.companyId ?? IMPLICIT_COMPANY_ID,
    store,
    queues,
    outbox: createTransactionalOutbox({ store, queues, ...(options.now === undefined ? {} : { now: options.now }) }),
    machines: registry.require("worker-machines", machinesName),
    admission: registry.require("admission"),
    audit: registry.require("audit-sink"),
    access: options.access ?? createOwnerTaskAccess(),
    ...(checkCodeHosts === false ? {} : { codeHosts: registry }),
  });
}
