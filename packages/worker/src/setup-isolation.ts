// Whether this worker may run a setup run (SETUP_AGENT), the only mode that puts a sandbox on a `rvbs<slot>` bridge. The setup run's walls are five iptables rules that the EC2 boot's container firewall unit
// (packages/worker/ec2/boot.sh `wall_off_containers`) keeps above its rvb+ rules. On a host whose kernel lacks a module they need (the AMI floats), the unit removes exactly those five again, still starts the
// worker, and the launcher passes `AGENTX_SETUP_ISOLATION=unavailable`. Everything else keeps running; only a setup run is refused, with the one fixed sentence below (no host detail, nothing secret).
//
// Where the fact comes from: only the firewall unit (root) writes it, into a root-owned file under /etc/agentx that neither this container nor a sandbox mounts, and the launcher hands its content in as this
// variable at container start. A task cannot change its worker's environment. Fail closed: on EVERY EC2 worker anything but the exact word "ready" (no variable, an empty or odd value) refuses the run
// (until 2026-11-20 only a "named environment" worker was gated, and Code's boot never sets that, so a worker without the rules started setup runs whose DNS was silently dropped).
// Other runtimes (a developer's machine, tests) have no such launcher and are not gated here.
import { SETUP_RUN_REFUSED_MESSAGES, agentXError } from "@agentx/contracts";

export const SETUP_ISOLATION_ENVIRONMENT = "AGENTX_SETUP_ISOLATION";
export const SETUP_ISOLATION_READY = "ready";
/** The refusal the person sees on the task page: specific, and says nothing ran. */
export const SETUP_ISOLATION_UNAVAILABLE_MESSAGE: string = SETUP_RUN_REFUSED_MESSAGES.isolationUnavailable;

/** True when this worker must refuse a setup run. */
export function setupIsolationUnavailable(environment: NodeJS.ProcessEnv): boolean {
  if (environment["AGENTX_RUNTIME"] !== "ec2") return false;
  return environment[SETUP_ISOLATION_ENVIRONMENT] !== SETUP_ISOLATION_READY;
}

/** Throws the refusal (the same failure shape as the other "this worker cannot run it" refusals: RUNTIME_UNAVAILABLE) before anything is started. */
export function assertSetupIsolation(environment: NodeJS.ProcessEnv): void {
  if (setupIsolationUnavailable(environment)) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_ISOLATION_UNAVAILABLE_MESSAGE);
}
