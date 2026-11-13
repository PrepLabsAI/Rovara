import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentXError } from "@rovara-code/contracts";

/**
 * Where the worker keeps scratch of its own: the throwaway Git repositories it reads a candidate with, and the folder that holds a Git credential while one command runs (TF12).
 *
 * On an EC2 worker the temporary directory can be on the workspace volume (`TMPDIR=/mnt/agentx-runtime/tmp`, a bind mount of `.agentx-runtime` on it). Task code runs against that volume
 * (the sandbox and the devcontainer mount it, with the worker's folders hidden behind empty mounts), and anything a task's process leaves running could write there. What matters is that
 * no task container can reach the scratch by any path. The device is the proxy for that: the worker container's own `/tmp` is an overlay file system of its own, and no sandbox or
 * devcontainer mounts it. (Docker's data root, where that overlay is physically stored, is on the workspace volume under `.docker`; it is hidden from every task container by the mask
 * in workspace-state.ts, so the guarantee rests on that mask as well as on the device.)
 *
 * The choice is by device: the first of the temporary directory, `/tmp` and `/var/tmp` whose file system is not the workspace root's. On a machine where the workspace has no volume of its own
 * (a developer's, a test) every candidate shares its device and the temporary directory is used, as it always was. On an EC2 worker, where that cannot be, nothing is made: scratch on
 * the workspace volume is refused. The worker checks this once when it starts (`checkWorkerScratch`) and refuses every task with a clear reason if it fails, so the failure is not
 * first met in the middle of a Git operation.
 */
export const WORKSPACE_ROOT_ENVIRONMENT = "AGENTX_WORKSPACE_ROOT";
const DEFAULT_WORKSPACE_ROOT = "/mnt/workspace";
const FALLBACK_BASES = ["/tmp", "/var/tmp"] as const;

export interface WorkerScratchOptions {
  environment?: NodeJS.ProcessEnv;
}

/** The device a path is on, or undefined when it cannot be read. */
type DeviceProbe = (path: string) => Promise<number | undefined>;

const statDevice: DeviceProbe = async (path) => (await stat(path).catch(() => undefined))?.dev;
let deviceProbe: DeviceProbe = statDevice;
/** Test seam: how the device of a path is read. Returns the undo. */
export function useScratchDeviceProbeForTests(probe: DeviceProbe): () => void {
  const previous = deviceProbe;
  deviceProbe = probe;
  return () => {
    deviceProbe = previous;
  };
}

/** The same two markers as `isEc2WorkerRuntime` (task-sandbox.ts, which this file cannot import without a cycle; a test pins them together). */
export function ec2WorkerRuntime(environment: NodeJS.ProcessEnv): boolean {
  return environment.AGENTX_RUNTIME === "ec2" || environment.AGENTX_WORKER_PROCESS_SCOPE === "container";
}

interface ScratchChoice {
  base: string;
  /** False where the workspace has no volume of its own to keep scratch off (a developer's machine), so the temporary directory is used. */
  offWorkspaceVolume: boolean;
}

async function chooseScratch(options: WorkerScratchOptions): Promise<ScratchChoice> {
  const environment = options.environment ?? process.env;
  const temporary = tmpdir();
  const candidates = [temporary, ...FALLBACK_BASES.filter((base) => base !== temporary)];
  const workspaceDevice = await deviceProbe(environment[WORKSPACE_ROOT_ENVIRONMENT] ?? DEFAULT_WORKSPACE_ROOT);
  if (workspaceDevice === undefined) return { base: temporary, offWorkspaceVolume: false };
  for (const base of candidates) {
    const device = await deviceProbe(base);
    if (device !== undefined && device !== workspaceDevice) return { base, offWorkspaceVolume: true };
  }
  if (ec2WorkerRuntime(environment)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX has no scratch directory outside the workspace volume, so it did not make one where a task's processes could write");
  }
  return { base: temporary, offWorkspaceVolume: false };
}

/** The directory worker scratch is made in (see the file's comment). */
export async function workerScratchBase(options: WorkerScratchOptions = {}): Promise<string> {
  return (await chooseScratch(options)).base;
}

export type WorkerScratchStatus =
  | { status: "ready"; base: string; offWorkspaceVolume: boolean }
  | { status: "unavailable"; reason: string };

/**
 * Whether this worker can make scratch the way the file's comment says, found out once at start: the choice succeeds and a private directory can be made and removed in it.
 * The answer goes on `/ping` and in the start log, and a worker that cannot refuses its tasks (`assertWorkerScratchReady`).
 */
export async function checkWorkerScratch(options: WorkerScratchOptions = {}): Promise<WorkerScratchStatus> {
  try {
    const choice = await chooseScratch(options);
    await rm(await mkdtemp(join(choice.base, "agentx-scratch-check-")), { recursive: true, force: true });
    return { status: "ready", base: choice.base, offWorkspaceVolume: choice.offWorkspaceVolume };
  } catch (error) {
    return { status: "unavailable", reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

/** The reason /ping reports as a boot failure (server.ts `bootFailure`) for this status, or none when scratch is ready. */
export function workerBootFailureOf(status: WorkerScratchStatus): string | undefined {
  return status.status === "ready" ? undefined : `worker scratch: ${status.reason}`;
}

/** Refuses a task, with the reason, on a worker whose scratch check failed. */
export function assertWorkerScratchReady(status: WorkerScratchStatus): void {
  if (status.status === "ready") return;
  throw agentXError("RUNTIME_UNAVAILABLE", `AgentX did not run the task: this worker cannot make scratch space outside the workspace volume (${status.reason})`);
}

/** A new private (mode 0700) directory of the worker's, named `prefix` and a random suffix, in {@link workerScratchBase}. The caller removes it. */
export async function makeWorkerScratch(prefix: string, options: WorkerScratchOptions = {}): Promise<string> {
  return await mkdtemp(join(await workerScratchBase(options), prefix));
}
