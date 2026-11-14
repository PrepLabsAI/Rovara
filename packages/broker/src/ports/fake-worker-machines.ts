// Port lane W0: a fake worker-machines adapter. Machines are records, "start" makes them ready after a number of health checks, and
// "deliver" records the job. The EC2, local Docker and this-machine adapters replace it, one lane each.
import { randomUUID } from "node:crypto";
import {
  MachineError,
  type DeliveryReceipt,
  type MachineCapabilities,
  type MachineHandle,
  type MachineHealth,
  type MachineSpec,
  type MachineState,
  type WorkerInvocation,
  type WorkerMachines,
} from "@agentx/contracts";

export interface FakeWorkerMachinesOptions {
  /** How many `health` calls a starting machine answers `starting` to before it is `ready`. Default 1. */
  startingChecks?: number;
  capabilities?: Partial<MachineCapabilities>;
  features?: readonly string[];
  now?: () => Date;
}

interface Machine {
  handle: MachineHandle;
  spec: MachineSpec;
  startingChecks: number;
  operations: Map<string, WorkerInvocation>;
  /** Every operation id ever accepted, so a job that finished is not run again by a re-delivery. */
  accepted: Set<string>;
}

export class FakeWorkerMachines implements WorkerMachines {
  readonly capabilities: MachineCapabilities;
  readonly #machines = new Map<string, Machine>();
  readonly #byKey = new Map<string, string>();
  readonly #options: Required<Pick<FakeWorkerMachinesOptions, "startingChecks" | "features">> & { now: () => Date };

  constructor(options: FakeWorkerMachinesOptions = {}) {
    this.capabilities = { isolation: "none", persistentVolume: true, canStop: true, maxConcurrentMachines: null, ...options.capabilities };
    this.#options = { startingChecks: options.startingChecks ?? 1, features: options.features ?? [], now: options.now ?? (() => new Date()) };
  }

  /** The jobs a machine was given, for tests. */
  delivered(machineId: string): WorkerInvocation[] {
    return [...(this.#machines.get(machineId)?.operations.values() ?? [])];
  }

  /** Test helper: the worker finished a job, as its terminal callback would tell the broker. */
  finish(machineId: string, operationId: string): void {
    const machine = this.#machines.get(machineId);
    if (machine === undefined) return;
    machine.operations.delete(operationId);
    if (machine.handle.state === "busy" && machine.operations.size === 0) machine.handle.state = "ready";
  }

  async start(spec: MachineSpec): Promise<MachineHandle> {
    const keyOf = `${spec.companyId}\u0000${spec.machineKey}`;
    const existingId = this.#byKey.get(keyOf);
    const existing = existingId === undefined ? undefined : this.#machines.get(existingId);
    if (existing !== undefined && existing.handle.state !== "terminated") {
      if (existing.handle.state === "stopped" || existing.handle.state === "stopping") this.#set(existing, "starting", this.#options.startingChecks);
      return { ...existing.handle };
    }
    const running = [...this.#machines.values()].filter((machine) => machine.handle.state !== "terminated" && machine.handle.state !== "stopped").length;
    if (this.capabilities.maxConcurrentMachines !== null && running >= this.capabilities.maxConcurrentMachines) {
      throw new MachineError("unavailable", "no capacity for another machine");
    }
    const machine: Machine = {
      handle: { machineId: `m-${randomUUID()}`, machineKey: spec.machineKey, state: "starting" },
      spec: structuredClone(spec),
      startingChecks: this.#options.startingChecks,
      operations: new Map(),
      accepted: new Set(),
    };
    this.#machines.set(machine.handle.machineId, machine);
    this.#byKey.set(keyOf, machine.handle.machineId);
    return { ...machine.handle };
  }

  async stop(machineId: string): Promise<void> {
    const machine = this.#machines.get(machineId);
    if (machine === undefined || machine.handle.state === "terminated") return;
    if (!this.capabilities.canStop) throw new MachineError("rejected", "this adapter cannot stop a machine; terminate it");
    this.#set(machine, "stopped", 0);
  }

  async terminate(machineId: string): Promise<void> {
    const machine = this.#machines.get(machineId);
    if (machine !== undefined) this.#set(machine, "terminated", 0);
  }

  async health(machineId: string): Promise<MachineHealth> {
    const machine = this.#machines.get(machineId);
    const checkedAt = this.#options.now().toISOString();
    if (machine === undefined) return { state: "terminated", activeOperations: 0, features: [], checkedAt };
    if (machine.handle.state === "starting") {
      if (machine.startingChecks > 0) machine.startingChecks -= 1;
      if (machine.startingChecks === 0) machine.handle.state = "ready";
    }
    const ready = machine.handle.state === "ready" || machine.handle.state === "busy";
    return { state: machine.handle.state, activeOperations: ready ? machine.operations.size : 0, features: ready ? this.#options.features : [], checkedAt };
  }

  async deliver(machineId: string, invocation: WorkerInvocation): Promise<DeliveryReceipt> {
    const machine = this.#machines.get(machineId);
    if (machine === undefined || machine.handle.state === "terminated") throw new MachineError("not_found", "no such machine");
    if (machine.handle.state !== "ready" && machine.handle.state !== "busy") throw new MachineError("not_ready", `the machine is ${machine.handle.state}`);
    if (machine.accepted.has(invocation.operationId)) return { duplicate: true };
    machine.accepted.add(invocation.operationId);
    machine.operations.set(invocation.operationId, structuredClone(invocation));
    machine.handle.state = "busy";
    return { duplicate: false };
  }

  #set(machine: Machine, state: MachineState, startingChecks: number): void {
    machine.handle.state = state;
    machine.startingChecks = startingChecks;
    if (state === "stopped" || state === "terminated") machine.operations.clear();
  }
}
