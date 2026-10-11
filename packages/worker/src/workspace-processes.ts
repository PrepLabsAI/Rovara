import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";

const execFile = promisify(execFileCallback);

/**
 * Before a push token exists, every process that agent or project code may have left running is stopped: a leftover
 * process runs as the worker's own user, so it could read the token from another process or rewrite what the push
 * reads. What "every" covers depends on where the worker runs:
 *
 * - `container` (the deployed worker: its image sets AGENTX_WORKER_PROCESS_SCOPE=container): the worker container has
 *   its own PID namespace, where only tini (PID 1), the worker and the worker's operations should run. Every process of
 *   the worker's user that is not the worker itself or one of its ancestors is stopped, wherever it moved (a `setsid`
 *   daemon that changed directory or was re-parented to tini included). A live process of any other user cannot be
 *   stopped by the worker, so the push is refused instead.
 * - `workspace` (anywhere else: a developer machine, tests): every process of the worker's user whose working
 *   directory is inside the workspace. A process elsewhere on a shared machine is not the worker's to stop.
 *
 * This is not a sandbox. On EC2 workers, when a project has no dev container, the coding step currently runs with the
 * worker's Docker access, and a container is outside this function's reach. So before the token is fetched,
 * publication also removes the containers started by the task (workspace-containers.ts), and repeats both until
 * neither finds anything. Running AI-written code as a separate user without Docker access is tracked in #325
 * (docs/project-configuration.md, "Security follow-ups").
 */
export type WorkspaceProcessScope = "container" | "workspace";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  uid: number;
  /** One-letter state; "Z" (zombie) and "X" (dead) processes cannot run anything. */
  state: string;
  /** The process's working directory, when it could be read. */
  cwd?: string;
}

export interface StopWorkspaceProcessesOptions {
  rootPath: string;
  scope?: WorkspaceProcessScope;
  /** Test seams. */
  listProcesses?: () => Promise<ProcessEntry[]>;
  kill?: (pid: number) => void;
  selfPid?: number;
  uid?: number;
  rounds?: number;
}

/** The scope this worker runs in, from its environment: the worker image says it is a container. */
export function workspaceProcessScope(environment: NodeJS.ProcessEnv = process.env): WorkspaceProcessScope {
  return environment.AGENTX_WORKER_PROCESS_SCOPE === "container" ? "container" : "workspace";
}

/** The processes to stop: the worker's user's, not the worker or its ancestors, alive, and in scope. */
export function processesToStop(
  processes: readonly ProcessEntry[],
  input: { selfPid: number; uid: number; scope: WorkspaceProcessScope; rootPath: string },
): ProcessEntry[] {
  const ancestors = ancestorsOf(processes, input.selfPid);
  const root = resolve(input.rootPath);
  const inWorkspace = (cwd: string | undefined) => {
    if (cwd === undefined) return false;
    const fromRoot = relative(root, cwd);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  };
  return processes.filter((entry) => entry.uid === input.uid && !ancestors.has(entry.pid) && entry.state !== "Z" && entry.state !== "X"
    && (input.scope === "container" || inWorkspace(entry.cwd)));
}

/**
 * In the worker container: the live processes of another user that are not the worker or its ancestors. The worker
 * cannot stop them, and they can read what its user can, so a push must not start while any runs.
 */
export function unstoppableProcesses(
  processes: readonly ProcessEntry[],
  input: { selfPid: number; uid: number; scope: WorkspaceProcessScope; rootPath: string },
): ProcessEntry[] {
  if (input.scope !== "container") return [];
  const ancestors = ancestorsOf(processes, input.selfPid);
  return processes.filter((entry) => entry.uid !== input.uid && !ancestors.has(entry.pid) && entry.state !== "Z" && entry.state !== "X");
}

function ancestorsOf(processes: readonly ProcessEntry[], selfPid: number): Set<number> {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const ancestors = new Set<number>();
  for (let pid: number | undefined = selfPid; pid !== undefined && pid > 0 && !ancestors.has(pid); pid = byPid.get(pid)?.ppid) ancestors.add(pid);
  return ancestors;
}

/**
 * Stops (SIGKILL) every process in scope, then lists again until none is left; a process may start another as it is
 * stopped. Fails closed (RUNTIME_UNAVAILABLE) when the processes cannot be listed or some are still running after the
 * last round, or when a process of another user runs in the worker container (unstoppableProcesses), so nothing is
 * pushed.
 */
export async function stopWorkspaceProcesses(options: StopWorkspaceProcessesOptions): Promise<{ stopped: number }> {
  const scope = options.scope ?? workspaceProcessScope();
  const list = options.listProcesses ?? listProcesses;
  const kill = options.kill ?? ((pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ESRCH") throw error;
    }
  });
  const selection = {
    selfPid: options.selfPid ?? process.pid,
    uid: options.uid ?? process.getuid?.() ?? -1,
    scope,
    // A process's working directory is read as its real path.
    rootPath: await realpath(options.rootPath).catch(() => resolve(options.rootPath)),
  };
  const rounds = options.rounds ?? 6;
  let stopped = 0;
  for (let round = 0; round < rounds; round += 1) {
    let listed: ProcessEntry[];
    try {
      listed = await list();
    } catch (error) {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not list the processes left in the workspace, so it did not push: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
    }
    const foreign = unstoppableProcesses(listed, selection);
    if (foreign.length > 0) {
      const named = foreign.slice(0, 5).map((entry) => `${entry.pid} (user ${entry.uid})`).join(", ");
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX found a program running as another user in the worker that it cannot stop (process ${named}), so it did not push`);
    }
    const found = processesToStop(listed, selection);
    if (found.length === 0) return { stopped };
    for (const entry of found) kill(entry.pid);
    stopped += found.length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25 * (round + 1)));
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not stop every process left in the workspace, so it did not push");
}

/** Every process this user can see: /proc on Linux, `lsof` (working directories) and `ps` elsewhere. */
async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === "linux") return listLinuxProcesses();
  return listWithLsof();
}

async function listLinuxProcesses(procRoot = "/proc"): Promise<ProcessEntry[]> {
  const entries: ProcessEntry[] = [];
  for (const name of await readdir(procRoot)) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    let status: string;
    try {
      [stat, status] = await Promise.all([readFile(`${procRoot}/${name}/stat`, "utf8"), readFile(`${procRoot}/${name}/status`, "utf8")]);
    } catch {
      // It exited while the list was read.
      continue;
    }
    // "pid (comm) state ppid ...": comm may hold spaces or parentheses, so the fields after it are read from the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
    if (fields[0] === undefined || fields[1] === undefined || uid === undefined) throw new Error(`process ${name} could not be read`);
    const cwd = await readlink(`${procRoot}/${name}/cwd`).catch(() => undefined);
    entries.push({ pid, ppid: Number(fields[1]), uid: Number(uid), state: fields[0], ...(cwd === undefined ? {} : { cwd }) });
  }
  return entries;
}

/** macOS and other Unix systems: `ps` for every process, `lsof` for the working directories of this user's. */
async function listWithLsof(): Promise<ProcessEntry[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("this platform has no process user IDs");
  const ps = await execFile("ps", ["-A", "-o", "pid=,ppid=,uid=,stat="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const cwds = new Map<number, string>();
  try {
    const lsof = await execFile("lsof", ["-nP", "-w", "-a", "-d", "cwd", "-u", String(uid), "-Fpn"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    parseLsof(lsof.stdout, cwds);
  } catch (error) {
    // lsof exits 1 when it lists nothing for a filter, and may still have listed the rest.
    const stdout = (error as { stdout?: unknown }).stdout;
    if ((error as { code?: unknown }).code !== 1 || typeof stdout !== "string") throw error;
    parseLsof(stdout, cwds);
  }
  const entries: ProcessEntry[] = [];
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid, owner, state] = line.trim().split(/\s+/u);
    if (pid === undefined || ppid === undefined || owner === undefined || state === undefined || !/^\d+$/u.test(pid)) continue;
    const cwd = cwds.get(Number(pid));
    entries.push({ pid: Number(pid), ppid: Number(ppid), uid: Number(owner), state: state.charAt(0), ...(cwd === undefined ? {} : { cwd }) });
  }
  return entries;
}

function parseLsof(output: string, into: Map<number, string>): void {
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) into.set(pid, line.slice(1));
  }
}
