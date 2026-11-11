// Port lane L4b: the walls around one local worker. Three Docker networks and two helper containers per worker machine.
//
//   worker network   (--internal, no host address): the worker, the Docker socket guard, and the gateway's inner side
//   sandbox network  (--internal, no host address): the task sandboxes and the gateway's other inner side
//   external network (plain bridge):                the gateway only; the way out to the internet and the published port
//
// An `--internal` network has no route out, and `com.docker.network.bridge.inhibit_ipv4` also takes the host's own address off its
// bridge. Without that option a container on an internal network still reaches every service the host (the VM, on Docker Desktop
// and Colima) has bound to a wildcard address, through the bridge's gateway address. So a container on either inner network can reach
// only the containers on that network. The gateway is the one way out: it is the name server of both inner networks (it answers the
// allow-listed names only) and forwards port 443 by TLS server name and port 80 by Host, to public addresses it checked itself. The
// guard is the only container that holds the Docker socket and lets the worker manage its own task sandboxes only.
import type { DockerResult, DockerRunner } from "../docker-runner.js";
import { MachineError } from "@agentx/contracts";
import { DOCKER_SOCKET_GUARD_SOURCE } from "./docker-socket-guard-source.js";
import { EGRESS_GATEWAY_SOURCE } from "./egress-gateway-source.js";

export const OWNER_LABEL = "rovara.local.owner";
export const HELPER_LABEL = "rovara.local.helper";
export const SANDBOX_LABEL = "rovara.local.sandbox";
export const ISOLATION_CONFIG_LABEL = "rovara.local.isolation";
/** Bumped when the networks or helpers change shape, so a container made by an older build is replaced. */
// 3: the Docker socket guard can serve a project's dev container (an image from a listed registry), and a setup run joins the sandbox network.
export const ISOLATION_VERSION = "3";

export const GATEWAY_INGRESS_PORT = 8080;
export const CALLBACK_RELAY_PORT = 8081;
export const SOCKET_GUARD_PORT = 2375;
export const WORKER_ALIAS = "rovara-worker";
export const BROKER_ALIAS = "rovara-broker";
export const SOCKET_GUARD_ALIAS = "rovara-sock";
const NODE = "/usr/local/bin/node";
const INHIBIT_OPTION = "com.docker.network.bridge.inhibit_ipv4=true";

export interface IsolationNames {
  worker: string;
  gateway: string;
  guard: string;
  workerNet: string;
  sandboxNet: string;
  externalNet: string;
}

export function isolationNames(hash: string): IsolationNames {
  return {
    worker: `rovara-worker-${hash}`,
    gateway: `rovara-gw-${hash}`,
    guard: `rovara-sock-${hash}`,
    workerNet: `rovara-wnet-${hash}`,
    sandboxNet: `rovara-snet-${hash}`,
    externalNet: `rovara-xnet-${hash}`,
  };
}

export interface NetworkInfo {
  subnet: string;
}

export type Run = (args: readonly string[], timeoutMs?: number) => Promise<DockerResult>;

export function dockerRun(docker: DockerRunner): Run {
  return (args, timeoutMs) => docker.run(args, timeoutMs === undefined ? {} : { timeoutMs });
}

const reason = (stderr: string): string => (stderr.trim().split("\n").filter((line) => line.trim() !== "").slice(-1)[0] ?? "no detail").slice(0, 300);
const missing = (stderr: string): boolean => /no such (object|container|network)|not found/i.test(stderr);

/**
 * Makes the three networks, or takes the ones that are there. A network of this name is not trusted: an inner one must be internal
 * and without a host address, the outer one a plain bridge, or it is removed and made again.
 */
export async function ensureNetworks(run: Run, names: IsolationNames, labels: readonly string[]): Promise<{ worker: NetworkInfo; sandbox: NetworkInfo; external: NetworkInfo }> {
  const labelArgs = labels.flatMap((label) => ["--label", label]);
  const one = async (name: string, inner: boolean): Promise<NetworkInfo> => {
    const inspect = async (): Promise<{ ok: boolean; subnet: string }> => {
      const found = await run(["network", "inspect", "--format", "{{.Driver}}|{{.Internal}}|{{index .Options \"com.docker.network.bridge.inhibit_ipv4\"}}|{{.EnableIPv6}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}", name]);
      if (found.exitCode !== 0) {
        if (missing(found.stderr)) return { ok: false, subnet: "" };
        throw new MachineError("unavailable", `Docker did not answer: ${reason(found.stderr)}`);
      }
      const [driver = "", internal = "", inhibit = "", ipv6 = "", subnets = ""] = found.stdout.trim().split("|");
      const subnet = subnets.trim().split(" ").find((entry) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(entry)) ?? "";
      const good = driver === "bridge" && subnet !== "" && ipv6 === "false" && (inner ? internal === "true" && inhibit === "true" : internal === "false");
      return { ok: good, subnet };
    };
    let state = await inspect();
    if (state.ok) return { subnet: state.subnet };
    if (state.subnet !== "") {
      const removed = await run(["network", "rm", name]);
      if (removed.exitCode !== 0 && !missing(removed.stderr)) throw new MachineError("unavailable", `the network ${name} is not as Rovara makes it and could not be removed: ${reason(removed.stderr)}`);
    }
    const created = await run(["network", "create", "--driver", "bridge", "--ipv6=false", ...(inner ? ["--internal", "-o", INHIBIT_OPTION] : []), ...labelArgs, name]);
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      const hint = /pool|overlap/i.test(created.stderr) ? " (Docker has run out of network address ranges; remove unused networks with `docker network prune`)" : /inhibit|unknown|option/i.test(created.stderr) ? " (Docker 23 or newer is needed)" : "";
      throw new MachineError("unavailable", `Docker could not create the network ${name}: ${reason(created.stderr)}${hint}`);
    }
    state = await inspect();
    if (!state.ok) throw new MachineError("unavailable", `the network ${name} is not as Rovara makes it (it must be an internal bridge without a host address)`);
    return { subnet: state.subnet };
  };
  return { worker: await one(names.workerNet, true), sandbox: await one(names.sandboxNet, true), external: await one(names.externalNet, false) };
}

export interface HelperCommon {
  image: string;
  /** The labels every container of this machine carries: the owner, the state folder, the isolation digest. */
  labels: readonly string[];
}

export interface GatewayInput extends HelperCommon {
  names: IsolationNames;
  nets: { worker: NetworkInfo; sandbox: NetworkInfo; external: NetworkInfo };
  allowed: readonly string[];
  workspaceId: string;
  callback: { tcpPort: number; socketDirectory?: string | undefined };
  /** The user the gateway runs as: 1000, or the owner's own on Linux when the callback socket is mounted. */
  user: string;
}

const hardening = ["--sysctl", "net.ipv4.ip_forward=0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--pids-limit", "512", "--memory", "512m"];

export function gatewayConfig(input: GatewayInput): Record<string, unknown> {
  const targets: Array<Record<string, unknown>> = [];
  if (input.callback.socketDirectory !== undefined) targets.push({ unix: "/run/rovara-callback/callback.sock" });
  targets.push({ host: "host.docker.internal", port: input.callback.tcpPort });
  return {
    allowed: input.allowed,
    nets: { worker: input.nets.worker.subnet, sandbox: input.nets.sandbox.subnet, external: input.nets.external.subnet },
    callback: { port: CALLBACK_RELAY_PORT, workspaceId: input.workspaceId, targets, hostHeader: `host.docker.internal:${input.callback.tcpPort}` },
    ingress: { port: GATEWAY_INGRESS_PORT, target: WORKER_ALIAS, targetPort: GATEWAY_INGRESS_PORT },
  };
}

/** Creates (not starts) the gateway on the three networks. */
export async function createGateway(run: Run, input: GatewayInput): Promise<void> {
  const { names } = input;
  const created = await run([
    "create", "--name", names.gateway,
    ...input.labels.flatMap((label) => ["--label", label]),
    "--label", `${HELPER_LABEL}=gateway`,
    "--network", names.externalNet,
    "--publish", `127.0.0.1::${GATEWAY_INGRESS_PORT}`,
    "--add-host", "host.docker.internal:host-gateway",
    ...(input.callback.socketDirectory === undefined ? [] : ["--volume", `${input.callback.socketDirectory}:/run/rovara-callback:ro`]),
    "--user", input.user,
    ...hardening,
    "--env", `ROVARA_GW_CONFIG=${JSON.stringify(gatewayConfig(input))}`,
    "--entrypoint", NODE,
    input.image, "-e", EGRESS_GATEWAY_SOURCE,
  ]);
  if (created.exitCode !== 0) throw new MachineError("unavailable", `Docker could not create the egress gateway: ${reason(created.stderr)}`);
  for (const args of [
    ["network", "connect", "--alias", BROKER_ALIAS, names.workerNet, names.gateway],
    ["network", "connect", names.sandboxNet, names.gateway],
  ]) {
    const connected = await run(args);
    if (connected.exitCode !== 0) throw new MachineError("unavailable", `Docker could not attach the egress gateway to its networks: ${reason(connected.stderr)}`);
  }
}

/**
 * What the guard lets the worker do for test services (docker-socket-guard-services-source.ts says exactly what and what it still refuses). Set only when the owner turned test services on; unset, the guard is the plain
 * one. `images` are the full digest references of the catalog images this install pulled (the only helpers that may start), `guardImage` the worker's own image as a pinned id (the only image the resolver guard runs),
 * `runDirectory` the folder, outside every workspace, that holds the run's own read-only files.
 */
export interface GuardServices {
  images: readonly string[];
  guardImage: string;
  runDirectory: string;
  /** A folder only the guard writes, outside the run folder and never mounted into the worker: where the guard keeps the copies of the run files a service container mounts (see the guard's rule on binds). */
  bindDirectory: string;
  /** The group that owns the Docker socket: a service container never runs in it. */
  socketGroup: number;
  slots?: { first: number; last: number };
  maxNetworks?: number;
  maxContainers?: number;
  maxMemoryMiB?: number;
}

export interface GuardInput extends HelperCommon {
  names: IsolationNames;
  socketPath: string;
  socketGroup: string;
  workspaceDirectory: string;
  workspaceKey: string;
  owner: string;
  /** The gateway's address on the sandbox network: the name server every sandbox is given. */
  sandboxDns: string;
  maxSandboxes?: number;
  /** Test services (see `GuardServices`). Absent: the guard refuses networks, other images and anything that is not a task sandbox, as it always did. */
  services?: GuardServices | undefined;
  /** The registries a project's dev container may pull its image from (lower-case names). Absent or empty: no dev container (the guard refuses every image but the worker's own). */
  devcontainerRegistries?: readonly string[];
}

/** The registries a dev container may pull from when the owner says nothing, on a Docker that runs in a virtual machine (the common dev container images live on these). On a Docker host where a container's root is the host's root there is no default. */
export const DEFAULT_DEVCONTAINER_REGISTRIES: readonly string[] = ["mcr.microsoft.com", "docker.io", "ghcr.io", "public.ecr.aws", "quay.io"];

/** What `docker info` says that tells a virtual machine's daemon from a host's: the security options (rootless) and the operating system's name (Docker Desktop). */
export interface DaemonFacts { operatingSystem?: string | undefined; securityOptions?: readonly string[] | undefined }

/**
 * Whether files a container's root writes into the workspace belong to the person on this computer, so a dev container running as root is no more than the person: a daemon that is rootless, Docker Desktop, or a daemon in a
 * virtual machine that this computer reaches through its own socket (Colima, Docker Desktop on macOS or Windows). Everything else, and anything that cannot be told, is treated as a host where root in a container is root on the computer.
 */
export function daemonIsVmBacked(input: { platform: string; dockerHost: string | undefined; facts: DaemonFacts | undefined }): boolean {
  if (input.facts?.securityOptions?.includes("name=rootless") === true) return true;
  if (input.facts?.operatingSystem !== undefined && /^Docker Desktop/u.test(input.facts.operatingSystem)) return true;
  return (input.platform === "darwin" || input.platform === "win32") && (input.dockerHost === undefined || /^(?:unix|npipe):/u.test(input.dockerHost));
}

/** The owner's list from the environment: `0` or empty is none, otherwise the comma-separated names (a name that is not a plain registry name is left out). */
export function devcontainerRegistriesFrom(value: string): readonly string[] {
  if (value.trim() === "" || value.trim() === "0") return [];
  return [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u.test(entry) && !/^[0-9.]+(?::[0-9]+)?$/u.test(entry) && entry !== "localhost"))];
}

/** What `docker info` says about the daemon on a Linux host, or undefined when it cannot be read (then the daemon is treated as a host's). */
async function readDaemonFacts(docker: DockerRunner): Promise<DaemonFacts | undefined> {
  const answer = await docker.run(["info", "--format", "{{json .SecurityOptions}}|{{.OperatingSystem}}"], { timeoutMs: 15_000 }).catch(() => undefined);
  if (answer === undefined || answer.exitCode !== 0) return undefined;
  const at = answer.stdout.indexOf("|");
  if (at < 0) return undefined;
  try {
    const options: unknown = JSON.parse(answer.stdout.slice(0, at));
    return { securityOptions: Array.isArray(options) ? options.filter((entry): entry is string => typeof entry === "string") : [], operatingSystem: answer.stdout.slice(at + 1).trim() };
  } catch { return undefined; }
}

/** The registries a dev container may pull from on this install: the owner's `ROVARA_DEVCONTAINER_REGISTRIES` when set, else the default list on a virtual machine's daemon and none on a host's. */
export async function devcontainerRegistriesForInstall(environment: NodeJS.ProcessEnv, docker: DockerRunner, platform: string = process.platform): Promise<readonly string[]> {
  const given = environment["ROVARA_DEVCONTAINER_REGISTRIES"];
  if (given !== undefined) return devcontainerRegistriesFrom(given);
  const facts = platform === "linux" ? await readDaemonFacts(docker) : undefined;
  return daemonIsVmBacked({ platform, dockerHost: environment["DOCKER_HOST"], facts }) ? DEFAULT_DEVCONTAINER_REGISTRIES : [];
}

export function guardPolicy(input: GuardInput): Record<string, unknown> {
  return {
    upstream: input.socketPath,
    owner: input.owner,
    image: input.image,
    workspaceDir: input.workspaceDirectory,
    workspaceKey: input.workspaceKey,
    network: input.names.sandboxNet,
    dns: [input.sandboxDns],
    user: "1000:1000",
    port: SOCKET_GUARD_PORT,
    maxSandboxes: input.maxSandboxes ?? 16,
    ...(input.services === undefined ? {} : { services: { images: [...input.services.images], guardImage: input.services.guardImage, runDirectory: input.services.runDirectory, bindDirectory: input.services.bindDirectory, socketGroup: input.services.socketGroup, ...(input.services.slots === undefined ? {} : { slots: input.services.slots }), ...(input.services.maxNetworks === undefined ? {} : { maxNetworks: input.services.maxNetworks }), ...(input.services.maxContainers === undefined ? {} : { maxContainers: input.services.maxContainers }), ...(input.services.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: input.services.maxMemoryMiB }) } }),
    ...(input.devcontainerRegistries === undefined || input.devcontainerRegistries.length === 0 ? {} : { devcontainer: { registries: [...input.devcontainerRegistries] } }),
  };
}

export async function createGuard(run: Run, input: GuardInput): Promise<void> {
  const { names } = input;
  const created = await run([
    "create", "--name", names.guard,
    ...input.labels.flatMap((label) => ["--label", label]),
    "--label", `${HELPER_LABEL}=guard`,
    "--network", names.workerNet, "--network-alias", SOCKET_GUARD_ALIAS,
    "--user", "1000:1000", "--group-add", input.socketGroup,
    ...hardening.map((entry) => (entry === "512m" ? "256m" : entry === "512" ? "256" : entry)),
    "--volume", `${input.socketPath}:${input.socketPath}`,
    // Test services: the run folder is read by the guard (read-only: it copies the files a service container mounts) and the guard's own folder for those copies is written by it alone.
    ...(input.services === undefined ? [] : ["--volume", `${input.services.runDirectory}:${input.services.runDirectory}:ro`, "--volume", `${input.services.bindDirectory}:${input.services.bindDirectory}`]),
    "--env", `ROVARA_SOCK_POLICY=${JSON.stringify(guardPolicy(input))}`,
    "--entrypoint", NODE,
    input.image, "-e", DOCKER_SOCKET_GUARD_SOURCE,
  ]);
  if (created.exitCode !== 0) throw new MachineError("unavailable", `Docker could not create the Docker socket guard: ${reason(created.stderr)}`);
}

export interface GatewayAddresses {
  /** The gateway's address on the worker network (the worker's name server). */
  worker: string;
  /** The gateway's address on the sandbox network (the sandboxes' name server). */
  sandbox: string;
  /** The host port the gateway's ingress is published on (127.0.0.1). */
  hostPort: number | undefined;
}

/** The gateway's addresses, once it is running. Undefined while it has none. */
export async function gatewayAddresses(run: Run, names: IsolationNames): Promise<GatewayAddresses | undefined> {
  const found = await run(["inspect", "--type", "container", "--format", `{{json .NetworkSettings.Networks}}|{{with index .NetworkSettings.Ports "${GATEWAY_INGRESS_PORT}/tcp"}}{{(index . 0).HostPort}}{{end}}`, names.gateway]);
  if (found.exitCode !== 0) {
    if (missing(found.stderr)) return undefined;
    throw new MachineError("unavailable", `Docker did not answer: ${reason(found.stderr)}`);
  }
  const separator = found.stdout.lastIndexOf("|");
  let networks: Record<string, { IPAddress?: string }> = {};
  try {
    networks = JSON.parse(found.stdout.slice(0, separator)) as typeof networks;
  } catch {
    return undefined;
  }
  const worker = networks[names.workerNet]?.IPAddress ?? "";
  const sandbox = networks[names.sandboxNet]?.IPAddress ?? "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(worker) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(sandbox)) return undefined;
  const port = Number.parseInt(found.stdout.slice(separator + 1).trim(), 10);
  return { worker, sandbox, hostPort: Number.isInteger(port) && port > 0 ? port : undefined };
}
