// Port lane L4: the "this machine" adapter, a stub. It would run the worker beside the broker with no container around it, which
// gives a task's commands the owner's own files and accounts. So it refuses unless the owner switched it on (`rovara up
// --this-machine`), and even then this lane does not build it: every call says so. The seam exists so that the later lane that builds it
// changes one file and the doctor and the CLI already know the name.
import {
  MachineError,
  type DeliveryReceipt,
  type MachineCapabilities,
  type MachineHandle,
  type MachineHealth,
  type WorkerMachines,
} from "@agentx/contracts";

export const THIS_MACHINE_ADAPTER_NAME = "this-machine";

export interface ThisMachineWorkerMachinesOptions {
  /** True only when the owner asked for it by name. Default false. */
  enabled?: boolean;
}

export class ThisMachineWorkerMachines implements WorkerMachines {
  readonly capabilities: MachineCapabilities = { isolation: "none", persistentVolume: true, canStop: false, maxConcurrentMachines: 1 };
  readonly #enabled: boolean;

  constructor(options: ThisMachineWorkerMachinesOptions = {}) {
    this.#enabled = options.enabled === true;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async start(): Promise<MachineHandle> {
    throw this.#refusal();
  }

  async stop(): Promise<void> {
    // `canStop` is false: the port says to refuse, so no caller believes a worker was stopped.
    throw new MachineError("rejected", "this adapter cannot stop a machine; terminate it");
  }

  async terminate(): Promise<void> {}

  async health(): Promise<MachineHealth> {
    return { state: "terminated", activeOperations: 0, features: [], checkedAt: new Date().toISOString() };
  }

  async deliver(): Promise<DeliveryReceipt> {
    throw this.#refusal();
  }

  #refusal(): MachineError {
    return this.#enabled
      ? new MachineError("rejected", "running the worker on this machine is not built yet; use the docker worker machines")
      : new MachineError("rejected", "running the worker on this machine, outside a container, is off; start with `rovara up --this-machine` to allow it (not built yet)");
  }
}
