// TE-F1c (te-f1 design 3.2 item 4): the laptop's evidence about the model-host block.
//
// The block itself is FIX-0518's (#552): the sandbox-only deny list `laptopSandboxDenyList` (isolation/sandbox-model-deny.ts) that the egress gateway applies to the sandbox network, ON by default, off only by the owner's own
// per-project setting. This file only turns what a machine REALLY has into the words a round carries. It reads the machine's own label (`DockerWorkerMachines.sandboxModelHostsOf(machineId)`: `denied`, `allowed`, or undefined when the
// machine cannot say), never a constant and never a setting alone: a machine that cannot say is read as NOT blocked (the weaker claim).
import { laptopSandboxDenyList } from "../isolation/sandbox-model-deny.js";

export type LaptopSandboxModelHosts = "denied" | "allowed" | undefined;

export interface LaptopBlockEvidenceInput {
  readonly blockMode: "by_name" | "none";
  readonly blockList: readonly string[];
  readonly hostSuffixes: readonly string[];
  /** The gateway blocks the Azure suffix itself (a wildcard), so nothing is "not blocked" when the block is on. */
  readonly azureOpenAiNotBlocked: false;
  /** `not_blocked`: the bridge's evidence says "model hosts not blocked on this machine" and never "blocked by name". */
  readonly machineBlock?: "not_blocked";
  readonly observedHosts: readonly unknown[];
}

/** The evidence facts of a laptop round from the machine's own state (`denied` only is a block; `allowed` and undefined, a machine that cannot say, are not). */
export function laptopBlockEvidenceInput(state: LaptopSandboxModelHosts, denyList: readonly string[] = laptopSandboxDenyList()): LaptopBlockEvidenceInput {
  return state === "denied"
    ? { blockMode: "by_name", blockList: denyList.filter((entry) => !entry.startsWith("*.")), hostSuffixes: [], azureOpenAiNotBlocked: false, observedHosts: [] }
    : { blockMode: "none", blockList: [], hostSuffixes: [], azureOpenAiNotBlocked: false, machineBlock: "not_blocked", observedHosts: [] };
}

/** Reads the real state from the machines adapter, then builds the evidence facts. A read that throws is a machine that cannot say. */
export async function laptopBlockEvidenceFor(machines: { sandboxModelHostsOf(machineId: string): Promise<LaptopSandboxModelHosts> }, machineId: string): Promise<LaptopBlockEvidenceInput> {
  let state: LaptopSandboxModelHosts;
  try { state = await machines.sandboxModelHostsOf(machineId); } catch { state = undefined; }
  return laptopBlockEvidenceInput(state);
}
