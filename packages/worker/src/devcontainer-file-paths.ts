import { isAbsolute, posix, resolve } from "node:path";
import type { DevcontainerPaths } from "./devcontainer.js";
import type { DockerCli } from "./swebench/containers.js";

/**
 * Which host folders the devcontainer sees, and where. The file tools run inside the devcontainer (file-ops-exec.ts), but
 * the agent is told to prefer host paths (devcontainerContextFile) and Pi resolves a relative path against the host
 * working folder. So every request path goes host to container here, and every path a result carries goes back.
 */
export interface FileMount {
  hostPath: string;
  containerPath: string;
}

const DOCKER_CALL_TIMEOUT_MS = 60_000;

/**
 * The bind mounts of the devcontainer whose source is the workspace root or under it (the worker sees the workspace at its
 * host path, as the task sandbox's `--volume root:root` already relies on). The repository folder (`paths`) is always
 * among them, whatever `docker inspect` says.
 */
export async function devcontainerMounts(docker: DockerCli, containerId: string, root: string, paths?: DevcontainerPaths): Promise<FileMount[]> {
  const inspected = await docker.run(["inspect", "--format", "{{json .Mounts}}", containerId], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  const mounts: FileMount[] = [];
  if (inspected.exitCode === 0) {
    let listed: unknown;
    try { listed = JSON.parse(inspected.stdout.trim() || "[]"); } catch { listed = []; }
    if (Array.isArray(listed)) {
      for (const entry of listed as unknown[]) {
        const mount = entry as { Type?: unknown; Source?: unknown; Destination?: unknown } | null;
        if (mount?.Type !== "bind" || typeof mount.Source !== "string" || typeof mount.Destination !== "string") continue;
        const source = trimSlash(mount.Source);
        if (!isUnder(source, root)) continue;
        mounts.push({ hostPath: source, containerPath: trimSlash(mount.Destination) });
      }
    }
  }
  if (paths !== undefined && !mounts.some((mount) => mount.hostPath === trimSlash(paths.hostFolder))) {
    mounts.push({ hostPath: trimSlash(paths.hostFolder), containerPath: trimSlash(paths.containerFolder) });
  }
  return mounts;
}

/**
 * `path` (absolute, or relative to `cwd`, the host workspace root) as the same place in the devcontainer, and the mount that
 * contains it, which is the helper's root for the request so its no-follow walk is confined to that mount. A path already
 * under a mount's container folder is kept. Anything else is not mounted.
 */
export function toContainerPath(
  mounts: readonly FileMount[],
  cwd: string,
  path: string,
): { containerPath: string; mountRoot: string } | { notMounted: string } {
  const absolute = isAbsolute(path) ? posix.normalize(path) : resolve(cwd, path);
  const inContainer = longest(mounts, (mount) => mount.containerPath, absolute);
  if (inContainer !== undefined) return { containerPath: absolute, mountRoot: inContainer.containerPath };
  const onHost = longest(mounts, (mount) => mount.hostPath, absolute);
  if (onHost !== undefined) {
    return { containerPath: joinUnder(onHost.containerPath, absolute.slice(onHost.hostPath.length)), mountRoot: onHost.containerPath };
  }
  return { notMounted: absolute };
}

/** A path the helper returned (inside a mount's container folder) as the host path the agent knows; any other path as given. */
export function toHostPath(mounts: readonly FileMount[], containerPath: string): string {
  const mount = longest(mounts, (entry) => entry.containerPath, containerPath);
  return mount === undefined ? containerPath : joinUnder(mount.hostPath, containerPath.slice(mount.containerPath.length));
}

/**
 * What a listing of `path` shows when `path` is a folder above the mounts (the workspace root, say) and no mount holds it:
 * the next folder of each mount below it, so the agent sees `api/` and reads `api/src/a.ts`, which maps. Undefined when
 * `path` is inside a mount, or above none.
 */
export function virtualDirectoryEntries(mounts: readonly FileMount[], path: string): string[] | undefined {
  const folder = trimSlash(posix.normalize(path));
  if (longest(mounts, (mount) => mount.hostPath, folder) !== undefined || longest(mounts, (mount) => mount.containerPath, folder) !== undefined) return undefined;
  const names = new Set<string>();
  for (const mount of mounts) {
    if (!isUnder(mount.hostPath, folder) || mount.hostPath === folder) continue;
    const first = mount.hostPath.slice(folder === "/" ? 1 : folder.length + 1).split("/")[0];
    if (first !== undefined && first !== "") names.add(first);
  }
  return names.size === 0 ? undefined : [...names].sort();
}

/** The copy the agent sees for a path no mount holds. */
export function notMountedMessage(path: string, mounts: readonly FileMount[]): string {
  const folders = mounts.length === 0 ? "no host folders" : mounts.map((mount) => mount.hostPath).join(", ");
  return `${path} isn't in a workspace folder mounted in this devcontainer. The file tools reach only ${folders}; use bash in the devcontainer for other paths, or mount the folder in the project's devcontainer.json.`;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

function longest(mounts: readonly FileMount[], folder: (mount: FileMount) => string, path: string): FileMount | undefined {
  let best: FileMount | undefined;
  for (const mount of mounts) {
    if (!isUnder(path, folder(mount))) continue;
    if (best === undefined || folder(mount).length > folder(best).length) best = mount;
  }
  return best;
}

function joinUnder(folder: string, rest: string): string {
  return rest === "" ? folder : `${folder === "/" ? "" : folder}${rest}`;
}
