import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import { DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY } from "./devcontainer-policy.js";

/**
 * What the worker keeps on the workspace volume that is not the project's: its manifest, conversation index,
 * operation journal and check history (`.agentx`) and Pi's saved transcripts (`agent-sessions`). The worker reads these
 * as its own state. Task code runs as the same user in a container that mounts the workspace, so each task container
 * hides them behind an empty mount, or code could forge what the worker then trusts.
 */
export const WORKER_STATE_DIRECTORIES = [".agentx", "agent-sessions"] as const;

/**
 * The folders of the workspace volume a task container must not see, as absolute paths: the worker's state (each made a
 * real directory of the worker's, mode 0700, so a task cannot create or replace it) and the folders the boot script owns
 * (hidden where they exist: Docker's data root and the verifier's runtime). A root that does not exist has nothing to hide.
 * `uid` is the worker's user, a test seam.
 */
export async function hiddenWorkspaceDirectories(rootPath: string, options: { uid?: number } = {}): Promise<string[]> {
  const root = resolve(rootPath);
  if ((await stat(root).catch(() => undefined))?.isDirectory() !== true) return [];
  const uid = options.uid ?? process.getuid?.();
  const hidden: string[] = [];
  for (const name of WORKER_STATE_DIRECTORIES) {
    const path = join(root, name);
    await ensurePrivateDirectory(path, uid);
    hidden.push(path);
  }
  for (const name of [DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY]) {
    const path = join(root, name);
    if ((await stat(path).catch(() => undefined))?.isDirectory() === true) hidden.push(path);
  }
  return hidden;
}

/**
 * A real directory, owned by the worker, mode 0700. A symbolic link or a file that an older volume (or a task) left in its
 * place is removed (a link itself, never its target) and the directory made again; a directory another user owns is
 * refused, since the worker can neither trust nor take it over; one with a looser mode is made private.
 */
async function ensurePrivateDirectory(path: string, uid: number | undefined): Promise<void> {
  const found = await lstat(path).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  });
  if (found !== undefined && (found.isSymbolicLink() || !found.isDirectory())) {
    await rm(path, { force: true });
  } else if (found !== undefined) {
    if (uid !== undefined && found.uid !== uid) {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX did not start the task container: ${path} in the workspace is not owned by the worker, so it cannot be kept from the task`);
    }
    if ((found.mode & 0o777) !== 0o700) await chmod(path, 0o700);
    return;
  }
  await mkdir(path, { mode: 0o700 });
}

/** Name prefixes of the empty volumes a dev container's start mounts over the worker's own folders (devcontainer.ts). */
export const MASK_VOLUME_PREFIXES = ["agentx-mask-", "agentx-docker-data-mask-"] as const;

/** The name an older worker gave the one volume it mounted over Docker's data folder, shared by every container. */
const FIXED_MASK_VOLUME = "agentx-docker-data-mask";

/** Whether `name` is one of those volumes: a prefix, the folder's name and the start's own 12 hex digits, or the older fixed name. */
export function isMaskVolumeName(name: string): boolean {
  return name === FIXED_MASK_VOLUME || (MASK_VOLUME_PREFIXES.some((prefix) => name.startsWith(prefix)) && /-[0-9a-f]{12}$/u.test(name));
}
