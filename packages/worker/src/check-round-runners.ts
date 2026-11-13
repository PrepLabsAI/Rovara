// A sealed check round (test services, slice 1, s1-sealed T1; design test-services.md 4.0.2 and 8; deferred check TS-SEAL-3). The one place an official check round gets its runners when the task has test services:
// the round's checks run in the SEALED check sandbox, by `docker exec --env-file` with the run's connection variables, and the working sandbox is off the services network for the whole round.
//
// What this module guarantees (each has a test):
//   - THE CHECK SANDBOX STARTS ONLY THROUGH check-sandbox.ts's own start function, INSIDE `withDetachedWorking` (TS-SEAL-3). `withSealedCheckRound` is `withDetachedWorking` and nothing else starts the sandbox: the working sandbox is detached
//     and proved gone first, the sandbox starts, the round runs, then the sandbox is REMOVED and the working sandbox is attached again, also when the round fails or is cancelled. the plan's own run arguments are run by no other path
//     (a source guard in the tests looks for one).
//   - A CHECK NEVER RUNS ANYWHERE ELSE. The runners are built in this module from that exec alone (the general check runners have no sealed option and refuse one), so there is no fallback to the working sandbox, a devcontainer or the host. Their `exec` is bound to this round: once the
//     round is over (the sandbox is removed) it rejects, so a runner kept by mistake cannot start a command in a later, unsealed place.
//   - THE RUN'S VARIABLES COME LAST AND NEVER LEAVE A FILE. Each exec gets the variables as `--env-file <path>` (a 0600 file on the run's tmpfs, written for that exec and removed when it returns: service-env.ts
//     `withServiceEnvFile`); the path is the only thing on the command line. A command's own `env` can add variables, but a name the run sets is dropped from it: Docker lets `--env` win over `--env-file`, so the repository's
//     own `DATABASE_URL` or `AWS_ENDPOINT_URL` must not reach the exec (service-env.ts, "FOR TS30").
//   - NOTHING THE CHECKS PRINT KEEPS A SECRET: stdout, stderr and error messages go through the run's redactor (case-insensitive, every spelling of each registered value) before they are kept.
//
// What it does not do: start or reset the helpers (the ServiceRunner), write the files of `checkSandboxPlan` (`writeCheckSandboxFiles`, the caller does, before the round), start the sealed DNS helper
// (`plan.dnsHelperRunArgs`, the caller does, with the helpers), or read the name server's record (`buildServiceUsageRecord`, service-usage-record.ts, after the round and before the services stop).
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { agentXError } from "@rovara-code/contracts";
import { containerBashOperations, runContainerCommand, type ContainerExec } from "./devcontainer.js";
import { withDetachedWorking, type CheckSandboxPlan, type WorkingPhaseNetwork } from "./check-sandbox.js";
import { withServiceEnvFile, type ServiceEnvironment, type ServiceRedactor } from "./service-env.js";
import type { HelperFiles } from "./service-helpers.js";
import type { DockerCli } from "./swebench/containers.js";
import { matchTestCommand } from "@rovara-code/contracts";
import { tailCollector } from "./collected-process.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import { sandboxCommandOptions } from "./task-sandbox.js";
import { CheckNotRunError, containedDirectory, runChecks, withoutRootError, type CheckPlan, type CheckRound, type CheckRunners } from "./verification/checks.js";

/**
 * Test services (TS17, TS-SEAL-3): what a sealed round's runners need: `docker exec` into the live sealed check sandbox (with the run's env file on every exec; it rejects once the round is over), and the run's redactor,
 * applied to everything a check printed before it is kept. Only `withSealedCheckRound` makes one, and the runners made from it live in this module alone: the general check runners (verification/checks.ts) have no sealed option.
 */
interface SealedSeam {
  exec: ContainerExec;
  redact(text: string): string;
}

/**
 * The runners of a sealed round: the same commands as the working sandbox runs (`runContainerCommand` and `containerBashOperations`, with the same NODE_ENV and Python user site settings), through the sealed seam.
 * The agent's replay gets the AgentX git identity only: the worker's own environment is not copied into the sealed sandbox, and the run's variables come from the seam's env file, which wins over any `env` of the command.
 */
function createSealedCheckRunners(rootPath: string, seam: SealedSeam): CheckRunners {
  const commandOptions = sandboxCommandOptions(rootPath);
  const operations = containerBashOperations(seam.exec, commandOptions);
  const canonicalRoot = realpath(resolve(rootPath));
  canonicalRoot.catch(() => undefined);
  return {
    async runProjectCommand(command, signal) {
      if (signal.aborted) throw new Error("aborted");
      const root = await canonicalRoot;
      try {
        const result = await runContainerCommand(seam.exec, root, command, signal, commandOptions);
        if (signal.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode, timedOut: result.timedOut === true, stdout: seam.redact(result.stdout), stderr: seam.redact(result.stderr) };
      } catch (error) {
        throw redactedError(withoutRootError(error, root), (text) => seam.redact(text));
      }
    },

    async runAgentCommand(replay, timeoutMs, signal) {
      if (signal.aborted) throw new Error("aborted");
      if (matchTestCommand(replay) !== replay) throw new CheckNotRunError("AgentX replays only a simple test command, and this is not one.");
      const root = await canonicalRoot;
      const cd = /^cd (\S+) && (.+)$/s.exec(replay);
      const command = cd === null ? replay : cd[2]!;
      const cwd = cd === null ? root : await containedDirectory(root, cd[1]!, true);
      const output = tailCollector();
      try {
        const { exitCode } = await operations.exec(command, cwd, { onData: (data) => output.add(data), signal, timeout: timeoutMs / 1_000, env: { ...AGENTX_GIT_IDENTITY_ENVIRONMENT } });
        return { exitCode, timedOut: false, output: seam.redact(output.text()) };
      } catch (error) {
        if (signal.aborted) throw new Error("aborted", { cause: error });
        if (error instanceof Error && error.message.startsWith("timeout:")) return { exitCode: null, timedOut: true, output: seam.redact(output.text()) };
        throw redactedError(withoutRootError(error, root), (text) => seam.redact(text));
      }
    },
  };
}

/** An error with its message redacted (a failed exec's message may quote what the sandbox printed); a CheckNotRunError and a non-error pass as they are. */
function redactedError(error: unknown, redact: (text: string) => string): unknown {
  if (!(error instanceof Error) || error instanceof CheckNotRunError) return error;
  const message = redact(error.message);
  return message === error.message ? error : new Error(message);
}


const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
/** A variable name a shell and `docker exec --env` both read as a name (POSIX): a command's own `env` may hold no other (no `=`, no space, no `-`). */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** The plans with a sealed round running (TS-SEAL-3): one round at a time on a plan. Module-private. */
const ACTIVE_PLANS = new Set<string>();
const planKey = (plan: Pick<CheckSandboxPlan, "network" | "sandboxName">): string => `${plan.network.name}|${plan.sandboxName}`;

/** The fixed sentence for a project the test services cannot serve yet. */
export const TEST_SERVICES_DEVCONTAINER_SENTENCE = "Test services are not available yet for a project that uses a dev container.";

/**
 * Test services run the checks in the worker's own sealed sandbox, not in the project's dev container, so a project with a dev container would be checked somewhere its tests were never meant to run. The worker calls this
 * BEFORE it starts any dependency (and `withSealedCheckRound` calls it again before any Docker call): a plan with dependencies for a project with a dev container is refused with the same fixed sentence at approval
 * (the broker's side) and here. Nothing is started and nothing is written.
 */
export function refuseTestServicesWithDevcontainer(input: { dependencies: number | readonly unknown[]; devcontainer: boolean }): void {
  const count = typeof input.dependencies === "number" ? input.dependencies : input.dependencies.length;
  if (input.devcontainer && count > 0) throw agentXError("CONFIG_INVALID", TEST_SERVICES_DEVCONTAINER_SENTENCE);
}

const NETWORK_CALL_TIMEOUT_MS = 60_000;
/** The exec inputs `withSealedCheckRound` made (TS-SEAL-3). Module-private: `sealedContainerExec` refuses any other. */
const ROUND_EXEC_INPUTS = new WeakSet<object>();

export interface SealedExecInput {
  docker: DockerCli;
  /** The check sandbox's container name (`CheckSandboxPlan.sandboxName`). */
  container: string;
  /** The run's directory seam (service-env.ts `createRunDirectoryFiles`): the env files are written through it. */
  files: HelperFiles;
  /** The check sandbox's variables: `buildServiceEnvironment({ sandbox: "check", ... })`. */
  environment: ServiceEnvironment;
  /** True while the round is running. The seam rejects when it is false. */
  live(): boolean;
}

/**
 * `docker exec [--env-file F] [--env K=V ...] <check sandbox> <command>`. A name in `environment` is taken out of the command's own `env` first, so the run's value is the only one the exec gets.
 * Rejects (fixed sentence) when the round is over. Refuses an input that `withSealedCheckRound` did not make: it is exported for the round's own tests and nothing else (a source guard allows no other caller).
 */
export function sealedContainerExec(input: SealedExecInput): ContainerExec {
  if (!ROUND_EXEC_INPUTS.has(input)) throw agentXError("CONFIG_INVALID", "a sealed exec is made only by a sealed check round");
  if (!CONTAINER_NAME.test(input.container)) throw agentXError("CONFIG_INVALID", "not a plan of a sealed check sandbox");
  const owned = new Set(input.environment.entries.map(([name]) => name));
  const prefix = randomUUID().replace(/-/gu, "").slice(0, 16);
  let counter = 0;
  return async (command, options) => {
    if (!input.live()) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check sandbox is not running");
    counter += 1;
    const entries = Object.entries(options.env ?? {});
    // Checked before the channel's names are taken out, so a bad name is refused, not hidden behind one that is dropped.
    for (const [name, value] of entries) if (!POSIX_ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0")) throw agentXError("CONFIG_INVALID", "a command's variable has a name or a value the sealed exec does not pass");
    const own = entries.filter(([name]) => !owned.has(name));
    return withServiceEnvFile(input.files, `chk-${prefix}-${String(counter)}`, input.environment, (envFileArgs) => input.docker.run([
      "exec",
      ...envFileArgs,
      ...own.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      input.container, ...command,
    ], {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    }));
  };
}

/** One member of a Docker network as `docker network inspect --format '{{json .Containers}}'` lists it. */
interface NetworkMember { Name?: unknown; IPv4Address?: unknown }

/**
 * TS-SEAL-3, from the network's side: reads who is on the run's services network NOW, with a `docker network inspect` of the network itself, so the proof does not rest on the working sandbox's name (which the caller
 * gives and `detachWorkingSandbox` takes at its word). Before the check sandbox starts the members must be the DNS helper (present) and the run's helpers (at their own addresses) and nothing else; after it starts, also the
 * check sandbox, once, at .4. Anything else (the working sandbox at .3 under any name, an unknown container, a helper-shaped name at the wrong address, a list that cannot be read) throws and nothing runs.
 */
export async function assertSealedNetworkMembers(docker: DockerCli, plan: CheckSandboxPlan, phase: "before_start" | "after_start"): Promise<void> {
  const refuse = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "the run's services network holds a container the sealed check round does not expect"); };
  const inspected = await docker.run(["network", "inspect", "--format", "{{json .Containers}}", plan.network.name], { timeoutMs: NETWORK_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (inspected === undefined || inspected.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "the run's services network could not be read");
  let parsed: unknown;
  try { parsed = JSON.parse(inspected.stdout.trim()); } catch { return refuse(); }
  if (parsed === null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) return refuse();
  const helperNames = new Map(plan.names.map((entry) => [entry.address, entry.alias]));
  const helperName = new RegExp(`^${plan.network.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-h[0-9a-f]{10}$`, "u");
  let dnsHelper = 0;
  let checkSandbox = 0;
  for (const member of Object.values(parsed as Record<string, NetworkMember>)) {
    const name = typeof member?.Name === "string" ? member.Name : undefined;
    const address = typeof member?.IPv4Address === "string" ? member.IPv4Address.split("/")[0] : undefined;
    if (name === undefined || address === undefined) return refuse();
    if (name === plan.dnsHelperName) dnsHelper += 1;
    else if (name === plan.sandboxName) {
      if (phase !== "after_start" || address !== plan.network.ip) return refuse();
      checkSandbox += 1;
    } else if (!(helperName.test(name) && helperNames.has(address))) return refuse();
  }
  if (dnsHelper !== 1 || checkSandbox !== (phase === "after_start" ? 1 : 0)) return refuse();
}

export interface SealedCheckRoundInput {
  docker: DockerCli;
  /**
   * The network the working sandbox belongs on (its working-phase network) and its address there. After the round the working sandbox is checked to be on it (connected there if it is not), and it is NEVER connected to
   * this round's network, not even for a moment: a round's network holds the round's helpers, name server and check sandbox, and nothing else. It must not be the plan's own network.
   */
  workingPhaseNetwork: WorkingPhaseNetwork | null;
  /** True when the project has a dev container: the round is then refused ("not available yet") before any Docker call. The caller states it, so it cannot be left out. */
  hasDevcontainer: boolean;
  /** `checkSandboxPlan(...)`: the sandbox, its names and files. The caller has written the plan's files (`writeCheckSandboxFiles`) and started the DNS helper. */
  plan: CheckSandboxPlan;
  /** The workspace root the checks run in (the same as the plan's `rootPath`). */
  rootPath: string;
  files: HelperFiles;
  /** `buildServiceEnvironment({ sandbox: "check", ... })`. */
  environment: ServiceEnvironment;
  /** `createServiceRedactor(helperSecretValues(...))`: applied to everything the checks print. */
  redactor: ServiceRedactor;
  /** Put the run's helpers back before the round's first check (`freshHelpers`); see `CheckRunners.freshServices`. Runs after the working sandbox is detached and the check sandbox is up. */
  freshServices?: CheckRunners["freshServices"];
  /** Put the `between_checks` helpers back between two checks (`resetForNextCheck`); see `CheckRunners.resetBetweenChecks`. */
  resetBetweenChecks?: CheckRunners["resetBetweenChecks"];
  /** The round's abort signal, passed to the resolver guard's docker calls when the check sandbox starts (check-sandbox.ts, `withDetachedWorking`'s start). */
  signal?: AbortSignal;
}

/**
 * Runs `round` with the runners of a sealed round. This is `withDetachedWorking` (check-sandbox.ts) with the check sandbox started inside it: the working sandbox leaves the services network (and is proved gone),
 * the check sandbox starts, `round` runs with runners whose every command is a `docker exec --env-file` into it, then the sandbox is removed and the working sandbox is attached again, whatever `round` did.
 * Throws when the working sandbox cannot be detached or the check sandbox cannot start or be removed (then `round` is not run, or the working sandbox stays detached): a round that cannot be sealed is not run unsealed.
 */
export async function withSealedCheckRound<T>(input: SealedCheckRoundInput, round: (runners: CheckRunners) => Promise<T>): Promise<T> {
  refuseTestServicesWithDevcontainer({ dependencies: 1, devcontainer: input.hasDevcontainer });
  const key = planKey(input.plan);
  // One round at a time on a plan: two would share one check sandbox name, and the first one's removal would pull the sandbox out from under the other.
  if (ACTIVE_PLANS.has(key)) throw agentXError("RUNTIME_UNAVAILABLE", "a sealed check round is already running on this plan");
  ACTIVE_PLANS.add(key);
  try {
    return await sealedRound(input, round);
  } finally {
    ACTIVE_PLANS.delete(key);
  }
}

async function sealedRound<T>(input: SealedCheckRoundInput, round: (runners: CheckRunners) => Promise<T>): Promise<T> {
  return withDetachedWorking(input.docker, input.plan, async (start) => {
    // The network is looked at itself, before and after the start; any surprise throws, and `withDetachedWorking` removes the sandbox and attaches the working sandbox again.
    await assertSealedNetworkMembers(input.docker, input.plan, "before_start");
    await start();
    await assertSealedNetworkMembers(input.docker, input.plan, "after_start");
    let live = true;
    const execInput: SealedExecInput = { docker: input.docker, container: input.plan.sandboxName, files: input.files, environment: input.environment, live: () => live };
    ROUND_EXEC_INPUTS.add(execInput);
    const exec = sealedContainerExec(execInput);
    const runners: CheckRunners = {
      ...createSealedCheckRunners(input.rootPath, { exec, redact: (text) => input.redactor.text(text) }),
      ...(input.freshServices === undefined ? {} : { freshServices: input.freshServices }),
      ...(input.resetBetweenChecks === undefined ? {} : { resetBetweenChecks: input.resetBetweenChecks }),
    };
    try {
      return await round(runners);
    } finally {
      live = false;
    }
  }, { returnTo: input.workingPhaseNetwork ?? "none", pauseWorking: true, ...(input.signal === undefined ? {} : { signal: input.signal }) });
}

/**
 * One official check round, sealed: `runChecks` over `plan` with the runners of `withSealedCheckRound`. The normal round (`run-task.ts`) and the CHECKS retry call this when the task has test services, and the TESTPROOF
 * rerun on the original code calls it again: each call is its own round with a fresh check sandbox, and `freshServices` puts the helpers back first.
 */
export function runSealedCheckRound(input: SealedCheckRoundInput, plan: CheckPlan, options: { budgetMs: number; signal: AbortSignal; now?: () => number }): Promise<CheckRound> {
  return withSealedCheckRound({ ...input, signal: input.signal ?? options.signal }, (runners) => runChecks(plan, runners, options));
}
