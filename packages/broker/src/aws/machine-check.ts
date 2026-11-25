// WORKER-DELIVERY-IDENTITY (b-plus): before the dispatcher POSTs anything to a worker, it asks EC2 whether the machine at the row's address is still the row's machine.
//
// A worker's address is a private IP, and nothing in the HTTP exchange proves who answers at it. A READY row can outlive its instance (host failure, a manual terminate, a shutdown from inside),
// and EC2 may hand the freed address to another workspace's new machine. The body of an invocation carries things that can act (a nine hour callback capability, a repository grant), so it must
// never go to a machine that is not the row's. The check is: the row's instance (by id) is `running`, still holds the row's private IP, and carries the row's workspace tag. Anything else is "machine
// gone": NOTHING is sent, no retry goes to that address, the row is marked lost (the same conditional READY to STOPPED the reconciler makes) and the caller ends the operation with the fixed words.
// A question EC2 could not answer (an error, a throttle) is not "gone": it is a retryable refusal, and nothing is sent then either.
//
// The check runs immediately before the POST (after the token is signed), so the gap between the answer and the send is about a hundred milliseconds, far below the minutes a new machine needs to
// boot and listen on the address. It trusts EC2's answer and its tags, not the machine; the per-machine key (plan item (a)) is the boundary for that and is a separate lane.
//
// This module is AWS-free: the EC2 reader and the row marker are given (machine-check-aws.ts wires the dispatcher's).
import { agentXError } from "@agentx/contracts";
import type { LostMachine } from "./session-lost.js";

/** The tag the provisioner puts on a workspace's instance (and volume): which workspace owns the machine. The reconciler reads the same one. */
export const WORKSPACE_TAG = "agentx:workspace";

/** What an operation is failed with when its machine is gone before a delivery: the reconciler's own fixed words (session-lost.ts). */
export { COMPUTE_LOST_WORDS as MACHINE_GONE_WORDS } from "./session-lost.js";

/** The words of a delivery that could not check its machine with EC2: fixed, nothing from the SDK. The message is retried; nothing was sent. */
export const MACHINE_CHECK_UNAVAILABLE_WORDS = "could not check the worker's machine with EC2; nothing was sent";

export interface MachineToCheck {
  /** "workspace": a workspace session's worker. "project-setup": the shared setup runtime (its session row is a ProjectSetupSession). */
  kind: "workspace" | "project-setup";
  /** The workspace the machine serves; for a project setup run the transport correlation id (the invocation's workspace id), which no EC2 tag carries. */
  workspaceId: string;
  generation: number;
  /** The READY row's instance. Always present on a workspace row. On a project setup row it is present when its runtime catalog row was registered with one (WDI-SETUP). */
  instanceId?: string | undefined;
  privateIp: string;
  /** Project setup only: the session row to mark lost. */
  setupExecutionId?: string | undefined;
  /**
   * The subnets the machine may be in: a workspace session's own subnet, a setup runtime's binding subnets. A private address is unique only within its VPC, and EC2 answers for an instance of any VPC
   * of the account, so an instance with the right id and the same address in ANOTHER VPC is not the machine the dispatcher's POST reaches. Empty: nothing can be proved, so the machine is refused.
   */
  subnetIds: readonly string[];
}

/** `markedLost`: whether THIS call moved the row (false when it had already moved on, or there was no row to move): whoever ends the operation must not touch what another path now owns. */
export type MachineVerdict = { ok: true } | { ok: false; markedLost: boolean };

/**
 * Resolves `{ ok: true }` when the machine is the row's machine (or the kind is not checkable yet). Resolves `{ ok: false }` when it is gone: the row has been marked lost and the event logged; the caller
 * sends nothing and ends the operation. Rejects (a fixed-words RUNTIME_UNAVAILABLE) only when EC2 could not be asked: nothing was sent, the caller's retry may try again.
 */
export type MachineVerifier = (machine: MachineToCheck) => Promise<MachineVerdict>;

export interface InstanceFact {
  instanceId: string;
  /** EC2's instance state name. */
  state: string;
  privateIp?: string | undefined;
  /** The subnet the instance is in. */
  subnetId?: string | undefined;
  /** The instance's `agentx:workspace` tag. */
  workspaceId?: string | undefined;
}

export interface MachineReader {
  /** The instance with this id; undefined when EC2 knows none (it forgets a terminated one after about an hour). Rejects when EC2 cannot be asked. */
  byInstanceId(instanceId: string): Promise<InstanceFact | undefined>;
  /** The pending or running instances that hold this private IP now. Used only to say who holds an address in the log: a failure is an empty answer. */
  byPrivateIp(privateIp: string): Promise<InstanceFact[]>;
}

export type MachineGoneReason = "no_instance_id" | "not_found" | "not_running" | "address_changed" | "subnet_mismatch" | "workspace_tag";

/** Why the instance is not the row's machine, or undefined when it is. The order is the order the questions are asked in. */
export function machineMismatch(machine: MachineToCheck, found: InstanceFact | undefined): MachineGoneReason | undefined {
  if (found === undefined) return "not_found";
  if (found.state !== "running") return "not_running";
  if (found.privateIp !== machine.privateIp) return "address_changed";
  if (found.subnetId === undefined || !machine.subnetIds.includes(found.subnetId)) return "subnet_mismatch";
  if (found.workspaceId !== expectedWorkspaceTag(machine)) return "workspace_tag";
  return undefined;
}

/**
 * The `agentx:workspace` tag the machine must carry: its workspace's for a workspace session. The shared setup runtime serves no workspace, so it must carry NONE: an instance holding the setup
 * runtime's address that is some workspace's worker is exactly the machine a setup body must never reach.
 */
function expectedWorkspaceTag(machine: MachineToCheck): string | undefined {
  return machine.kind === "workspace" ? machine.workspaceId : undefined;
}

/**
 * The day grace for a project setup session with no instance id ends (WDI-SETUP). Such a row can only come from a runtime catalog row registered before the install tooling named the instance (every
 * row registered since carries one: registration refuses without), and those rows expire within seven days of their registration, so grace ends by itself well before this; the date is the backstop
 * that makes it end even for a row somebody kept alive. After it a setup run without an instance id is refused like a workspace row without one. Recorded in DEFERRED-CHECKS.
 */
export const SETUP_UNVERIFIED_GRACE_ENDS_AT_MS = Date.parse("2026-12-09T00:00:00.000Z");

export interface MachineVerifierDependencies {
  reader: MachineReader;
  /** Epoch milliseconds, for the grace date. */
  now?: () => number;
  /** The reconciler's conditional READY to STOPPED, for the instance the row names (SessionManager.markLost). */
  markLost: (seen: LostMachine) => Promise<boolean>;
  /** The same for a project setup session (markProjectSetupSessionLost). Absent: a gone setup machine is refused and logged, and its row is left. */
  markSetupLost?: (seen: { setupExecutionId: string; generation: number; instanceId: string }) => Promise<boolean>;
  /** One JSON line per event; fixed fields only (ids, addresses, a reason). */
  log: (entry: Record<string, unknown>) => void;
}

export function createMachineVerifier(dependencies: MachineVerifierDependencies): MachineVerifier {
  const { reader, log } = dependencies;
  return async (machine) => {
    // GRACE, not refusal (WDI-SETUP decision): a project setup row from a runtime catalog row registered before it could name its instance has nothing to compare, and the catalog row is an administrator-
    // approved record (qualified, expiring within 7 days), not a pool: refusing would stop every setup run, including ones in flight during a release, until an administrator registers the runtime again
    // with its instance. It is allowed and said so in the log every time (`dispatch.machine_unverified`), and ends when the row is renewed with an instance id; a workspace row has no such history and is refused.
    if (machine.kind === "project-setup" && machine.instanceId === undefined && (dependencies.now?.() ?? Date.now()) < SETUP_UNVERIFIED_GRACE_ENDS_AT_MS) {
      log({ level: "warn", event: "dispatch.machine_unverified", reason: "setup_runtime_has_no_instance_id", setupExecutionId: machine.setupExecutionId, privateIp: machine.privateIp });
      return { ok: true };
    }
    const reason = machine.instanceId === undefined ? "no_instance_id" : machineMismatch(machine, await ask(() => reader.byInstanceId(machine.instanceId!), log));
    if (reason === undefined) return { ok: true };
    const holders = machine.instanceId === undefined ? [] : await reader.byPrivateIp(machine.privateIp).catch(() => []);
    const holder = holders.find((instance) => instance.instanceId !== machine.instanceId);
    const marked = machine.instanceId === undefined ? false : await markRowLost(dependencies, machine, machine.instanceId);
    log({
      level: "warn", event: "dispatch.machine_gone", reason, markedLost: marked, kind: machine.kind,
      expectedWorkspaceId: machine.workspaceId, expectedInstanceId: machine.instanceId, privateIp: machine.privateIp,
      ...(holder === undefined ? {} : { heldByInstanceId: holder.instanceId, heldByWorkspaceId: holder.workspaceId }),
    });
    return { ok: false, markedLost: marked };
  };
}

/** The row is changed only for the instance it names (conditional on its state, generation and instance), so a row that already moved on is left alone. */
async function markRowLost(dependencies: MachineVerifierDependencies, machine: MachineToCheck, instanceId: string): Promise<boolean> {
  if (machine.kind === "workspace") return dependencies.markLost({ workspaceId: machine.workspaceId, generation: machine.generation, instanceId });
  if (machine.setupExecutionId === undefined || dependencies.markSetupLost === undefined) return false;
  return dependencies.markSetupLost({ setupExecutionId: machine.setupExecutionId, generation: machine.generation, instanceId });
}

/** One EC2 question; a failure is the retryable refusal with the fixed words (the error's own text may name a resource, so it is not carried). */
async function ask(read: () => Promise<InstanceFact | undefined>, log: (entry: Record<string, unknown>) => void): Promise<InstanceFact | undefined> {
  try {
    return await read();
  } catch (error) {
    log({ level: "warn", event: "dispatch.machine_check_unavailable", errorName: error instanceof Error ? error.name : "unknown" });
    throw agentXError("RUNTIME_UNAVAILABLE", MACHINE_CHECK_UNAVAILABLE_WORDS);
  }
}
