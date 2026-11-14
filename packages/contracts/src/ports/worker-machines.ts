// Port lane W0, port 3: worker machines.
//
// Where a task's worker runs, and how Rovara talks to it. Three adapters are planned and each is one later lane: EC2 (today's
// Cloud path), local Docker (one container per task, running `packages/worker`) and "this machine" (the worker runs beside the
// broker). The port is what the broker does with a machine, in provider-neutral words: start it (or wake it), stop it, ask
// whether it is healthy, and hand it a job. A job is the worker's existing `WorkerInvocation`; the answer to it comes back
// through the broker's callback API (the worker posts its terminal result), not through this port.
import type { WorkerInvocation } from "../protocol.js";
import type { Cost } from "./json.js";

export type MachineState =
  | "starting"
  | "ready"
  | "busy"
  | "stopping"
  | "stopped"
  | "unhealthy"
  /** Gone for good, or never existed. */
  | "terminated";

export interface MachineSpec {
  /**
   * Names the machine for good within its company, for example a workspace id. Starting twice with one key returns the same machine and, if it was
   * stopped, wakes it (with its volume, when the adapter has one).
   */
  machineKey: string;
  companyId: string;
  projectName?: string;
  /** What to run, in the adapter's own words (an image reference, an AMI id). The core only passes it on. */
  image?: string;
  resources?: { cpu?: number; memoryMiB?: number; diskGiB?: number };
  /** Environment for the worker process. Never holds a secret the adapter could fetch for itself. */
  environment?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface MachineHandle {
  machineId: string;
  machineKey: string;
  state: MachineState;
}

export interface MachineHealth {
  state: MachineState;
  /** Jobs the worker is running now (its `/ping` count). */
  activeOperations: number;
  /** The optional invocation features this worker build lists now (its `/ping` list). The broker sends a field only when it is listed. */
  features: readonly string[];
  checkedAt: string;
  /** Short words for a person, never a secret or an address. */
  detail?: string;
}

export interface MachineCapabilities {
  isolation: "vm" | "container" | "none";
  /** A stopped machine keeps its working files. */
  persistentVolume: boolean;
  canStop: boolean;
  /** Most machines at once, or null for no fixed limit. */
  maxConcurrentMachines: number | null;
  /** An estimate of what one machine costs per hour, when the adapter knows (the broker's cost estimate uses it). */
  hourlyCost?: Cost;
}

export type MachineErrorCode =
  /** The machine is not ready for work yet (or any more). Retry after the state changes. */
  | "not_ready"
  /** No such machine. */
  | "not_found"
  /** The worker refused the job's credentials. */
  | "unauthorized"
  /** The worker answered that the job is malformed or too large. Never retried. */
  | "rejected"
  /** The adapter's backend could not be reached or has no capacity. Retry later. */
  | "unavailable";

export class MachineError extends Error {
  constructor(readonly code: MachineErrorCode, message: string) {
    super(message);
    this.name = "MachineError";
  }
  get retryable(): boolean {
    return this.code === "not_ready" || this.code === "unavailable";
  }
}

export interface DeliveryReceipt {
  /** True when the worker had already accepted a job with this `operationId` (it does not run twice). */
  duplicate: boolean;
}

export interface WorkerMachines {
  readonly capabilities: MachineCapabilities;
  /** Idempotent on `machineKey`. Returns without waiting for the machine to be ready; ask `health`. */
  start(spec: MachineSpec): Promise<MachineHandle>;
  /**
   * Stops a machine and keeps its volume if the adapter has one. Idempotent; stopping a stopped or unknown machine is not an error.
   * An adapter with `canStop: false` throws `MachineError` `rejected`: terminate instead.
   */
  stop(machineId: string): Promise<void>;
  /** Destroys a machine and its volume. Idempotent. */
  terminate(machineId: string): Promise<void>;
  /** Never throws for an unknown machine: it answers `terminated`. */
  health(machineId: string): Promise<MachineHealth>;
  /**
   * Hands the machine a job. Idempotent on `invocation.operationId`. Throws `MachineError`: `not_ready` when the machine is not
   * `ready` or `busy`, `not_found`, `unauthorized`, `rejected` or `unavailable`.
   */
  deliver(machineId: string, invocation: WorkerInvocation): Promise<DeliveryReceipt>;
}
