// Setup agent (design setup-test-health 3.1-3.2 and 12, task SH7): the worker's half of the setup run that RUNS things. This module is the part that can be built and tested without the model session:
// the sandbox the commands run in and the rules around it, the shell the agent gets, the check that tracked files were left alone, and the reading of the final answer. The session itself is created
// by the caller (run-task.ts, SH14) with `setupAgentSessionParts`, and the journal and the limits are SH8 (`SetupAgentHooks` is where they plug in).
//
// What is enforced here, in code, and does not depend on what the model was told:
//   - the setup sandbox is the R56 task sandbox, started through a Docker seam that REFUSES a `docker run` with an environment variable, an env file, an extra mount, the Docker socket, a capability,
//     a network other than the task network, a different user or any flag it does not know; and refuses a `docker exec` that passes a credential-shaped variable (by name or by value). The
//     sandbox therefore holds no secret: none is ever given to it;
//   - the tools are read, grep, find, ls and bash. There is no write tool and no edit tool;
//   - after every command, `git` (run by the worker in a throw-away repository, so the repository's own config cannot run anything in the worker) says whether a tracked file changed, the index
//     changed, or HEAD moved. If so the run ends `changed_repository_files`, no later command runs, and there is no proposal;
//   - a command that downloads code and runs it is marked in the journal record (`flagged`); the proposal reader flags it again and never turns it into an item;
//   - a command has a time limit even when the model names none;
//   - the answer is read by the draft's reader (`readSetupProposalAnswer`): bounded, redacted, cited, secrets by name only. Repository text and command output are data.
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { agentXError, isCredentialKey, redactText, remoteCodeReason, type SetupProposal, type SetupRunEndWord } from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { snapshotTree, withIsolatedGit } from "./isolated-git.js";
import { runIsolatedGit } from "./isolated-repository.js";
import type { CollectedProcess, CollectedProcessOptions } from "./collected-process.js";
import { asksForCodeChange } from "./setup-agent-prompt.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS } from "./setup-agent-journal.js";
import { readSetupProposalAnswer, type SetupDraftRepository } from "./setup-draft.js";
import type { SetupScan } from "./setup-scan.js";
import type { TrackedPaths } from "./setup-citations.js";
import { MASK_OPTIONS, SANDBOX_INIT, TASK_SANDBOX_NETWORK, TASK_SANDBOX_USER, TaskSandbox, sandboxNetworkFromEnvironment, type TaskSandboxOptions } from "./task-sandbox.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";

/** The agent's tools: read-only file tools and the shell. No write tool, no edit tool. Passed to the session as `agentTools`. */
export const SETUP_AGENT_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;

/** One command's longest run when the model names no time limit, in seconds. The wall clock of the whole run is the governor's (SH8). */
export const SETUP_COMMAND_DEFAULT_TIMEOUT_SECONDS = 1_800;
/** The most a model may ask for one command, in seconds. */
export const SETUP_COMMAND_MAX_TIMEOUT_SECONDS = 3_600;
/** Bytes of redacted output a command record keeps (the journal's tail). */
export const SETUP_COMMAND_TAIL_BYTES = 4_096;
/** What a refused command prints, in fixed words. */
export const SETUP_COMMAND_REFUSED_TEXT = "Rovara did not run this command because the setup run has ended.";
const CAPTURE_BYTES = 64 * 1024;
/** Said before a command's output when only its last 4 KiB is shown. */
export const SETUP_OUTPUT_CUT_TEXT = "[the earlier output was left out; this is the last part]";

// ---- no credential reaches the sandbox

/**
 * Names that read as credentials by the key rule or the AWS prefix but are not: the region, and pi's session identifiers (`PI_SESSION_ID` and `PI_SESSION_FILE`, which pi puts in its shell's
 * environment). They are exempt from the NAME rules only; a credential-shaped VALUE under any name is still found.
 */
const NON_SECRET_NAMES = new Set(["AWS_REGION", "AWS_DEFAULT_REGION", "PI_SESSION_ID", "PI_SESSION_FILE"]);

/**
 * The names of the variables that look like credentials, by the project's own key rule (`isCredentialKey`), by an AWS prefix, or because the value has a credential shape that `redactText` would
 * redact (a key, a token, a private key, a URL with a password). Names only, in the order given: a value is never returned.
 */
export function credentialShapedVariables(environment: Readonly<Record<string, string | undefined>>, exemptValues?: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    // The exact fake values Rovara's own env channel injects (service-env.ts, 4.0.5) are not secrets. Matched by VALUE, never by name, and only when the caller names them: with no set, today's rule is unchanged.
    if (exemptValues?.has(value) === true) continue;
    const pair = `${name}=${value}`;
    const byName = !NON_SECRET_NAMES.has(name) && (isCredentialKey(name) || name.startsWith("AWS_"));
    if (byName || redactText(value) !== value || (!NON_SECRET_NAMES.has(name) && redactText(pair) !== pair)) names.push(name);
  }
  return names;
}

const ALLOWED_RUN_FLAGS: ReadonlyMap<string, number> = new Map([
  ["--detach", 0], ["--name", 1], ["--label", 1], ["--network", 1], ["--user", 1], ["--cpus", 1], ["--memory", 1], ["--memory-swap", 1], ["--pids-limit", 1],
  ["--cap-drop", 1], ["--security-opt", 1], ["--volume", 1], ["--tmpfs", 1], ["--workdir", 1], ["--entrypoint", 1], ["--dns", 1], ["--ip", 1],
]);
const SETUP_NETWORK_NAME = /^agentx-setup-[0-9a-f]{12}$/u;
const REFUSED_RUN = "AgentX refused to start the setup sandbox: its container options are not the sandbox's";

/**
 * Whether `docker run` arguments are exactly the R56 sandbox's shape for the workspace `rootPath` and nothing more, value by value (not only flag by flag):
 *   - the one mount is `<rootPath>:<rootPath>` (the workspace, at its own path); no other mount, and no `/var/run`, `/`, a home folder or the Docker socket whatever the spelling;
 *   - `--security-opt` is exactly `no-new-privileges` (so `seccomp=unconfined` and `apparmor=unconfined` are refused), `--cap-drop` exactly `ALL`;
 *   - every `--tmpfs` is a folder under the workspace with exactly the sandbox's mask options (read-only, noexec, nosuid; no `exec` or `suid`);
 *   - the task network, the sandbox user, the workspace as the working folder, the sandbox's init as the entrypoint, a process limit;
 *   - flags the sandbox does not use (an environment variable in any spelling, `--privileged`, `--device`, `--pid`...) are refused as unknown.
 * Throws `RUNTIME_UNAVAILABLE` with a fixed sentence (no argument is repeated, since an argument could be a secret).
 */
export function assertSetupSandboxRunArgs(args: readonly string[], options: { rootPath: string; network?: { name: string; ip: string; helperIp: string } | undefined; sharedNetwork?: string | undefined }): void {
  const refuse = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", REFUSED_RUN); };
  const root = resolve(options.rootPath);
  if (!isAbsolute(root) || root === "/" || args[0] !== "run") return refuse();
  const seen = new Map<string, string[]>();
  let index = 1;
  for (; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) break;
    const arity = ALLOWED_RUN_FLAGS.get(token);
    if (arity === undefined) return refuse();
    const value = arity === 0 ? "" : args[index + 1];
    if (value === undefined) return refuse();
    index += arity;
    seen.set(token, [...(seen.get(token) ?? []), value]);
  }
  // The image, then `-- sleep infinity` and nothing else.
  if (index >= args.length || args.slice(index + 1).join(" ") !== "-- sleep infinity" || args.some((argument) => argument.includes("docker.sock"))) return refuse();
  const only = (flag: string): string | undefined => (seen.get(flag)?.length === 1 ? seen.get(flag)![0] : undefined);
  const exactly = (flag: string, value: string): boolean => only(flag) === value;
  // The network is the shared task network, or exactly the run's own network with exactly the one address the run gave the sandbox and no other.
  if (options.network === undefined ? seen.has("--ip") : !(exactly("--network", options.network.name) && exactly("--ip", options.network.ip))) return refuse();
  // On a laptop the sandbox joins the machine's own sandbox network (`AGENTX_SANDBOX_NETWORK`), the only network its Docker socket guard lets a sandbox use; the run has no network of its own there.
  if (options.network === undefined && !exactly("--network", TASK_SANDBOX_NETWORK) && !(options.sharedNetwork !== undefined && exactly("--network", options.sharedNetwork))) return refuse();
  // `--dns`: IP addresses only, at most three (a name out of a repository can never become a resolver).
  // On the run's own network the network's name has the run network's shape and the ONE resolver is the run's helper; on the shared network at most three addresses.
  const dnsServers = seen.get("--dns") ?? [];
  if (options.network !== undefined) {
    if (!SETUP_NETWORK_NAME.test(options.network.name) || dnsServers.length !== 1 || dnsServers[0] !== options.network.helperIp) return refuse();
  } else if (dnsServers.length > 3 || dnsServers.some((server) => isIP(server) === 0)) return refuse();
  if (!exactly("--user", TASK_SANDBOX_USER) || !exactly("--cap-drop", "ALL") || !exactly("--security-opt", "no-new-privileges")) return refuse();
  if (!exactly("--workdir", root) || !exactly("--entrypoint", SANDBOX_INIT) || !exactly("--volume", `${root}:${root}`) || !seen.has("--detach")) return refuse();
  if (!/^[1-9][0-9]{0,6}$/u.test(only("--pids-limit") ?? "")) return refuse();
  const cpus = seen.get("--cpus");
  if (cpus !== undefined && !(cpus.length === 1 && /^[1-9][0-9]{0,3}$/u.test(cpus[0]!))) return refuse();
  const memory = seen.get("--memory");
  const swap = seen.get("--memory-swap");
  if ((memory === undefined) !== (swap === undefined) || (memory !== undefined && !(memory.length === 1 && swap!.length === 1 && memory[0] === swap![0] && /^[1-9][0-9]{0,8}m$/u.test(memory[0]!)))) return refuse();
  if (only("--name") === undefined || !/^agentx-task-[A-Za-z0-9_.-]{1,200}$/u.test(only("--name")!)) return refuse();
  if ((seen.get("--label") ?? []).some((label) => !/^agentx\.(?:task|workspace)=[A-Za-z0-9_.-]{1,200}$/u.test(label))) return refuse();
  for (const mask of seen.get("--tmpfs") ?? []) {
    const cut = mask.lastIndexOf(`:${MASK_OPTIONS}`);
    const path = cut < 0 || cut + 1 + MASK_OPTIONS.length !== mask.length ? undefined : mask.slice(0, cut);
    if (path === undefined || !path.startsWith(`${root}/`) || path.split("/").includes("..") || path.includes(",")) return refuse();
  }
}

const REFUSED_EXEC = "AgentX refused to run a command in the setup sandbox: its options are not the sandbox's";
const ENV_PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;

/**
 * `docker exec` arguments of the setup sandbox: only `--env NAME=value` (or `-e`, as the file tools' environment reset writes it), `-i`, and `--user` equal to the sandbox user, then the sandbox's
 * container (named `agentx-task-...`) and the command. A bare `--env NAME` (which would copy the worker's own variable), `--env=NAME=value`, `--env-file`, `--privileged`, `--user 0` and every other
 * flag are refused. A credential-shaped variable is refused by name and the value is never repeated.
 */
export function assertSetupSandboxExecArgs(args: readonly string[]): void {
  const refuse = (message = REFUSED_EXEC): never => { throw agentXError("RUNTIME_UNAVAILABLE", message); };
  if (args[0] !== "exec") return refuse();
  const environment: Record<string, string> = {};
  let index = 1;
  for (; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) break;
    if (token === "-i") continue;
    const value = args[index + 1];
    if (value === undefined) return refuse();
    if (token === "--user" && value === TASK_SANDBOX_USER) { index += 1; continue; }
    if (token === "--env" || token === "-e") {
      const pair = ENV_PAIR.exec(value);
      if (pair === null) return refuse();
      environment[pair[1]!] = pair[2]!;
      index += 1;
      continue;
    }
    return refuse();
  }
  if (!/^agentx-task-[A-Za-z0-9_.-]{1,200}$/u.test(args[index] ?? "")) return refuse();
  const found = credentialShapedVariables(environment);
  if (found.length > 0) refuse(`AgentX refused to pass ${found.length === 1 ? "a credential-shaped variable" : "credential-shaped variables"} to the setup sandbox (${found.join(", ")})`);
}

/**
 * The Docker seam of a setup sandbox for the workspace `rootPath`. `run` must pass `assertSetupSandboxRunArgs`; `exec` (and the file tools' byte-exact exec) must pass `assertSetupSandboxExecArgs`.
 * Everything else (inspect, network, rm, ps) passes. Wraps the real Docker, or a fake in a test.
 */
export function guardedSetupDocker(docker: DockerCli = createDockerCli(), options: { rootPath: string; network?: { name: string; ip: string; helperIp: string } | undefined; sharedNetwork?: string | undefined }): DockerCli {
  return {
    async run(args: readonly string[], runOptions?: CollectedProcessOptions): Promise<CollectedProcess> {
      if (args[0] === "run") assertSetupSandboxRunArgs(args, options);
      if (args[0] === "exec") assertSetupSandboxExecArgs(args);
      return docker.run(args, runOptions);
    },
    ...(docker.execBytes === undefined ? {} : {
      async execBytes(args: readonly string[], execOptions: Parameters<NonNullable<DockerCli["execBytes"]>>[1]) {
        assertSetupSandboxExecArgs(args);
        return docker.execBytes!(args, execOptions);
      },
    }),
  };
}

/** The setup sandbox: the R56 task sandbox, through the guarded Docker seam. Nothing falls back to the local shell. */
export function createSetupSandbox(options: Omit<TaskSandboxOptions, "docker"> & { docker?: DockerCli }): TaskSandbox {
  const helperIp = options.dns?.[0];
  if (options.network !== undefined && (options.dns?.length !== 1 || helperIp === undefined)) throw agentXError("CONFIG_INVALID", "a setup sandbox on a run network has exactly its helper as resolver");
  return new TaskSandbox({ ...options, docker: guardedSetupDocker(options.docker, { rootPath: options.rootPath, network: options.network === undefined ? undefined : { ...options.network, helperIp: helperIp! }, sharedNetwork: sandboxNetworkFromEnvironment(options.environment ?? process.env) }) });
}

// ---- tracked files are left alone

export interface SetupAgentRepository extends SetupDraftRepository {
  /** The directory of the repository on the worker. */
  directory: string;
}

/** What the check found, in fixed words. */
export type TrackedFilesVerdict = { ok: true } | { ok: false; reason: "tracked_files_changed" | "head_moved" | "index_flags" | "unreadable" };

/**
 * What one repository's check needs from git, each answered by the worker's isolated git (never a git the repository's own config could steer):
 *   - `head`: the commit HEAD names;
 *   - `changedTracked`: whether the work tree differs from HEAD in any tracked path (content, mode, a deletion), judged against a FRESH index built from HEAD, so nothing the agent set on the
 *     repository's real index (`--skip-worktree`, `--assume-unchanged`, a stale entry) can hide an edit;
 *   - `indexTags`: the `git ls-files -v` tag of every entry of the real index. Anything but `H` (cached, nothing special) means the agent set a flag on the index.
 */
export interface SetupGit {
  head(directory: string): Promise<string>;
  changedTracked(directory: string, head: string): Promise<boolean>;
  indexTags(directory: string): Promise<string[]>;
}

/**
 * What decides which bytes `git add` stages, set by the check and not by the agent's own `.git/config` or `.git/info/attributes`: file modes are always compared (`core.fileMode=false` would hide a
 * `chmod`), and no line-ending conversion happens (`core.autocrlf`, `core.eol`, `core.safecrlf`), so the work tree is compared byte for byte with what the clone checked out. Attributes committed in the
 * repository still apply; the agent's untracked `.git/info/attributes` (an `eol` or `working-tree-encoding` rule that would normalize an edit away) is left out.
 */
const TRACKED_CHECK_CONFIG: ReadonlyArray<readonly [string, string]> = [["core.filemode", "true"], ["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]];

export const defaultSetupGit: SetupGit = {
  head: async (directory) => (await runIsolatedGit(directory, ["rev-parse", "--verify", "HEAD"], { timeout: 120_000 })).trim(),
  changedTracked: (directory, head) => withIsolatedGit(directory, "read", async (git) => {
    // A fresh index from HEAD, then the work tree added to it (nested repositories and Git LFS files are refused, as for every candidate snapshot): the tree that results is the work tree's.
    const tree = await snapshotTree(git, head);
    // Compared with HEAD's own tree. A path that exists only in the work tree (status `A`: an untracked file, setup's own output) is not a change to a tracked file; every other difference is.
    const diff = await git.text(["diff-tree", "-r", "--name-status", "--no-renames", "-z", head, tree], { index: "none", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    return diff.split("\0").some((field, position) => position % 2 === 0 && field !== "" && !field.startsWith("A"));
  }, { config: TRACKED_CHECK_CONFIG, ignoreInfoAttributes: true }),
  indexTags: async (directory) => (await runIsolatedGit(directory, ["ls-files", "-v", "-z"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).split("\0").filter((entry) => entry !== "").map((entry) => entry.slice(0, 1)),
};

/**
 * Whether every repository is still at the commit it was cloned at, with no change to a tracked file and no flag on the index. The work tree is compared with HEAD through a fresh index, so a flag
 * the agent put on the real index (`git update-index --skip-worktree` or `--assume-unchanged`, which make `git status` blind to an edit) does not hide anything, and the flag itself is refused
 * (`index_flags`). Untracked and ignored files (`node_modules`, build output) are the point of setup and are not looked at. A repository with no recorded commit, or any git failure, is
 * `unreadable`, which ends the run like a change: the check never passes on a guess.
 */
export async function checkTrackedFiles(repositories: ReadonlyArray<SetupAgentRepository>, git: SetupGit = defaultSetupGit): Promise<TrackedFilesVerdict> {
  for (const repository of repositories) {
    if (repository.resolvedCommit === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(repository.resolvedCommit)) return { ok: false, reason: "unreadable" };
    try {
      const head = (await git.head(repository.directory)).trim();
      if (head !== repository.resolvedCommit) return { ok: false, reason: "head_moved" };
      if ((await git.indexTags(repository.directory)).some((tag) => tag !== "H")) return { ok: false, reason: "index_flags" };
      if (await git.changedTracked(repository.directory, head)) return { ok: false, reason: "tracked_files_changed" };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  return { ok: true };
}

// ---- the agent's shell

/** What one command left behind: the record SH8's journal keeps. The command is the model's text, redacted; the tail is redacted output. */
export interface SetupCommandRecord {
  command: string;
  /** The command downloads code and runs it (the same rule as the proposal's flag). */
  flagged: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  tail: string;
  startedAt: number;
  ticket?: unknown;
}

/** `ticket`: whatever the hook needs to match the command to its reservation; the shell hands it back unchanged in the record. */
export type SetupCommandDecision = { allow: true; ticket?: unknown } | { allow: false };

/** Where the journal and the governor (SH8) plug in. `beforeCommand` may refuse a command (a limit is used up); `afterCommand` sees every command that ran. */
export interface SetupAgentHooks {
  beforeCommand?(command: string, flagged: boolean): SetupCommandDecision | Promise<SetupCommandDecision>;
  afterCommand?(record: SetupCommandRecord): void | Promise<void>;
  /** The most seconds the next command may run (the wall clock that is left). The shell never gives a command more, whatever the model asked. */
  maxTimeoutSeconds?(): number;
  /** The shell ended the run because a command changed the repositories. */
  onEnded?(word: "changed_repository_files"): void;
}

export interface SetupAgentShell {
  operations: BashOperations;
  /** Why the run must end, once a command changed tracked files; undefined while it can go on. */
  ended(): Extract<SetupRunEndWord, "changed_repository_files"> | undefined;
  /** The check the shell makes after each command, run once more by the caller at the end. */
  verdict(): TrackedFilesVerdict | undefined;
}

export interface SetupAgentShellInput {
  base: BashOperations;
  hooks?: SetupAgentHooks;
  /** Called after each command, and decides whether tracked files are still untouched. Absent: not checked (a test of the rest). */
  checkFiles?: () => Promise<TrackedFilesVerdict>;
  now?: () => number;
}

/** The last `bytes` bytes of `text`, cut on a character boundary, redacted, and plain (control characters other than newline and tab become `?`). */
export function commandTail(text: string, bytes = SETUP_COMMAND_TAIL_BYTES): string {
  const redacted = redactText(text);
  const buffer = Buffer.from(redacted, "utf8");
  const cut = buffer.length > bytes ? buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^�+/u, "") : redacted;
  return cut.replace(/[^\P{Cc}\n\t]/gu, "?");
}

/**
 * The agent's shell: pi's bash tool runs through it. A command runs only while the run can go on, and not when `beforeCommand` refuses it; it always has a time limit; its output is kept as a bounded,
 * redacted tail; `afterCommand` sees the record; and tracked files are checked after it. A refused command prints one fixed sentence and exits 126.
 */
export function setupAgentShell(input: SetupAgentShellInput): SetupAgentShell {
  const now = input.now ?? Date.now;
  let ended: "changed_repository_files" | undefined;
  let last: TrackedFilesVerdict | undefined;
  const operations: BashOperations = {
    async exec(command, cwd, options) {
      const flagged = remoteCodeReason(command) !== undefined;
      const refuse = async (): Promise<{ exitCode: number }> => { options.onData(Buffer.from(`${SETUP_COMMAND_REFUSED_TEXT}\n`)); return { exitCode: 126 }; };
      if (ended !== undefined) return refuse();
      const decision = await input.hooks?.beforeCommand?.(command, flagged);
      if (decision?.allow === false) return refuse();
      // A time limit always: the model's, up to the most, else the default.
      const requested = options.timeout !== undefined && options.timeout > 0 ? options.timeout : SETUP_COMMAND_DEFAULT_TIMEOUT_SECONDS;
      const left = input.hooks?.maxTimeoutSeconds?.();
      const timeout = Math.max(1, Math.min(requested, SETUP_COMMAND_MAX_TIMEOUT_SECONDS, left === undefined || !Number.isFinite(left) ? Infinity : Math.floor(left)));
      let captured = "";
      const startedAt = now();
      let exitCode: number | null = null;
      let timedOut = false;
      let failure: unknown;
      try {
        const result = await input.base.exec(command, cwd, {
          ...options,
          timeout,
          // What the command prints is kept here and the model is shown only its last 4 KiB (below), never the stream: a turn's input is bounded by the margin the governor prices (`SETUP_NEXT_TURN_MARGIN_TOKENS`).
          // Pi's own cap on a tool's output (2,000 lines or 50 KB) still applies on top, and is the larger of the two.
          onData: (data) => { captured = (captured + data.toString("utf8")).slice(-CAPTURE_BYTES); },
        });
        exitCode = result.exitCode;
      } catch (error) {
        failure = error;
        timedOut = error instanceof Error && error.message.startsWith("timeout:");
      }
      const tail = commandTail(captured);
      if (tail !== "") options.onData(Buffer.from(`${Buffer.byteLength(captured, "utf8") > Buffer.byteLength(tail, "utf8") ? `${SETUP_OUTPUT_CUT_TEXT}\n` : ""}${tail}`));
      const record: SetupCommandRecord = {
        command: redactText(command), flagged, ...(decision?.allow === true && decision.ticket !== undefined ? { ticket: decision.ticket } : {}), exitCode, durationMs: Math.max(0, Math.round(now() - startedAt)), timedOut, tail, startedAt,
      };
      await input.hooks?.afterCommand?.(record);
      if (input.checkFiles !== undefined) {
        last = await input.checkFiles();
        if (!last.ok) {
          ended = "changed_repository_files";
          input.hooks?.onEnded?.("changed_repository_files");
          options.onData(Buffer.from("\nRovara found that this command changed the project's files, so the setup run has ended.\n"));
        }
      }
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error("the command could not run");
      return { exitCode };
    },
  };
  return { operations, ended: () => ended, verdict: () => last };
}

/**
 * The parts of the session input the caller adds to its own (run-task.ts, SH14): the tools, the shell and the sandbox's file tools. The session runs as an IMPLEMENT-mode session narrowed to
 * these tools, so it has the shell and no write or edit tool.
 */
export function setupAgentSessionParts(input: { sandbox: TaskSandbox; shell: SetupAgentShell }): {
  workflowMode: "SETUP"; agentTools: readonly string[]; bashOperations: BashOperations; fileTools: ReturnType<TaskSandbox["fileOpsTarget"]>; sequentialTools: true; maxOutputTokens: number;
} {
  // Sequential tools: the governor counts a command when it is allowed, but one command at a time is also what the journal and the live view show. The output cap bounds what one turn can cost.
  return { workflowMode: "SETUP", agentTools: SETUP_AGENT_TOOLS, bashOperations: input.shell.operations, fileTools: input.sandbox.fileOpsTarget(), sequentialTools: true, maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS };
}

// ---- the final answer

export type SetupAgentOutcome =
  | { ok: true; end: "proposed" | "needs_code_change"; proposal: SetupProposal; answered: boolean; flaggedRan: number }
  | { ok: false; end: "changed_repository_files" | "infrastructure"; errors: string[] };

/**
 * Reads the run's final answer. A run that changed tracked files has no proposal (the verdict from the last check, run once more here by the caller, decides). Otherwise the answer is read by the draft's
 * reader, so every item is cited, every download-and-run command is flagged and never an item, and secrets are names only. A first line of `NEEDS CODE CHANGE:` ends the run `needs_code_change`,
 * and the proposal still holds what was learned. `flaggedRan` counts the commands the run ran that download code: the record shows them, whatever the proposal lists.
 */
export async function finishSetupAgent(input: {
  finalText: string;
  verdict: TrackedFilesVerdict | undefined;
  basedOnRevision: number;
  rootPath: string;
  repositories: ReadonlyArray<SetupDraftRepository>;
  metaRepo?: string | undefined;
  records: ReadonlyArray<Pick<SetupCommandRecord, "flagged">>;
  /** The scan taken before the agent ran and the files of the resolved commit (setup-citations.ts). */
  scan?: SetupScan | undefined;
  tracked?: TrackedPaths | undefined;
}): Promise<SetupAgentOutcome> {
  if (input.verdict === undefined || !input.verdict.ok) return { ok: false, end: "changed_repository_files", errors: [input.verdict === undefined ? "the repositories were not checked" : input.verdict.reason] };
  const read = await readSetupProposalAnswer(input.finalText, {
    basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories: input.repositories, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
    ...(input.scan === undefined ? {} : { scan: input.scan }), ...(input.tracked === undefined ? {} : { tracked: input.tracked }),
  });
  if (!read.ok) return { ok: false, end: "infrastructure", errors: read.errors };
  return { ok: true, end: asksForCodeChange(input.finalText) ? "needs_code_change" : "proposed", proposal: read.proposal, answered: read.answered, flaggedRan: input.records.filter((record) => record.flagged).length };
}
