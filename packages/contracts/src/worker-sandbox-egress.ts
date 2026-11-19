// Lane L4-NETG (owner DEC 254zzz77): how an EC2 worker host's task sandboxes and devcontainers reach the internet.
//
//   bridge  (the default): today's behaviour. Sandboxes join the `agentx-task` bridge and devcontainers the default bridge; both are NATed out through the host, so the worker SG's 443 to anywhere is their only wall.
//   gateway: the commands the agent runs (shell, setup, checks, install steps, the dev container's own processes) sit on an INTERNAL Docker network with no default route. Their only way out is the egress gateway the host runs (egress-gateway-source.ts in "host" mode): it answers DNS and forwards
//            HTTPS by name, to public addresses it resolved itself, for the names the install's VPC resolver allows, minus the push-capable registries (sandbox-deny-domains.ts). The host's own Docker is unchanged.
//            The BUILDS are inside the wall too (L4-NETG2, DEC 254zzz90): a dev container's image build (`docker build`: Dockerfile RUN, features' install.sh) and the verifier's end-to-end build commands run on the same network, with the gateway as their only name server; Docker's default
//            bridge and the old agentx-task bridge are walled. NOT covered (residual): the host's OWN pulls and the Docker daemon's own fetches during an image build (`ADD <url>`, a `FROM` address, the dev container CLI's feature downloads), Rovara's own services, and what the install's DNS list allows (S3 buckets, github.com push, a project's additions).
//
// One stack parameter (WorkerSandboxEgress), kept across upgrades and set with `agentx config set workerSandboxEgress gateway|bridge`. The session steps read it from a plain Lambda variable and a launch carries
// AGENTX_SANDBOX_EGRESS=gateway in its boot configuration only for `gateway`; `bridge` adds nothing, so its user data is byte-identical to before.
export const WORKER_SANDBOX_EGRESS_VALUES = ["bridge", "gateway"] as const;
export type WorkerSandboxEgress = (typeof WORKER_SANDBOX_EGRESS_VALUES)[number];
export const WORKER_SANDBOX_EGRESS_DEFAULT: WorkerSandboxEgress = "bridge";
/** The control-plane stack parameter. */
export const WORKER_SANDBOX_EGRESS_PARAMETER = "WorkerSandboxEgress";
/** The Lambda variable the session steps read the setting from. */
export const WORKER_SANDBOX_EGRESS_SETTING_VARIABLE = "ROVARA_WORKER_SANDBOX_EGRESS";
/** The boot configuration variable (boot.sh): exactly `gateway`, absent otherwise. */
export const WORKER_SANDBOX_EGRESS_BOOT_VARIABLE = "AGENTX_SANDBOX_EGRESS";

/** Whether this install's workers wall their sandboxes behind the gateway: only exactly `gateway`. Unset, `bridge` and anything else (a typo) is the old behaviour, which the operator can see and fix. */
export function workerSandboxEgressGateway(env: Record<string, string | undefined>): boolean {
  return env[WORKER_SANDBOX_EGRESS_SETTING_VARIABLE] === "gateway";
}

/**
 * The prepare invocation's `egressS3Allow` (L4-NETG follow-up, DEC 254zzz90): the exact S3 host names among the project's allowed websites, which the worker publishes for the host's egress gateway so those hosts (and only those) are lifted from the
 * sandbox S3 deny. Sent only to a worker that lists this feature, and only when the list is not empty; a prepare without the field clears whatever an earlier one published.
 */
export const PREPARE_EGRESS_S3_FEATURE = "prepare.egressS3.v1" as const;
