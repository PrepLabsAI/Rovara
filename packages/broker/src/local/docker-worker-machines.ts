// Port lane L4: the local Docker adapter for `WorkerMachines`.
//
// One container per machine key, from the worker image (`environments/base`). It starts the worker the way the EC2 boot script
// does (`packages/worker/ec2/boot.sh`): the worker is the only thing in the container that holds the Docker socket, and it runs a
// task's own commands in separate sandbox containers (`packages/worker/src/task-sandbox.ts`) with no capabilities, no new
// privileges and only the workspace mounted. Differences from EC2, each on purpose:
//   - the worker's port is published on 127.0.0.1 only (a random host port), never on every interface, and the broker reaches it
//     there; EC2 uses host networking inside a private subnet.
//   - the worker container itself drops all capabilities and cannot gain privileges (EC2 runs it with Docker's defaults).
//   - the workspace is a folder under the state directory, mounted at its own path so that the sandbox containers the worker starts
//     through the socket see the same path.
// Invocations go over HTTP with a signed `AgentX-Invoke` token (the worker rejects anything else), and the job's answer comes
// back through the broker's callback API, not through this adapter.
//
// Lane L4b changes the picture above, because the worker and its sandboxes must not reach the owner's computer (isolation/stack.ts):
//   - the worker is on an internal Docker network with no route out. Its published port, its internet and its callbacks to the broker
//     all go through the gateway container of its machine; its Docker calls go to a socket guard that holds the socket instead of it.
//   - the worker no longer mounts the Docker socket, and its sandboxes join a second internal network with the gateway as their name server.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { localAllowedDomains } from "./isolation/allow-list.js";
import {
  BROKER_ALIAS, CALLBACK_RELAY_PORT, GATEWAY_INGRESS_PORT, ISOLATION_CONFIG_LABEL, ISOLATION_VERSION, OWNER_LABEL, SANDBOX_LABEL, SOCKET_GUARD_ALIAS, SOCKET_GUARD_PORT, WORKER_ALIAS,
  createGateway, createGuard, dockerRun, ensureNetworks, gatewayAddresses, isolationNames, type IsolationNames, type Run,
} from "./isolation/stack.js";
import {
  ANSWERED_INVOCATION_KINDS,
  BUILD_SYSTEM_PROFILES_ENV,
  MachineError,
  WORKER_PING_FEATURES_FIELD,
  serializeBuildSystemProfiles,
  type BuildSystemProfile,
  type DeliveryReceipt,
  type MachineCapabilities,
  type MachineHandle,
  type MachineHealth,
  type MachineSpec,
  type MachineState,
  type WorkerInvocation,
  type WorkerMachines,
} from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";
import { type LocalTestServices, localTestServicesDigestPart, testServicesEnvironment } from "./test-services.js";
import type { InvokeSigner } from "./invoke-signer.js";
import { MODEL_PROXY_PREFIX } from "./model-proxy/proxy.js";
import { WORKSPACES_DIRECTORY_NAME, ensurePrivateDirectory } from "./state-directory.js";

/** The worker's port inside its container (environments/base/Dockerfile). */
export const WORKER_CONTAINER_PORT = GATEWAY_INGRESS_PORT;
export const MACHINE_LABEL = "rovara.local.machine";
export const WORKSPACE_ID_LABEL = "rovara.local.workspace";
export const COMPANY_LABEL = "rovara.local.company";
/** Which state folder made the container, so one `rovara up` never counts or stops another's workers. */
export const STATE_LABEL = "rovara.local.state";
/** A digest of what the container was created with (image, environment, callback address); a different one means re-create. */
export const CONFIG_LABEL = "rovara.local.config";
/** A random number given to each container as its session generation, so a token for an earlier container is refused by a later one. */
export const GENERATION_LABEL = "rovara.local.generation";
/** The addresses the gateway had when the worker (and the guard) were made: `<worker network>,<sandbox network>`. A different pair means the worker's name server is stale. */
export const GATEWAY_ADDRESS_LABEL = "rovara.local.gwaddr";
/** The label the worker puts on the sandboxes it starts (`TASK_SANDBOX_WORKSPACE_LABEL`). */
/** The guard's folder for the copies of a worker's run files: next to the run folder, never inside it. */
const bindDirectoryOf = (runDirectory: string): string => `${runDirectory}-binds`;

const SANDBOX_WORKSPACE_LABEL = "agentx.workspace";
const MACHINE_NAME = /^rovara-worker-[0-9a-f]{24}$/;
const MACHINE_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWER_MAX_BYTES = 1_048_576;

/** A JSON body of at most `limit` bytes; anything else (too long, not JSON, an array) reads as an empty answer. */
async function readBoundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (response.body === null) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read().catch(() => ({ done: true as const, value: undefined }))) as { done: boolean; value: Uint8Array | undefined };
    if (done) break;
    size += value?.byteLength ?? 0;
    if (size > limit) { await reader.cancel().catch(() => undefined); return {}; }
    if (value !== undefined) chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

const MAX_INVOCATION_BYTES = 1_048_576;
export const LOCAL_WORKER_IMAGE_BUILD_HINT = "build it from a Rovara checkout: docker build -f environments/base/Dockerfile -t rovara-worker:local .";

/** Where a worker calls the broker's model proxy: its own network's name for the broker (the gateway answers it) plus the proxy's path. */
export const modelProxyWorkerUrl = (): string => `http://${BROKER_ALIAS}:${CALLBACK_RELAY_PORT}${MODEL_PROXY_PREFIX}`;

/** Names the worker sets itself: a spec's environment cannot override them (a project cannot turn on the local shell). */
const RESERVED_ENVIRONMENT = new Set([
  "AGENTX_WORKSPACE_ROOT",
  "AGENTX_WORKSPACE_ID",
  "AGENTX_SESSION_GENERATION",
  "AGENTX_INVOKE_PUBLIC_KEY",
  "AGENTX_CONTROL_PLANE_URL",
  "AGENTX_SANDBOX_IMAGE",
  "AGENTX_TASK_SHELL",
  "AGENTX_SANDBOX_NETWORK",
  // Lane L9a: the model proxy's address is the broker's to set (below). A spec cannot point the worker's model calls elsewhere.
  "AGENTX_MODEL_PROXY_URL",
  // Test services: the broker alone says which registry, catalog environment and run folder the worker uses and which image is its own; a project cannot point them elsewhere.
  "AGENTX_TEST_SERVICES_REGISTRY",
  "AGENTX_TEST_SERVICES_ENV",
  "AGENTX_TEST_SERVICES_RUN_DIR",
  "AGENTX_TEST_SERVICES_EDITION",
  "AGENTX_TEST_SERVICES_MAX_MEM_MIB",
  "AGENTX_TEST_SERVICES_NOT_PULLED",
  "AGENTX_WORKER_IMAGE",
  "AGENTX_RUNTIME",
  "AGENTX_WORKER_PROCESS_SCOPE",
  // Port lane P6 (item B1): the build systems' detector modules are the operator's; a spec (a project) cannot name code for the worker to load.
  BUILD_SYSTEM_PROFILES_ENV,
  "PORT",
  "TMPDIR",
  "DOCKER_HOST",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
]);
/**
 * Lane L9a: the worker holds no model key (it holds a short-lived token for the broker's model proxy), so a spec's environment may not carry one
 * either, nor point a provider's client at another address. The names are the ones the model libraries read.
 */
const MODEL_KEY_ENVIRONMENT = /^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GOOGLE|MISTRAL|COHERE|GROQ|XAI|DEEPSEEK|AZURE_OPENAI)_(API_KEY|AUTH_TOKEN|BASE_URL|API_BASE|ENDPOINT)$/iu;
/** The whole AWS_ family except the two region names, which are not secret and which the setup agent reads (keys, a profile, a credentials file, a web identity or container credential, an endpoint override) and the proxy variables that move a client's traffic. */
const AMBIENT_CLOUD_ENVIRONMENT = /^AWS_(?!(?:DEFAULT_)?REGION$)|^(HTTPS?|ALL|NO)_PROXY$/iu;
/** Names that change how a program loads or where the Docker socket is: the worker holds the socket, so none may come from a spec. */
const RESERVED_ENVIRONMENT_PREFIXES = ["NODE_", "LD_", "DYLD_", "DOCKER_"];
const RESERVED_LABEL_PREFIXES = ["rovara.", "agentx.", "com.docker.", "org.opencontainers."];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface DockerWorkerMachinesOptions {
  /** The worker image to run when a spec names none. */
  image: string;
  /** The state folder; workspaces live in `<stateDirectory>/workspaces/<id>`. */
  stateDirectory: string;
  /**
   * Where the broker's callback listener is (callback-server.ts): its loopback port, and on Linux the folder holding its Unix socket.
   * Read when a machine starts, because the port is not known until the broker listens. The worker itself is only ever told
   * `http://rovara-broker:8081`, an address on its own network that the gateway answers.
   */
  callback: () => { tcpPort: number; socketDirectory?: string | undefined };
  /** Lane L9a: the broker serves the local model proxy on its callback listener; tell the worker where it is (`AGENTX_MODEL_PROXY_URL`). */
  modelProxy?: boolean | undefined;
  /**
   * Port lane P6 (item B1): the profiles of the registered `build-system` adapters (`collectBuildSystemProfiles`), asked each time a machine starts. They go to the worker in `ROVARA_BUILD_SYSTEMS`
   * (never in a job). A change re-creates an idle machine, like any other change of its environment.
   */
  buildSystems?: (() => Promise<readonly BuildSystemProfile[]> | readonly BuildSystemProfile[]) | undefined;
  /** Websites the sandboxes and the worker may reach beyond the default list (the cloud's, without its own network's names). */
  allowedDomains?: readonly string[];
  /**
   * Test services (dependencies on a sealed per-run network): the registry the catalog images were pulled from, the catalog environment, the full references of the images that were pulled (the only helpers the
   * guard lets start) and the run folder. Absent: the worker is not told about test services and the guard is the plain one. A change re-creates an idle machine, like any other change of its configuration.
   */
  testServices?: LocalTestServices | undefined;
  /**
   * More websites for machines that START from now on, read at each start with the name of the project the machine is for: the hosts the owner approved for a setup run of THAT project. A change makes the machine's digest differ, so its next start remakes the machine with the new list
   * (keeping its workspace); a machine that is running is not touched. A name the cloud would refuse is not added (it is left out, never passed on).
   */
  extraAllowedDomains?: (project: string | undefined) => Promise<readonly string[]> | readonly string[];
  /**
   * The registries a project's dev container may pull its image from (the Docker socket guard serves a dev container only from these). Default: none (the install decides, `devcontainerRegistriesForInstall`); an empty list is dev containers off.
   * It is the owner's: it comes from the environment of `rovara up` and never from a project or a task.
   */
  devcontainerRegistries?: readonly string[];
  signer: InvokeSigner;
  docker: DockerRunner;
  /** Most machines running at once. Default 4. */
  maxConcurrentMachines?: number | null;
  /** The Docker socket's path as the Docker daemon sees it. Default `/var/run/docker.sock`. */
  dockerSocketPath?: string;
  /** How long a started worker may take to answer `/ping` before it counts as unhealthy. Default 120 s. */
  startupGraceMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Inspected {
  status: string;
  exitCode: number;
  oomKilled: boolean;
  startedAt: number;
  createdAt: number;
  hostPort: number | undefined;
  workspaceId: string;
  config: string;
  generation: number;
}

function hashOf(companyId: string, machineKey: string, stateKey = ""): string {
  return createHash("sha256").update(stateKey).update("\0").update(companyId).update("\0").update(machineKey).digest("hex");
}

/** The workspace id the worker is booted for: the machine key when it is a UUID, otherwise a UUID derived from company and key. */
export function workspaceIdFor(companyId: string, machineKey: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineKey)) return machineKey.toLowerCase();
  const hex = hashOf(companyId, machineKey).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export class DockerWorkerMachines implements WorkerMachines {
  readonly capabilities: MachineCapabilities;
  readonly #options: DockerWorkerMachinesOptions;
  readonly #workspacesRoot: string;
  readonly #socket: string;
  readonly #stateKey: string;
  readonly #allowed: string[];
  #socketGroup: Promise<string> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DockerWorkerMachinesOptions) {
    this.#options = options;
    this.#workspacesRoot = resolve(options.stateDirectory, WORKSPACES_DIRECTORY_NAME);
    this.#socket = options.dockerSocketPath ?? "/var/run/docker.sock";
    this.#stateKey = createHash("sha256").update(resolve(options.stateDirectory)).digest("hex").slice(0, 16);
    this.#allowed = localAllowedDomains(options.allowedDomains);
    this.capabilities = { isolation: "container", persistentVolume: true, canStop: true, maxConcurrentMachines: options.maxConcurrentMachines === undefined ? 4 : options.maxConcurrentMachines };
  }

  #devcontainerRegistries(): readonly string[] {
    return this.#options.devcontainerRegistries ?? [];
  }

  /** The websites a machine starting now may reach: the install's list and the hosts the owner approved. An approved name the allow-list rules refuse is left out. */
  async #allowedNow(project: string | undefined): Promise<string[]> {
    const extra = (await this.#options.extraAllowedDomains?.(project)) ?? [];
    const accepted = extra.filter((entry) => { try { localAllowedDomains([entry]); return true; } catch { return false; } });
    return accepted.length === 0 ? this.#allowed : localAllowedDomains([...(this.#options.allowedDomains ?? []), ...accepted]);
  }

  /** One start at a time in this process, so the limit on running machines holds and two starts of one key do not race. */
  start(spec: MachineSpec): Promise<MachineHandle> {
    const run = this.#queue.then(() => this.#start(spec));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #start(spec: MachineSpec): Promise<MachineHandle> {
    if (!MACHINE_KEY.test(spec.machineKey)) throw new MachineError("rejected", "a machine key is 1 to 128 letters, digits, dots, hyphens or underscores");
    if (!COMPANY_ID.test(spec.companyId)) throw new MachineError("rejected", "the company id is not valid");
    const hash = hashOf(spec.companyId, spec.machineKey, this.#stateKey).slice(0, 24);
    const name = `rovara-worker-${hash}`;
    const handle = (state: MachineState): MachineHandle => ({ machineId: name, machineKey: spec.machineKey, state });
    const image = spec.image ?? this.#options.image;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(image)) throw new MachineError("rejected", "the worker image reference is not valid");
    const workspaceId = workspaceIdFor(spec.companyId, spec.machineKey);
    const workspaceDirectory = join(this.#workspacesRoot, hash);
    const names = isolationNames(hash);
    const callback = this.#options.callback();
    const buildSystems = this.#options.buildSystems === undefined ? [] : [...(await this.#options.buildSystems())];
    const allowed = await this.#allowedNow(spec.projectName);
    // Test services: the worker is told its own image as a pinned id (the resolver guard may run nothing else), and where its run folder is. The folder is outside every workspace: a sandbox never sees it.
    const services = this.#options.testServices;
    const runDirectory = services === undefined ? undefined : join(services.runDirectoryParent ?? join(resolve(this.#options.stateDirectory), "test-services"), hash);
    const imageId = services === undefined ? undefined : await this.#imageId(image);
    const environment = { ...this.#environment(spec, workspaceDirectory, image, names, buildSystems), ...(services === undefined || runDirectory === undefined || imageId === undefined ? {} : testServicesEnvironment(services, { runDirectory, workerImageId: imageId })) };
    const digest = createHash("sha256").update(JSON.stringify([image, Object.entries(environment).sort(([a], [b]) => (a < b ? -1 : 1)), ISOLATION_VERSION, allowed, this.#devcontainerRegistries(), callback.tcpPort, callback.socketDirectory ?? null, services === undefined ? null : localTestServicesDigestPart(services, imageId)])).digest("hex");
    const run: Run = dockerRun(this.#options.docker);

    const existing = await this.#inspect(name);
    if (existing !== undefined && existing.config === digest) {
      if ((existing.status === "running" || existing.status === "restarting") && (await this.#helpersRunning(names))) return handle("starting");
      if (existing.status !== "running" && existing.status !== "restarting") await this.#requireCapacity();
      if (await this.#wake(names, digest)) return handle("starting");
    }
    if (existing !== undefined) {
      // A worker in the middle of a job is not replaced: the caller retries when it is idle.
      if (existing.status === "running" && existing.hostPort !== undefined && ((await this.#ping(existing.hostPort))?.activeOperations ?? 0) > 0) {
        throw new MachineError("unavailable", "the worker is running a job and was created with another image, environment, website list or broker address; try again when it is idle");
      }
      // It was created for another image, environment or broker address (a restart on a new port): its callbacks would go to the old
      // address. The workspace folder is a bind mount and survives.
      await this.#removeStack(names);
      await this.#removeSandboxes(name);
      await this.#removeServices(name);
    } else {
      // Helpers a failed start left behind would block the names.
      await this.#removeStack(names);
    }
    await this.#requireCapacity();

    const present = await this.#docker(["image", "inspect", "--format", "{{.Id}}", image]);
    if (present.exitCode !== 0) throw new MachineError("unavailable", `the worker image ${image} is not on this machine; ${LOCAL_WORKER_IMAGE_BUILD_HINT}`);

    // The worker (user 1000 in the image) must be able to write here. The workspaces folder is 0700, so no other user reaches it.
    await ensurePrivateDirectory(this.#workspacesRoot);
    await this.#sweepEnvironmentFiles();
    await mkdir(workspaceDirectory, { recursive: true, mode: 0o777 });
    await chmod(workspaceDirectory, 0o777);
    if (runDirectory !== undefined) {
      // The same rule as the workspaces folder: a private parent (0700) so no other user reaches it, and a folder the worker (user 1000) can write.
      await ensurePrivateDirectory(resolve(runDirectory, ".."));
      await mkdir(runDirectory, { recursive: true, mode: 0o777 });
      await chmod(runDirectory, 0o777);
      // The guard's own folder for the copies of the run files: beside the run folder (never inside it), and not mounted into the worker.
      await mkdir(bindDirectoryOf(runDirectory), { recursive: true, mode: 0o777 });
      await chmod(bindDirectoryOf(runDirectory), 0o777);
    }

    const group = await this.#dockerGroup(image);
    const generation = 1 + randomInt(999_999_998);
    const baseLabels = [`${OWNER_LABEL}=${hash}`, `${STATE_LABEL}=${this.#stateKey}`, `${ISOLATION_CONFIG_LABEL}=${digest}`];
    try {
      const nets = await ensureNetworks(run, names, [`${OWNER_LABEL}=${hash}`, `${STATE_LABEL}=${this.#stateKey}`]);
      const useSocket = callback.socketDirectory !== undefined;
      await createGateway(run, {
        image, labels: baseLabels, names, nets, allowed, workspaceId, callback,
        user: useSocket && typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : "1000:1000",
      });
      const gatewayStarted = await this.#docker(["start", names.gateway]);
      if (gatewayStarted.exitCode !== 0) throw new MachineError("unavailable", `Docker could not start the egress gateway: ${this.#reason(gatewayStarted.stderr)}`);
      const addresses = await gatewayAddresses(run, names);
      if (addresses === undefined) throw new MachineError("unavailable", "the egress gateway has no address on the worker networks");
      const gatewayLabel = `${GATEWAY_ADDRESS_LABEL}=${addresses.worker},${addresses.sandbox}`;
      await createGuard(run, {
        image, labels: [...baseLabels, gatewayLabel], names, socketPath: this.#socket, socketGroup: group, workspaceDirectory,
        workspaceKey: createHash("sha256").update(resolve(workspaceDirectory)).digest("hex").slice(0, 16), owner: hash, sandboxDns: addresses.sandbox,
        ...(services === undefined || runDirectory === undefined || imageId === undefined ? {} : { services: { images: services.images, guardImage: imageId, runDirectory, bindDirectory: bindDirectoryOf(runDirectory), socketGroup: Number(group), ...(services.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: services.maxMemoryMiB }) } }),
        devcontainerRegistries: this.#devcontainerRegistries(),
      });
      const guardStarted = await this.#docker(["start", names.guard]);
      if (guardStarted.exitCode !== 0) throw new MachineError("unavailable", `Docker could not start the Docker socket guard: ${this.#reason(guardStarted.stderr)}`);

      const envFile = join(this.#workspacesRoot, `.env-${randomBytes(8).toString("hex")}`);
      await writeFile(envFile, `${Object.entries({ ...environment, AGENTX_SESSION_GENERATION: String(generation) }).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600, flag: "wx" });
      try {
        const resources = spec.resources ?? {};
        const created = await this.#docker([
          "create",
          "--name", name,
          "--label", `${MACHINE_LABEL}=1`,
          "--label", `${STATE_LABEL}=${this.#stateKey}`,
          "--label", `${OWNER_LABEL}=${hash}`,
          "--label", `${WORKSPACE_ID_LABEL}=${workspaceId}`,
          "--label", `${CONFIG_LABEL}=${digest}`,
          "--label", `${GENERATION_LABEL}=${generation}`,
          "--label", gatewayLabel,
          "--label", `${COMPANY_LABEL}=${spec.companyId}`,
          ...Object.entries(spec.labels ?? {}).flatMap(([key, value]) => (/^[a-z][a-z0-9.-]{0,62}$/.test(key) && !RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix)) && /^[ -~]{0,200}$/.test(value) ? ["--label", `${key}=${value}`] : [])),
          "--user", "1000:1000",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "4096",
          ...(resources.memoryMiB === undefined ? [] : ["--memory", `${Math.floor(resources.memoryMiB)}m`]),
          ...(resources.cpu === undefined ? [] : ["--cpus", String(resources.cpu)]),
          // No published port, no Docker socket, no group: the worker is on the internal worker network only. The gateway publishes its port.
          "--network", names.workerNet, "--network-alias", WORKER_ALIAS,
          "--dns", addresses.worker,
          "--env-file", envFile,
          "--volume", `${workspaceDirectory}:${workspaceDirectory}`,
          ...(runDirectory === undefined ? [] : ["--volume", `${runDirectory}:${runDirectory}`]),
          "--log-opt", "max-size=10m",
          "--log-opt", "max-file=3",
          image,
        ]);
        if (created.exitCode !== 0 && !/already in use/i.test(created.stderr)) throw new MachineError("unavailable", `Docker could not create the worker: ${this.#reason(created.stderr)}`);
      } finally {
        await rm(envFile, { force: true });
      }
      const started = await this.#docker(["start", name]);
      if (started.exitCode !== 0) throw new MachineError("unavailable", `Docker could not start the worker: ${this.#reason(started.stderr)}`);
    } catch (error) {
      await this.#removeStack(names).catch(() => undefined);
      throw error;
    }
    return handle("starting");
  }

  /** The worker image's id (`sha256:<64 hex>`), the one form of the image a pinned reference may take for a tag. */
  async #imageId(image: string): Promise<string> {
    const found = await this.#docker(["image", "inspect", "--format", "{{.Id}}", image]);
    const id = found.stdout.trim();
    if (found.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new MachineError("unavailable", `the worker image ${image} is not on this machine; ${LOCAL_WORKER_IMAGE_BUILD_HINT}`);
    return id;
  }

  /** Starts a stopped machine again (guard, gateway, worker). False when the helpers are gone or the gateway came back on other addresses, so the machine must be rebuilt. */
  async #wake(names: IsolationNames, digest: string): Promise<boolean> {
    const listed = await this.#docker(["inspect", "--type", "container", "--format", `{{.Name}}|{{index .Config.Labels "${ISOLATION_CONFIG_LABEL}"}}|{{index .Config.Labels "${GATEWAY_ADDRESS_LABEL}"}}`, names.gateway, names.guard, names.worker]);
    if (listed.exitCode !== 0) return false;
    const rows = listed.stdout.trim().split("\n").map((line) => line.split("|"));
    if (rows.length !== 3 || rows[0]?.[1] !== digest || rows[1]?.[1] !== digest) return false;
    const started = await this.#docker(["start", names.gateway]);
    if (started.exitCode !== 0) return false;
    const addresses = await gatewayAddresses(dockerRun(this.#options.docker), names);
    const recorded = rows[1]?.[2];
    if (addresses === undefined || recorded !== `${addresses.worker},${addresses.sandbox}` || rows[2]?.[2] !== recorded) return false;
    for (const target of [names.guard, names.worker]) {
      const result = await this.#docker(["start", target]);
      if (result.exitCode !== 0) throw new MachineError("unavailable", `Docker could not start the worker: ${this.#reason(result.stderr)}`);
    }
    return true;
  }

  /** Whether the guard and the gateway of a machine are both running. */
  async #helpersRunning(names: IsolationNames): Promise<boolean> {
    const found = await this.#docker(["inspect", "--type", "container", "--format", "{{.State.Status}}", names.gateway, names.guard]);
    return found.exitCode === 0 && found.stdout.trim().split("\n").every((line) => line.trim() === "running") && found.stdout.trim().split("\n").length === 2;
  }

  /** Removes the worker, the gateway and the guard of a machine (a missing one is fine). Networks stay: they are reused by the rebuild. */
  /**
   * Test services only: the service containers a worker made (the guard labels them with this machine's owner label and the class `service`) and the run networks it made, then its run folder. With test services off nothing
   * here runs. A container or network that stays keeps the folder, as for a sandbox that stays.
   */
  async #removeServices(machineId: string): Promise<void> {
    const services = this.#options.testServices;
    if (services === undefined) return;
    const hash = machineId.slice("rovara-worker-".length);
    const containers = await this.#docker(["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${hash}`, "--filter", `label=${SANDBOX_LABEL}=service`]);
    if (containers.exitCode !== 0) throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(containers.stderr)}`);
    const ids = containers.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{12,64}$/.test(line));
    if (ids.length > 0) {
      const removed = await this.#docker(["rm", "--force", "--volumes", ...ids]);
      if (removed.exitCode !== 0 && !/no such (object|container)/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not remove the test service containers: ${this.#reason(removed.stderr)}`);
    }
    const networks = await this.#docker(["network", "ls", "--quiet", "--filter", `label=${OWNER_LABEL}=${hash}`, "--filter", "name=rovara-svc-"]);
    if (networks.exitCode !== 0) throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(networks.stderr)}`);
    for (const id of networks.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{12,64}$/.test(line))) {
      const removed = await this.#docker(["network", "rm", id]);
      if (removed.exitCode !== 0 && !/no such (object|network)|not found/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not remove a test services network: ${this.#reason(removed.stderr)}`);
    }
    if (machineId === `rovara-worker-${hash}`) {
      const folder = join(services.runDirectoryParent ?? join(resolve(this.#options.stateDirectory), "test-services"), hash);
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      await rm(bindDirectoryOf(folder), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #removeStack(names: IsolationNames): Promise<void> {
    const removed = await this.#docker(["rm", "--force", "--volumes", names.worker, names.gateway, names.guard]);
    if (removed.exitCode !== 0 && !/no such (object|container)/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not replace the worker: ${this.#reason(removed.stderr)}`);
  }

  async stop(machineId: string): Promise<void> {
    if (!MACHINE_NAME.test(machineId)) return;
    if ((await this.#inspect(machineId)) === undefined) return;
    const names = isolationNames(machineId.slice("rovara-worker-".length));
    await this.#docker(["stop", "--time", "20", machineId], 60_000);
    // The helpers go after the worker, which may still be answering a callback or a Docker call.
    await this.#docker(["stop", "--time", "5", names.guard, names.gateway], 30_000);
    // After the worker, so a sandbox it started meanwhile goes too.
    await this.#removeSandboxes(machineId).catch(() => undefined);
    await this.#removeServices(machineId).catch(() => undefined);
  }

  async terminate(machineId: string): Promise<void> {
    if (!MACHINE_NAME.test(machineId)) return;
    const names = isolationNames(machineId.slice("rovara-worker-".length));
    await this.#removeStack(names);
    await this.#removeSandboxes(machineId);
    await this.#removeServices(machineId);
    for (const network of [names.workerNet, names.sandboxNet, names.externalNet]) {
      const removed = await this.#docker(["network", "rm", network]);
      // A network that is still in use means a container is still on it; keep the folder, as for a sandbox that stays.
      if (removed.exitCode !== 0 && !/no such (object|network)|not found/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not remove the machine's network: ${this.#reason(removed.stderr)}`);
    }
    try {
      await rm(this.#workspaceDirectory(machineId), { recursive: true, force: true });
    } catch {
      // On a Linux host whose user is not 1000 the files the worker made belong to 1000 and cannot be removed from here.
      throw new MachineError("unavailable", "the worker is gone but its workspace folder could not be removed (files owned by the worker's user); remove it by hand");
    }
  }

  async health(machineId: string): Promise<MachineHealth> {
    const checkedAt = new Date(this.#now()).toISOString();
    const gone: MachineHealth = { state: "terminated", activeOperations: 0, features: [], checkedAt };
    if (!MACHINE_NAME.test(machineId)) return gone;
    let found: Inspected | undefined;
    try {
      found = await this.#inspect(machineId);
    } catch {
      return { state: "unhealthy", activeOperations: 0, features: [], checkedAt, detail: "Docker does not answer" };
    }
    if (found === undefined) return gone;
    const idle = (state: MachineState, detail?: string): MachineHealth => ({ state, activeOperations: 0, features: [], checkedAt, ...(detail === undefined ? {} : { detail }) });
    switch (found.status) {
      case "created":
      case "restarting":
        // A container that never gets going (a failed start left it created) must not read "starting" for ever.
        return this.#now() - (found.status === "created" ? found.createdAt : found.startedAt) < (this.#options.startupGraceMs ?? 120_000) ? idle("starting") : idle("unhealthy", "the worker did not start");
      case "exited":
      case "dead":
        // `docker stop` ends the worker with 0, 143 (SIGTERM) or 137 (SIGKILL after the grace time); anything else is a crash.
        // An out-of-memory kill also exits 137.
        if (found.oomKilled) return idle("unhealthy", "the worker ran out of memory");
        return [0, 137, 143].includes(found.exitCode) ? idle("stopped") : idle("unhealthy", `the worker exited with code ${found.exitCode}`);
      case "running":
        // The worker is useless without its gateway and guard; a stopped one is a crash.
        if (!(await this.#helpersRunning(isolationNames(machineId.slice("rovara-worker-".length))).catch(() => false))) return idle("unhealthy", "a helper container of the worker is not running");
        break;
      default:
        return idle("unhealthy", "the container is paused or in an unknown state");
    }
    const ping = found.hostPort === undefined ? undefined : await this.#ping(found.hostPort);
    if (ping === undefined) {
      const age = this.#now() - found.startedAt;
      return age < (this.#options.startupGraceMs ?? 120_000) ? idle("starting") : idle("unhealthy", "the worker does not answer");
    }
    return { state: ping.activeOperations > 0 ? "busy" : "ready", activeOperations: ping.activeOperations, features: ping.features, checkedAt };
  }

  async deliver(machineId: string, invocation: WorkerInvocation): Promise<DeliveryReceipt> {
    if (!MACHINE_NAME.test(machineId)) throw new MachineError("not_found", "no such machine");
    const found = await this.#inspect(machineId);
    if (found === undefined) throw new MachineError("not_found", "no such machine");
    if (invocation.workspaceId !== found.workspaceId) throw new MachineError("rejected", "the job is for another workspace than this machine's");
    const body = JSON.stringify(invocation);
    if (Buffer.byteLength(body, "utf8") > MAX_INVOCATION_BYTES) throw new MachineError("rejected", "the job is too large for a worker");
    if (found.status !== "running" || found.hostPort === undefined) throw new MachineError("not_ready", `the machine is ${found.status === "running" ? "starting" : found.status}`);
    const ping = await this.#ping(found.hostPort);
    if (ping === undefined) throw new MachineError("not_ready", "the worker does not answer yet");

    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(`http://127.0.0.1:${found.hostPort}/invocations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.#options.signer.authorization(invocation, this.#now(), found.generation) },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new MachineError("unavailable", "the worker could not be reached");
    }
    if (response.status === 401) throw new MachineError("unauthorized", "the worker refused the job's credentials");
    if (response.status === 400 || response.status === 409 || response.status === 413) throw new MachineError("rejected", `the worker refused the job (HTTP ${response.status})`);
    if (!response.ok) throw new MachineError("unavailable", `the worker answered HTTP ${response.status}`);
    // The worker's answer is read at most `ANSWER_MAX_BYTES` (a peek's patch is bounded to 128 KiB by its own schema, a steer answer is a few words): a worker that sends more is not buffered whole.
    const answer = await readBoundedJson(response, ANSWER_MAX_BYTES) as { duplicate?: unknown };
    // A live steer and a peek are answered on this request: the broker reads the answer with the kind's own schema.
    const answered = (ANSWERED_INVOCATION_KINDS as readonly string[]).includes(invocation.kind) && typeof answer === "object" && answer !== null && !Array.isArray(answer);
    return { duplicate: answer.duplicate === true, ...(answered ? { answer: answer } : {}) };
  }

  /** Stops every running worker of this state folder (not another folder's) (what `rovara up` does on Ctrl-C). Volumes are kept. */
  async stopAll(): Promise<number> {
    const listed = await this.#docker(["ps", "--filter", `label=${MACHINE_LABEL}=1`, "--filter", `label=${STATE_LABEL}=${this.#stateKey}`, "--filter", "status=running", "--format", "{{.Names}}"]);
    const names = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((name) => MACHINE_NAME.test(name)) : [];
    for (const name of names) await this.stop(name);
    return names.length;
  }

  // ---- internals ----

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #docker(args: readonly string[], timeoutMs?: number) {
    return this.#options.docker.run(args, timeoutMs === undefined ? {} : { timeoutMs });
  }

  /** A short, secret-free reason from Docker's stderr. */
  #reason(stderr: string): string {
    const line = stderr.trim().split("\n").filter((entry) => entry.trim() !== "").slice(-1)[0] ?? "no detail";
    return line.slice(0, 300);
  }

  #workspaceDirectory(machineId: string): string {
    return join(this.#workspacesRoot, machineId.slice("rovara-worker-".length));
  }

  #environment(spec: MachineSpec, workspaceDirectory: string, image: string, names: IsolationNames, buildSystems: readonly BuildSystemProfile[]): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.environment ?? {})) {
      if (!ENVIRONMENT_NAME.test(key) || RESERVED_ENVIRONMENT.has(key) || MODEL_KEY_ENVIRONMENT.test(key) || AMBIENT_CLOUD_ENVIRONMENT.test(key) || RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new MachineError("rejected", `the environment name ${key.slice(0, 40)} is not allowed`);
      if (/[\r\n\0]/.test(value)) throw new MachineError("rejected", `the environment value of ${key} has a line break`);
      environment[key] = value;
    }
    return {
      ...environment,
      AGENTX_WORKSPACE_ROOT: workspaceDirectory,
      AGENTX_WORKSPACE_ID: workspaceIdFor(spec.companyId, spec.machineKey),
      AGENTX_INVOKE_PUBLIC_KEY: this.#options.signer.publicKey(),
      // The gateway answers this name on the worker's network and relays the worker's own callbacks (and no other request) to the broker.
      AGENTX_CONTROL_PLANE_URL: `http://${BROKER_ALIAS}:${CALLBACK_RELAY_PORT}`,
      // Lane L9a: the broker's model proxy, reached through the same relay. An address, not a secret: the worker asks for its token with its callback
      // capability (`GET /v1/internal/model-access`), and a setup run starts only when this is set (setup-agent-invocation.ts), so its spend is counted.
      ...(this.#options.modelProxy === true ? { AGENTX_MODEL_PROXY_URL: modelProxyWorkerUrl() } : {}),
      ...(buildSystems.length === 0 ? {} : { [BUILD_SYSTEM_PROFILES_ENV]: serializeBuildSystemProfiles(buildSystems) }),
      // The Docker calls go to the guard, which holds the socket; the sandboxes join the sandbox network, which the worker does not make itself.
      DOCKER_HOST: `tcp://${SOCKET_GUARD_ALIAS}:${SOCKET_GUARD_PORT}`,
      AGENTX_SANDBOX_NETWORK: names.sandboxNet,
      // The sandbox image is the worker's own image (task-sandbox.ts). AGENTX_TASK_SHELL is never set: a task's commands run in a sandbox.
      AGENTX_SANDBOX_IMAGE: image,
      PORT: String(WORKER_CONTAINER_PORT),
      TMPDIR: "/tmp",
    };
  }

  async #inspect(name: string): Promise<Inspected | undefined> {
    const label = (key: string): string => `{{index .Config.Labels "${key}"}}`;
    const format = [
      "{{.State.Status}}", "{{.State.ExitCode}}", "{{.State.OOMKilled}}", "{{.State.StartedAt}}", "{{.Created}}",
      "",
      label(WORKSPACE_ID_LABEL), label(CONFIG_LABEL), label(GENERATION_LABEL),
    ].join("|");
    const result = await this.#docker(["inspect", "--type", "container", "--format", format, name]);
    if (result.exitCode !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return undefined;
      throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(result.stderr)}`);
    }
    const [status = "", exitCode = "0", oom = "false", startedAt = "", createdAt = "", hostPort = "", workspaceId = "", config = "", generation = "0"] = result.stdout.trim().split("|");
    // The worker publishes nothing: its port is the gateway's.
    const port = status === "running" ? (await gatewayAddresses(dockerRun(this.#options.docker), isolationNames(name.slice("rovara-worker-".length))).catch(() => undefined))?.hostPort ?? 0 : Number.parseInt(hostPort, 10);
    return {
      status, exitCode: Number.parseInt(exitCode, 10) || 0, oomKilled: oom === "true", startedAt: Date.parse(startedAt) || 0, createdAt: Date.parse(createdAt) || 0,
      hostPort: Number.isInteger(port) && port > 0 ? port : undefined, workspaceId, config, generation: Number.parseInt(generation, 10) || 1,
    };
  }

  async #requireCapacity(): Promise<void> {
    const running = await this.#countRunning();
    const limit = this.capabilities.maxConcurrentMachines;
    if (limit !== null && running >= limit) throw new MachineError("unavailable", `${running} workers are running already (the limit is ${limit}); stop one first`);
  }

  /** Removes environment files a crash left behind (they are deleted right after `docker create`, so any older than a minute is stale). */
  async #sweepEnvironmentFiles(): Promise<void> {
    for (const entry of await readdir(this.#workspacesRoot).catch(() => [] as string[])) {
      if (!entry.startsWith(".env-")) continue;
      const path = join(this.#workspacesRoot, entry);
      const details = await stat(path).catch(() => undefined);
      if (details !== undefined && this.#now() - details.mtimeMs > 60_000) await rm(path, { force: true });
    }
  }

  async #countRunning(): Promise<number> {
    const listed = await this.#docker(["ps", "--quiet", "--filter", `label=${MACHINE_LABEL}=1`, "--filter", `label=${STATE_LABEL}=${this.#stateKey}`, "--filter", "status=running"]);
    if (listed.exitCode !== 0) throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(listed.stderr)}`);
    return listed.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }

  /** The group that owns the Docker socket inside a container, which the worker needs to start its sandboxes (EC2 reads it with `stat`). */
  #dockerGroup(image: string): Promise<string> {
    this.#socketGroup ??= (async () => {
      const probe = await this.#docker(["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "stat", "--volume", `${this.#socket}:${this.#socket}`, image, "-c", "%g", this.#socket]);
      const group = probe.stdout.trim();
      if (probe.exitCode !== 0 || !/^\d{1,10}$/.test(group)) throw new MachineError("unavailable", `could not read the Docker socket's group (${this.#reason(probe.stderr)})`);
      return group;
    })().catch((error: unknown) => {
      this.#socketGroup = undefined;
      throw error;
    });
    return this.#socketGroup;
  }

  /** Removes the task sandboxes a worker started (they carry the workspace label) so no container keeps the workspace folder mounted. */
  async #removeSandboxes(machineId: string): Promise<void> {
    // The guard puts its owner label on every sandbox it creates; the worker cannot set or remove it.
    const listed = await this.#docker(["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${machineId.slice("rovara-worker-".length)}`, "--filter", `label=${SANDBOX_WORKSPACE_LABEL}`]);
    if (listed.exitCode !== 0) throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(listed.stderr)}`);
    const ids = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{12,64}$/.test(line));
    if (ids.length === 0) return;
    const removed = await this.#docker(["rm", "--force", ...ids]);
    // A sandbox that stays keeps the workspace mounted, so the caller must not delete the folder.
    if (removed.exitCode !== 0 && !/no such (object|container)/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not remove the task sandboxes: ${this.#reason(removed.stderr)}`);
  }

  async #ping(port: number): Promise<{ activeOperations: number; features: string[] } | undefined> {
    try {
      const response = await (this.#options.fetch ?? fetch)(`http://127.0.0.1:${port}/ping`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown>;
      const active = typeof body.activeOperations === "number" && Number.isInteger(body.activeOperations) && body.activeOperations >= 0 ? body.activeOperations : 0;
      const features = body[WORKER_PING_FEATURES_FIELD];
      return { activeOperations: active, features: Array.isArray(features) ? features.filter((entry): entry is string => typeof entry === "string") : [] };
    } catch {
      return undefined;
    }
  }
}
