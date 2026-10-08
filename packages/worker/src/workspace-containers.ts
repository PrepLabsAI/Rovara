import { request } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import { workspaceProcessScope, type WorkspaceProcessScope } from "./workspace-processes.js";

/**
 * Before a push token exists, every container other than the worker's own is removed (stopped and deleted).
 *
 * On EC2 workers, when a project has no dev container, the coding step currently runs with the worker's Docker access
 * (boot.sh gives the worker container the host's Docker, to run dev containers), and stopping the worker's processes
 * (workspace-processes.ts) does not reach a container. The instance serves this one workspace, and boot.sh starts exactly one container,
 * the worker (`agentx-worker`). So the only container allowed to stay is the worker's own, known by its container ID
 * as the worker itself reads it from /proc (never by a name or label, which any container can copy). Everything else
 * goes: the workspace's dev containers (the devcontainer CLI labels each with `devcontainer.local_folder`, the
 * repository folder in this workspace, and finds or recreates it on the next `devcontainer up`) and any other container,
 * running or stopped (a stopped one can be restarted).
 *
 * Fails closed (RUNTIME_UNAVAILABLE), so nothing is pushed, when the socket is mounted but Docker does not answer, when
 * the worker cannot tell which container is its own, or when a container cannot be removed. Outside the worker
 * container (a developer machine, tests) it does nothing: the containers there are not the worker's to remove. In the
 * worker container without a Docker socket (no dev container support), it logs that it skipped.
 */

/** The devcontainer CLI's label for the folder a dev container was started for. */
export const WORKSPACE_FOLDER_LABEL = "devcontainer.local_folder";
export const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface DockerContainer {
  id: string;
  names: string[];
  labels: Record<string, string>;
  state: string;
}

export interface DockerApi {
  /** Every container, stopped ones included. */
  listContainers(): Promise<DockerContainer[]>;
  /** Stops (SIGKILL) and deletes a container; one already gone counts as removed. */
  removeContainer(id: string): Promise<void>;
}

export interface SweepWorkspaceContainersOptions {
  rootPath: string;
  scope?: WorkspaceProcessScope;
  /** Test seams. */
  docker?: DockerApi;
  socketMounted?: () => Promise<boolean>;
  selfContainerId?: () => Promise<string | undefined>;
  log?: (event: Record<string, unknown>) => void;
  rounds?: number;
}

/** The containers to remove: all but the worker's own, each marked when the devcontainer CLI started it for this workspace. */
export function containersToRemove(
  containers: readonly DockerContainer[],
  input: { selfId: string; rootPath: string },
): Array<DockerContainer & { workspace: boolean }> {
  const root = resolve(input.rootPath);
  return containers.filter((entry) => entry.id !== input.selfId).map((entry) => {
    const folder = entry.labels[WORKSPACE_FOLDER_LABEL];
    const fromRoot = folder === undefined ? ".." : relative(root, resolve(folder));
    return { ...entry, workspace: fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot)) };
  });
}

/**
 * Removes every container but the worker's own, then lists again until none is left: a container may start another as
 * it is removed. Returns how many it removed.
 */
export async function sweepWorkspaceContainers(options: SweepWorkspaceContainersOptions): Promise<{ removed: number }> {
  const scope = options.scope ?? workspaceProcessScope();
  const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify({ component: "worker", ...event })));
  if (scope !== "container") return { removed: 0 };
  if (!(await (options.socketMounted ?? (() => socketMounted(DOCKER_SOCKET_PATH)))())) {
    log({ event: "publish.containers.skipped", reason: "no Docker socket is mounted in the worker container" });
    return { removed: 0 };
  }
  const docker = options.docker ?? dockerSocketApi(DOCKER_SOCKET_PATH);
  const selfId = await (options.selfContainerId ?? ownContainerId)().catch(() => undefined);
  if (selfId === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not identify its own container in Docker, so it could not check for containers left from the workspace and did not push");
  }
  const rounds = options.rounds ?? 6;
  let removed = 0;
  for (let round = 0; round < rounds; round += 1) {
    let containers: DockerContainer[];
    try {
      containers = await docker.listContainers();
    } catch (error) {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not reach Docker to check for containers left from the workspace, so it did not push: ${errorMessage(error)}`.slice(0, 512));
    }
    if (!containers.some((entry) => entry.id === selfId)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not find its own container in Docker's list, so it did not push");
    }
    const found = containersToRemove(containers, { selfId, rootPath: options.rootPath });
    if (found.length === 0) return { removed };
    for (const entry of found) {
      try {
        await docker.removeContainer(entry.id);
      } catch (error) {
        const name = entry.names[0]?.replace(/^\//u, "") ?? entry.id.slice(0, 12);
        throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not remove the container ${name} left from the workspace (${errorMessage(error)}), so it did not push`.slice(0, 512));
      }
    }
    removed += found.length;
    log({
      event: "publish.containers.removed",
      workspace: found.filter((entry) => entry.workspace).length,
      other: found.filter((entry) => !entry.workspace).length,
      containers: found.map((entry) => ({ id: entry.id.slice(0, 12), name: entry.names[0], state: entry.state })),
    });
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX kept finding new containers started from the workspace, so it did not push");
}

/**
 * The worker's own container ID: Docker bind-mounts the container's resolv.conf, hostname and hosts files from
 * `<data root>/containers/<ID>/`, which /proc/self/mountinfo shows; a cgroup v1 host also names it in /proc/self/cgroup.
 * Undefined unless exactly one ID is found.
 */
export function containerIdFromProcFiles(files: { mountinfo: string; cgroup: string }): string | undefined {
  const ids = new Set<string>();
  for (const line of files.mountinfo.split("\n")) {
    // Field 4 is the mount's root within its filesystem.
    const root = line.split(" ")[3];
    const match = root === undefined ? null : /\/containers\/([0-9a-f]{64})\/(?:resolv\.conf|hostname|hosts)$/u.exec(root);
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  if (ids.size === 0) {
    for (const match of files.cgroup.matchAll(/\/docker[/-]([0-9a-f]{64})(?:\.scope)?$/gmu)) if (match[1] !== undefined) ids.add(match[1]);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

async function ownContainerId(): Promise<string | undefined> {
  const [mountinfo, cgroup] = await Promise.all([
    readFile("/proc/self/mountinfo", "utf8").catch(() => ""),
    readFile("/proc/self/cgroup", "utf8").catch(() => ""),
  ]);
  return containerIdFromProcFiles({ mountinfo, cgroup });
}

async function socketMounted(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isSocket() === true;
}

/** Docker's Engine API over its Unix socket. */
export function dockerSocketApi(socketPath: string, timeoutMs = DOCKER_TIMEOUT_MS): DockerApi {
  return {
    async listContainers() {
      const response = await dockerRequest(socketPath, "GET", "/containers/json?all=1", timeoutMs);
      if (response.status !== 200) throw new Error(`Docker answered ${response.status}: ${dockerMessage(response.body)}`);
      const parsed: unknown = JSON.parse(response.body);
      if (!Array.isArray(parsed)) throw new Error("Docker's container list is not a list");
      return parsed.map((entry: unknown) => {
        const value = entry as { Id?: unknown; Names?: unknown; Labels?: unknown; State?: unknown };
        if (typeof value.Id !== "string") throw new Error("Docker listed a container without an ID");
        return {
          id: value.Id,
          names: Array.isArray(value.Names) ? value.Names.filter((name): name is string => typeof name === "string") : [],
          labels: value.Labels !== null && typeof value.Labels === "object"
            ? Object.fromEntries(Object.entries(value.Labels).filter((label): label is [string, string] => typeof label[1] === "string"))
            : {},
          state: typeof value.State === "string" ? value.State : "",
        };
      });
    },
    async removeContainer(id) {
      const response = await dockerRequest(socketPath, "DELETE", `/containers/${encodeURIComponent(id)}?force=1`, timeoutMs);
      if (response.status === 204 || response.status === 200 || response.status === 404) return;
      throw new Error(`Docker answered ${response.status}: ${dockerMessage(response.body)}`);
    },
  };
}

function dockerRequest(socketPath: string, method: string, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request({ socketPath, method, path, headers: { host: "docker" }, timeout: timeoutMs }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          incoming.destroy(new Error("Docker's answer is too large"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("error", reject);
      incoming.on("end", () => resolveRequest({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`Docker did not answer within ${timeoutMs / 1_000} s`)));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function dockerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
  } catch {
    // Not JSON: the body itself.
  }
  return body.slice(0, 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
