import { release as osRelease } from "node:os";

/**
 * HARDEN-C I-4 (DRIFTFAILFAST). A browser and API runtime is qualified on one machine, and its registration records that machine's operating system (the platform and kernel
 * release, for example `linux 6.18.54-121.166.amzn2023.aarch64`) and architecture. The broker verifies every round against that record, so a round run after the kernel changed
 * is UNKNOWN whatever it did. This is the worker's half of the answer: it compares its own host with the admitted runtime before it builds anything, and refuses the round at
 * its start with a fixed code instead of spending a full run to read UNKNOWN.
 *
 * Only the operating system and the architecture are compared. The node version in the record is the executor container's, which this process does not run in.
 */
export type RunnerHostEnvironment = Readonly<{ os: string; arch: string }>;

/** This host's environment, in the words the qualification records it: `<platform> <kernel release>`. The container shares the kernel, so its report says the same. */
export function runnerHostEnvironment(platform: string = process.platform, arch: string = process.arch, release: () => string = osRelease): RunnerHostEnvironment {
  return { os: `${platform} ${release()}`, arch };
}

/**
 * Whether this host is not the one the runtime was admitted on. Fails closed: a probe that cannot answer, or an admitted record that does not say, is drift.
 */
export function runnerEnvironmentDrifted(probe: () => RunnerHostEnvironment, admitted: Readonly<{ os?: unknown; arch?: unknown }> | undefined): boolean {
  if (admitted === undefined || typeof admitted.os !== "string" || typeof admitted.arch !== "string") return true;
  try {
    const host = probe();
    return host.os !== admitted.os || host.arch !== admitted.arch;
  } catch {
    return true;
  }
}
