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
import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MachineError,
  WORKER_PING_FEATURES_FIELD,
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
import type { InvokeSigner } from "./invoke-signer.js";
import { WORKSPACES_DIRECTORY_NAME, ensurePrivateDirectory } from "./state-directory.js";

/** The worker's port inside its container (environments/base/Dockerfile). */
export const WORKER_CONTAINER_PORT = 8080;
export const MACHINE_LABEL = "rovara.local.machine";
export const WORKSPACE_ID_LABEL = "rovara.local.workspace";
export const COMPANY_LABEL = "rovara.local.company";
/** Which state folder made the container, so one `rovara up` never counts or stops another's workers. */
export const STATE_LABEL = "rovara.local.state";
/** A digest of what the container was created with (image, environment, callback address); a different one means re-create. */
export const CONFIG_LABEL = "rovara.local.config";
/** A random number given to each container as its session generation, so a token for an earlier container is refused by a later one. */
export const GENERATION_LABEL = "rovara.local.generation";
/** The label the worker puts on the sandboxes it starts (`TASK_SANDBOX_WORKSPACE_LABEL`). */
const SANDBOX_WORKSPACE_LABEL = "agentx.workspace";
const MACHINE_NAME = /^rovara-worker-[0-9a-f]{24}$/;
const MACHINE_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_INVOCATION_BYTES = 1_048_576;
export const LOCAL_WORKER_IMAGE_BUILD_HINT = "build it from a Rovara checkout: docker build -f environments/base/Dockerfile -t rovara-worker:local .";

/** Names the worker sets itself: a spec's environment cannot override them (a project cannot turn on the local shell). */
const RESERVED_ENVIRONMENT = new Set([
  "AGENTX_WORKSPACE_ROOT",
  "AGENTX_WORKSPACE_ID",
  "AGENTX_SESSION_GENERATION",
  "AGENTX_INVOKE_PUBLIC_KEY",
  "AGENTX_CONTROL_PLANE_URL",
  "AGENTX_SANDBOX_IMAGE",
  "AGENTX_TASK_SHELL",
  "AGENTX_RUNTIME",
  "AGENTX_WORKER_PROCESS_SCOPE",
  "PORT",
  "TMPDIR",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
]);
/** Names that change how a program loads or where the Docker socket is: the worker holds the socket, so none may come from a spec. */
const RESERVED_ENVIRONMENT_PREFIXES = ["NODE_", "LD_", "DYLD_", "DOCKER_"];
const RESERVED_LABEL_PREFIXES = ["rovara.", "agentx.", "com.docker.", "org.opencontainers."];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface DockerWorkerMachinesOptions {
  /** The worker image to run when a spec names none. */
  image: string;
  /** The state folder; workspaces live in `<stateDirectory>/workspaces/<id>`. */
  stateDirectory: string;
  /** Where the worker calls the broker back, as the container sees it (`http://host.docker.internal:<port>`). */
  controlPlaneUrl: string | (() => string);
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
  #socketGroup: Promise<string> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DockerWorkerMachinesOptions) {
    this.#options = options;
    this.#workspacesRoot = resolve(options.stateDirectory, WORKSPACES_DIRECTORY_NAME);
    this.#socket = options.dockerSocketPath ?? "/var/run/docker.sock";
    this.#stateKey = createHash("sha256").update(resolve(options.stateDirectory)).digest("hex").slice(0, 16);
    this.capabilities = { isolation: "container", persistentVolume: true, canStop: true, maxConcurrentMachines: options.maxConcurrentMachines === undefined ? 4 : options.maxConcurrentMachines };
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
    const environment = this.#environment(spec, workspaceDirectory, image);
    const digest = createHash("sha256").update(JSON.stringify([image, Object.entries(environment).sort(([a], [b]) => (a < b ? -1 : 1))])).digest("hex");

    const existing = await this.#inspect(name);
    if (existing !== undefined && existing.config === digest) {
      if (existing.status === "running" || existing.status === "restarting") return handle("starting");
      await this.#requireCapacity();
      const started = await this.#docker(["start", name]);
      if (started.exitCode !== 0) throw new MachineError("unavailable", `Docker could not start the worker: ${this.#reason(started.stderr)}`);
      return handle("starting");
    }
    if (existing !== undefined) {
      // It was created for another image, environment or broker address (a restart on a new port): its callbacks would go to the old
      // address. The workspace folder is a bind mount and survives.
      const removed = await this.#docker(["rm", "--force", name]);
      if (removed.exitCode !== 0 && !/no such (object|container)/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not replace the worker: ${this.#reason(removed.stderr)}`);
      await this.#removeSandboxes(name);
    }
    await this.#requireCapacity();

    const present = await this.#docker(["image", "inspect", "--format", "{{.Id}}", image]);
    if (present.exitCode !== 0) throw new MachineError("unavailable", `the worker image ${image} is not on this machine; ${LOCAL_WORKER_IMAGE_BUILD_HINT}`);

    // The worker (user 1000 in the image) must be able to write here. The workspaces folder is 0700, so no other user reaches it.
    await ensurePrivateDirectory(this.#workspacesRoot);
    await this.#sweepEnvironmentFiles();
    await mkdir(workspaceDirectory, { recursive: true, mode: 0o777 });
    await chmod(workspaceDirectory, 0o777);

    const group = await this.#dockerGroup(image);
    const generation = 1 + randomInt(2_000_000_000);
    const envFile = join(this.#workspacesRoot, `.env-${randomBytes(8).toString("hex")}`);
    await writeFile(envFile, `${Object.entries({ ...environment, AGENTX_SESSION_GENERATION: String(generation) }).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600, flag: "wx" });
    try {
      const resources = spec.resources ?? {};
      const created = await this.#docker([
        "create",
        "--name", name,
        "--label", `${MACHINE_LABEL}=1`,
        "--label", `${STATE_LABEL}=${this.#stateKey}`,
        "--label", `${WORKSPACE_ID_LABEL}=${workspaceId}`,
        "--label", `${CONFIG_LABEL}=${digest}`,
        "--label", `${GENERATION_LABEL}=${generation}`,
        "--label", `${COMPANY_LABEL}=${spec.companyId}`,
        ...Object.entries(spec.labels ?? {}).flatMap(([key, value]) => (/^[a-z][a-z0-9.-]{0,62}$/.test(key) && !RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix)) && /^[ -~]{0,200}$/.test(value) ? ["--label", `${key}=${value}`] : [])),
        "--user", "1000:1000",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "4096",
        ...(resources.memoryMiB === undefined ? [] : ["--memory", `${Math.floor(resources.memoryMiB)}m`]),
        ...(resources.cpu === undefined ? [] : ["--cpus", String(resources.cpu)]),
        "--publish", `127.0.0.1::${WORKER_CONTAINER_PORT}`,
        "--add-host", "host.docker.internal:host-gateway",
        "--env-file", envFile,
        "--volume", `${workspaceDirectory}:${workspaceDirectory}`,
        "--volume", `${this.#socket}:${this.#socket}`,
        "--group-add", group,
        "--log-opt", "max-size=10m",
        "--log-opt", "max-file=3",
        image,
      ]);
      if (created.exitCode !== 0 && !/already in use/i.test(created.stderr)) throw new MachineError("unavailable", `Docker could not create the worker: ${this.#reason(created.stderr)}`);
    } finally {
      await rm(envFile, { force: true });
    }
    const started = await this.#docker(["start", name]);
    if (started.exitCode !== 0) {
      await this.#docker(["rm", "--force", name]);
      throw new MachineError("unavailable", `Docker could not start the worker: ${this.#reason(started.stderr)}`);
    }
    return handle("starting");
  }

  async stop(machineId: string): Promise<void> {
    if (!MACHINE_NAME.test(machineId)) return;
    if ((await this.#inspect(machineId)) === undefined) return;
    await this.#docker(["stop", "--time", "20", machineId], 60_000);
    // After the worker, so a sandbox it started meanwhile goes too.
    await this.#removeSandboxes(machineId).catch(() => undefined);
  }

  async terminate(machineId: string): Promise<void> {
    if (!MACHINE_NAME.test(machineId)) return;
    const removed = await this.#docker(["rm", "--force", "--volumes", machineId]);
    // Keep the folder while a container might still hold it: only a removed (or never existing) container lets it go.
    if (removed.exitCode !== 0 && !/no such (object|container)/i.test(removed.stderr)) throw new MachineError("unavailable", `Docker could not remove the worker: ${this.#reason(removed.stderr)}`);
    await this.#removeSandboxes(machineId);
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
    const answer = (await response.json().catch(() => ({}))) as { duplicate?: unknown };
    return { duplicate: answer.duplicate === true };
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

  #environment(spec: MachineSpec, workspaceDirectory: string, image: string): Record<string, string> {
    const controlPlaneUrl = typeof this.#options.controlPlaneUrl === "function" ? this.#options.controlPlaneUrl() : this.#options.controlPlaneUrl;
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.environment ?? {})) {
      if (!ENVIRONMENT_NAME.test(key) || RESERVED_ENVIRONMENT.has(key) || RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new MachineError("rejected", `the environment name ${key.slice(0, 40)} is not allowed`);
      if (/[\r\n\0]/.test(value)) throw new MachineError("rejected", `the environment value of ${key} has a line break`);
      environment[key] = value;
    }
    return {
      ...environment,
      AGENTX_WORKSPACE_ROOT: workspaceDirectory,
      AGENTX_WORKSPACE_ID: workspaceIdFor(spec.companyId, spec.machineKey),
      AGENTX_INVOKE_PUBLIC_KEY: this.#options.signer.publicKey(),
      AGENTX_CONTROL_PLANE_URL: controlPlaneUrl,
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
      `{{with index .NetworkSettings.Ports "${WORKER_CONTAINER_PORT}/tcp"}}{{(index . 0).HostPort}}{{end}}`,
      label(WORKSPACE_ID_LABEL), label(CONFIG_LABEL), label(GENERATION_LABEL),
    ].join("|");
    const result = await this.#docker(["inspect", "--type", "container", "--format", format, name]);
    if (result.exitCode !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return undefined;
      throw new MachineError("unavailable", `Docker did not answer: ${this.#reason(result.stderr)}`);
    }
    const [status = "", exitCode = "0", oom = "false", startedAt = "", createdAt = "", hostPort = "", workspaceId = "", config = "", generation = "0"] = result.stdout.trim().split("|");
    const port = Number.parseInt(hostPort, 10);
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
    const directory = this.#workspaceDirectory(machineId);
    const key = createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 16);
    const listed = await this.#docker(["ps", "--all", "--quiet", "--filter", `label=${SANDBOX_WORKSPACE_LABEL}=${key}`]);
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
