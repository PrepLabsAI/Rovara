// Whether this worker may run a setup run (SETUP_AGENT), the only mode that puts a sandbox on a `rvbs<slot>` bridge. The setup run's walls are five iptables rules that the worker's launcher
// (packages/worker/ec2/boot-stage2.sh `block_imds`) adds beside the two metadata rejections. On a host whose kernel lacks a module they need (the AMI floats), the launcher removes them again, still
// starts the worker, and passes `AGENTX_SETUP_ISOLATION=unavailable`. Everything else keeps running; only a setup run is refused, with the one fixed sentence below (no host detail, nothing secret).
//
// Where the fact comes from: only the launcher (root) writes it, into a root-owned file under /etc/agentx that neither this container nor a sandbox mounts, and hands its content in as this variable at
// container start. A task cannot change its worker's environment. Fail closed: on an EC2 named-environment worker anything but the exact word "ready" (no variable, an empty or odd value) refuses the run.
// Other runtimes (a developer's machine, tests) have no such launcher and are not gated here.
import { agentXError } from "@rovara-code/contracts";

export const SETUP_ISOLATION_ENVIRONMENT = "AGENTX_SETUP_ISOLATION";
export const SETUP_ISOLATION_READY = "ready";
/** The refusal the person sees on the task page: specific, and says nothing ran. */
export const SETUP_ISOLATION_UNAVAILABLE_MESSAGE = "setup isolation unavailable on this worker, so AgentX did not run the setup (nothing was run); other tasks are not affected";

/** True when this worker must refuse a setup run. */
export function setupIsolationUnavailable(environment: NodeJS.ProcessEnv): boolean {
  if (environment["AGENTX_RUNTIME"] !== "ec2" || environment["AGENTX_ENVIRONMENT_KIND"] !== "named") return false;
  return environment[SETUP_ISOLATION_ENVIRONMENT] !== SETUP_ISOLATION_READY;
}

/** Throws the refusal (the same failure shape as the other "this worker cannot run it" refusals: RUNTIME_UNAVAILABLE) before anything is started. */
export function assertSetupIsolation(environment: NodeJS.ProcessEnv): void {
  if (setupIsolationUnavailable(environment)) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_ISOLATION_UNAVAILABLE_MESSAGE);
}
