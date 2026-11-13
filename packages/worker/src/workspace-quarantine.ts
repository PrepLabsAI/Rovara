// FIX-RUNNER-ABORT-JOIN: what the worker does about a command it could not confirm stopped (workspace-safety.ts).
//
//  - A task sandbox is a container the worker can remove: it is killed and removed, and the removal is checked, before the worker takes another task.
//  - A devcontainer persists and a host command is the worker's own child, so neither can be removed here: the workspace is MARKED UNSAFE, in the worker's
//    own state directory (.agentx, which a task container cannot see), and the next task's preparation and file recovery refuse until it is reset.
//    The marker clears itself only when everything it names is verified gone (the sandboxes no longer exist, the host process groups are empty);
//    a devcontainer cannot be verified, so a marker that names one stays until an operator resets the workspace (removes the file after stopping the container).
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import { groupAlive } from "./collected-process.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";
import type { UnconfirmedStop } from "./workspace-safety.js";

const MARKER_DIRECTORY = ".agentx";
const MARKER_NAME = "workspace-unsafe.json";
const DOCKER_CALL_TIMEOUT_MS = 60_000;

export interface QuarantinedSandbox {
  name: string;
  /** True when the container was checked to be gone or not running after the kill and the removal. */
  verified: boolean;
}

export interface UnsafeWorkspaceRecord {
  at: string;
  stops: UnconfirmedStop[];
  sandboxes: QuarantinedSandbox[];
}

export const workspaceUnsafeMarkerPath = (rootPath: string): string => join(resolve(rootPath), MARKER_DIRECTORY, MARKER_NAME);

/** Writes the marker (atomically: a half-written marker is no marker, and that would let the next task in). */
export async function markWorkspaceUnsafeOnDisk(rootPath: string, record: UnsafeWorkspaceRecord): Promise<void> {
  const path = workspaceUnsafeMarkerPath(rootPath);
  await mkdir(join(resolve(rootPath), MARKER_DIRECTORY), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
}

export async function readWorkspaceUnsafeMarker(rootPath: string): Promise<UnsafeWorkspaceRecord | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(workspaceUnsafeMarkerPath(rootPath), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
  try {
    const parsed = JSON.parse(text) as Partial<UnsafeWorkspaceRecord>;
    if (!Array.isArray(parsed.stops) || !Array.isArray(parsed.sandboxes)) return "unreadable";
    return parsed as UnsafeWorkspaceRecord;
  } catch {
    return "unreadable";
  }
}

export interface ResetDependencies {
  docker?: Pick<DockerCli, "run">;
  /** Whether a host process group still has a live member. */
  groupAlive?: (pgid: number) => boolean;
}

const REFUSED = "AgentX did not start: a command of an earlier task could not be confirmed stopped, so it may still be writing this workspace. Reset the workspace (stop what runs in it, then remove its unsafe-stop marker) before the next task";

/**
 * Before a task's preparation or file recovery touches the workspace: refuses while the unsafe-stop marker stands, unless every process it names is now verified gone,
 * in which case the marker is removed. A marker that cannot be read, or that names a devcontainer, is never cleared here.
 */
export async function assertWorkspaceReset(rootPath: string, deps: ResetDependencies = {}): Promise<void> {
  const record = await readWorkspaceUnsafeMarker(rootPath);
  if (record === undefined) return;
  if (record === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
  const kinds = new Set(record.stops.map((stop) => stop.kind));
  if (kinds.has("devcontainer")) throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
  // A sandbox stop is cleared only by sandboxes that exist in the record and are gone now. (A sealed round's sandbox is removed by the round's own teardown, which fails the round when it cannot.)
  if (kinds.has("sandbox") && record.sandboxes.length === 0) throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
  const alive = deps.groupAlive ?? ((pgid: number) => groupAlive(pgid));
  for (const stop of record.stops) {
    if (stop.kind !== "local") continue;
    // A host command whose group is not known cannot be verified.
    if (stop.pgid === undefined || alive(stop.pgid)) throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
  }
  if (record.sandboxes.length > 0) {
    const docker = deps.docker ?? createDockerCli();
    for (const sandbox of record.sandboxes) {
      if (!await containerGone(docker, sandbox.name)) throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
    }
  }
  await rm(workspaceUnsafeMarkerPath(rootPath), { force: true });
}

/** True when `docker inspect` says there is no such container, or that it is not running. */
export async function containerGone(docker: Pick<DockerCli, "run">, name: string): Promise<boolean> {
  const inspected = await docker.run(["inspect", "--type", "container", "--format", "{{.State.Running}}", name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS })
    .catch(() => undefined);
  if (inspected === undefined || inspected.killUnconfirmed === true) return false;
  if (inspected.exitCode === 0) return inspected.stdout.trim() === "false";
  return /no such (object|container)/iu.test(inspected.stderr);
}
