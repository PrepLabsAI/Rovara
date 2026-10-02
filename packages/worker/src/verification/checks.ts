// Spec 051 (FR-002 to FR-005): AgentX reruns the checks itself when the agent finishes. The project's readiness
// commands when it has some, else the simple test commands the agent ran, each with its own timeout, within one
// round's budget, and stopped at once by the round's signal.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  checkOutputTail,
  classifyCheck,
  matchTestCommand,
  redactSecrets,
  redactText,
  type CheckEntry,
  type CheckOutcome,
  type ProjectCommand,
  type PublicationCheckResult,
} from "@agentx/contracts";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { MAX_COMMAND_OUTPUT_BYTES, redactedTail, tailCollector } from "../collected-process.js";
import { devcontainerBashOperations, runDevcontainerCommand, type DevcontainerCli, type DevcontainerTarget } from "../devcontainer.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../git.js";
import { runProjectCommand } from "../prepare.js";
import { projectBefore, type CheckHistory } from "./check-history.js";
import type { CommandRecorder, RecordedCommand } from "./recorder.js";

/** An agent command's own timeout (FR-005). */
export const AGENT_CHECK_TIMEOUT_MS = 10 * 60_000;
/** One production round's budget (P-3); an eval round gets its agent time remaining instead. */
export const CHECK_ROUND_BUDGET_MS = 30 * 60_000;
/** The report's per-check output limit, and its check limit (CheckEntrySchema, CheckReportSchema). */
const CHECK_OUTPUT_MAX_BYTES = 65_536;
const CHECK_LABEL_MAX = 8_192;
const MAX_CHECKS = 64;
/** Less budget than this left, and a check is not started: it could not finish. */
const MIN_CHECK_START_MS = 1_000;

export interface CheckRunners {
  /**
   * A readiness command, as preparation ran it (devcontainer or host). Rejects when `signal` stops it, even when the
   * command finished just before the abort: a check round discards that result anyway.
   */
  runProjectCommand(command: ProjectCommand, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>;
  /**
   * A replayed agent command, through the agent's own bash operations and cwd. Rejects when `signal` stops it, and
   * with a CheckNotRunError when AgentX refuses to replay it.
   */
  runAgentCommand(replay: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
}

export interface CheckPlan {
  source: "project" | "agent_commands" | "none";
  readiness?: ProjectCommand[];
  /** Per readiness command, its before (Ruling J): last known outcome, else passed at preparation, else unknown. */
  projectBefore?: CheckOutcome[];
  agentRuns?: RecordedCommand[];
}

export interface CheckRound {
  entries: CheckEntry[];
  /** True when the signal stopped the round: the report is not_verified/stopped (P-4), whatever the entries say. */
  stopped: boolean;
}

/** AgentX refused to run the check, so it has no after result (for example, a `cd` that leaves the workspace). */
export class CheckNotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckNotRunError";
  }
}

/**
 * The project's readiness when it has some (FR-002), else the agent's recorded commands (FR-003), else none. `history`
 * (readCheckHistory) gives each project check its before; without it, every project check's before is unknown.
 */
export function planChecks(
  readiness: ProjectCommand[] | undefined,
  recorder: Pick<CommandRecorder, "firstRuns">,
  history?: CheckHistory,
): CheckPlan {
  if (readiness !== undefined && readiness.length > 0) {
    const commands = readiness.slice(0, MAX_CHECKS);
    return { source: "project", readiness: commands, projectBefore: projectBefore(commands, history) };
  }
  const agentRuns = recorder.firstRuns().slice(0, MAX_CHECKS);
  return agentRuns.length > 0 ? { source: "agent_commands", agentRuns } : { source: "none" };
}

/** A label sent with the pull request callback: its start, as the compact task report keeps it. */
const PUBLICATION_LABEL_MAX = 1_024;

/**
 * Spec 051 (D-7): publish's readiness results as check entries, each judged against its before in `plan` (planChecks
 * with the workspace's history), as a task's final round is. The output is cut to the tail the pull request's checks
 * section shows, so 64 checks stay small in the callback.
 */
export function publicationCheckEntries(plan: CheckPlan, results: readonly PublicationCheckResult[]): CheckEntry[] {
  if (plan.source !== "project") return [];
  const entries: CheckEntry[] = [];
  for (const result of results.slice(0, MAX_CHECKS)) {
    const command = plan.readiness?.[result.index];
    if (command === undefined) continue;
    const before = plan.projectBefore?.[result.index] ?? "unknown";
    const durationMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
    entries.push({
      id: `readiness:${result.index}`,
      label: cut(projectLabel(command), PUBLICATION_LABEL_MAX),
      source: "project",
      before,
      after: result.outcome,
      class: classifyCheck(before, result.outcome),
      output: checkOutputTail(storedCheckOutput(joinedStreams(result.stdout, result.stderr))),
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    });
  }
  return entries;
}

interface PlannedCheck {
  id: string;
  label: string;
  source: CheckEntry["source"];
  before: CheckOutcome;
  ownTimeoutMs: number;
  run: (timeoutMs: number, signal: AbortSignal) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
}

/**
 * Runs the plan's checks in order. Each runs with its own timeout, cut to the budget left, and one the budget cannot
 * start, or that the budget (not its own timeout) stopped, is `not_run`. An abort stops the running check and returns
 * at once, without waiting for a runner that ignores it: that check and the rest are `not_run`, so the caller tells a
 * stopped round by its signal.
 */
export async function runChecks(
  plan: CheckPlan,
  runners: CheckRunners,
  options: { budgetMs: number; signal: AbortSignal; now?: () => number },
): Promise<CheckRound> {
  const now = options.now ?? Date.now;
  const { signal } = options;
  const startedAt = now();
  const entries: CheckEntry[] = [];
  for (const check of plannedChecks(plan, runners)) {
    const entry = (after: CheckOutcome, output: string, durationMs = 0): CheckEntry => ({
      id: check.id,
      label: check.label,
      source: check.source,
      before: check.before,
      after,
      class: classifyCheck(check.before, after),
      output: storedCheckOutput(output),
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    if (signal.aborted) {
      entries.push(entry("not_run", "AgentX stopped before this check ran."));
      continue;
    }
    const remaining = options.budgetMs - (now() - startedAt);
    if (remaining < MIN_CHECK_START_MS) {
      entries.push(entry("not_run", "AgentX did not run this check: the time budget for checks ran out."));
      continue;
    }
    const capped = remaining < check.ownTimeoutMs;
    const timeoutMs = capped ? remaining : check.ownTimeoutMs;
    const began = now();
    try {
      const result = await untilAborted(check.run(timeoutMs, signal), signal);
      const duration = now() - began;
      if (result.timedOut) {
        entries.push(capped
          ? entry("not_run", `AgentX stopped this check when the time budget for checks ran out.\n${result.output}`, duration)
          : entry("timed_out", result.output, duration));
      } else {
        entries.push(entry(result.exitCode === 0 ? "passed" : "failed", result.output, duration));
      }
    } catch (error) {
      const duration = now() - began;
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) entries.push(entry("not_run", "AgentX stopped this check.", duration));
      else if (error instanceof CheckNotRunError) entries.push(entry("not_run", message, duration));
      // It could not run (its directory is gone, the container has no bash): a failure, as readiness counts it.
      else entries.push(entry("failed", message, duration));
    }
  }
  return { entries, stopped: signal.aborted };
}

function plannedChecks(plan: CheckPlan, runners: CheckRunners): PlannedCheck[] {
  if (plan.source === "project") {
    return (plan.readiness ?? []).map((command, index) => ({
      id: `readiness:${index}`,
      label: projectLabel(command),
      source: "project",
      // Ruling J: the plan's before; a plan built without one has none.
      before: plan.projectBefore?.[index] ?? "unknown",
      ownTimeoutMs: command.timeoutSeconds * 1_000,
      run: async (timeoutMs, signal) => {
        const timeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1_000));
        const result = await runners.runProjectCommand(
          timeoutSeconds === command.timeoutSeconds ? command : { ...command, timeoutSeconds },
          signal,
        );
        return { exitCode: result.exitCode, timedOut: result.timedOut, output: joinedStreams(result.stdout, result.stderr) };
      },
    }));
  }
  if (plan.source === "agent_commands") {
    return (plan.agentRuns ?? []).map((run, index) => ({
      id: `agent:${index}`,
      label: cut(redactText(run.replay), CHECK_LABEL_MAX),
      source: "agent_commands",
      // FR-003: a first run made after an edit, or whose exit code is unknown, has no before result.
      before: run.afterFirstEdit || run.exitCode === undefined ? "unknown" : run.exitCode === 0 ? "passed" : "failed",
      ownTimeoutMs: AGENT_CHECK_TIMEOUT_MS,
      run: (timeoutMs, signal) => runners.runAgentCommand(run.replay, timeoutMs, signal),
    }));
  }
  return [];
}

/** The runner's result, or a rejection as soon as the signal fires, even when the runner does not honour it. */
function untilAborted<T>(running: Promise<T>, signal: AbortSignal): Promise<T> {
  // A runner that rejects after the abort has been reported must not become an unhandled rejection.
  running.catch(() => undefined);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    running.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/**
 * Both streams' tails within the report's limit (M-7): each gets half, and one that needs less gives the rest to the
 * other, so a long stderr cannot push stdout's summary out.
 */
function joinedStreams(stdout: string, stderr: string): string {
  const parts = [stdout, stderr].map((part) => redactedTail(part, MAX_COMMAND_OUTPUT_BYTES)).filter((part) => part !== "");
  if (parts.length < 2) return parts[0] ?? "";
  const room = CHECK_OUTPUT_MAX_BYTES - 1;
  const [first, second] = parts.map((part) => Buffer.byteLength(part)) as [number, number];
  const half = Math.floor(room / 2);
  const firstLimit = first <= half ? first : second <= half ? room - second : half;
  const secondLimit = room - Math.min(first, firstLimit);
  return `${redactedTail(parts[0]!, firstLimit)}\n${redactedTail(parts[1]!, secondLimit)}`;
}

/** Stored as readiness output is (redacted, then cut to MAX_COMMAND_OUTPUT_BYTES), then cut to the report's 64 KiB. */
function storedCheckOutput(text: string): string {
  return redactedTail(redactedTail(text, MAX_COMMAND_OUTPUT_BYTES), CHECK_OUTPUT_MAX_BYTES);
}

/** The executable and its arguments, redacted as an argv array (so `--token x` hides x) and as text. */
function projectLabel(command: ProjectCommand): string {
  const argv = redactSecrets([command.executable, ...command.args]) as unknown[];
  const shown = redactText(argv.map(String).join(" "));
  return cut(command.cwd === "." ? shown : `${shown} (in ${redactText(command.cwd)})`, CHECK_LABEL_MAX);
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

export interface CheckRunnerOptions {
  /** The workspace root: the agent's shell starts here, and a replayed `cd` may not leave it. */
  rootPath: string;
  /** The project's devcontainer, where preparation ran readiness and the agent's shell ran (Ruling K). */
  devcontainer?: { cli: DevcontainerCli; target: DevcontainerTarget };
  /**
   * The session's shell operations, for a container the devcontainer target does not describe (a SWE-bench task
   * container). Defaults to the devcontainer's shell when there is one, and to the host's bash only when there is none.
   */
  bashOperations?: BashOperations;
}

/** The real runners: readiness as preparation runs it, and agent commands as the agent's own shell runs them. */
export function createCheckRunners(options: CheckRunnerOptions): CheckRunners {
  const devcontainer = options.devcontainer;
  // Ruling K: a devcontainer session's replays run in the devcontainer, never on the host.
  const operations = options.bashOperations
    ?? (devcontainer === undefined ? createLocalBashOperations() : devcontainerBashOperations(devcontainer.cli, devcontainer.target));
  const inContainer = devcontainer !== undefined || options.bashOperations !== undefined;
  const canonicalRoot = realpath(resolve(options.rootPath));
  canonicalRoot.catch(() => undefined);
  return {
    async runProjectCommand(command, signal) {
      if (signal.aborted) throw new Error("aborted");
      const root = await canonicalRoot;
      try {
        const result = devcontainer === undefined
          ? await runProjectCommand(command, 0, root, signal)
          : await runDevcontainerCommand(devcontainer.cli, devcontainer.target, command, signal);
        if (signal.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode, timedOut: result.timedOut === true, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        throw withoutRootError(error, root);
      }
    },

    async runAgentCommand(replay, timeoutMs, signal) {
      if (signal.aborted) throw new Error("aborted");
      // Defence in depth: only what the matcher would replay, exactly (P-6).
      if (matchTestCommand(replay) !== replay) throw new CheckNotRunError("AgentX replays only a simple test command, and this is not one.");
      const root = await canonicalRoot;
      const cd = /^cd (\S+) && (.+)$/s.exec(replay);
      const command = cd === null ? replay : cd[2]!;
      const cwd = cd === null ? root : await containedDirectory(root, cd[1]!, inContainer);
      const output = tailCollector();
      try {
        const { exitCode } = await operations.exec(command, cwd, {
          onData: (data) => output.add(data),
          signal,
          timeout: timeoutMs / 1_000,
          // As the agent's shell runs it: the worker's environment and the AgentX git identity (agentShellTool).
          env: { ...process.env, ...AGENTX_GIT_IDENTITY_ENVIRONMENT },
        });
        return { exitCode, timedOut: false, output: output.text() };
      } catch (error) {
        if (signal.aborted) throw new Error("aborted", { cause: error });
        if (error instanceof Error && error.message.startsWith("timeout:")) return { exitCode: null, timedOut: true, output: output.text() };
        throw withoutRootError(error, root);
      }
    },
  };
}

/**
 * The directory a replayed `cd` names, resolved with realpath, so a symlink cannot lead out of the workspace (Ruling D).
 * The command then runs there directly rather than through the shell's own `cd`, which would follow the link again.
 */
async function containedDirectory(root: string, path: string, inContainer: boolean): Promise<string> {
  let target: string;
  try {
    target = await realpath(resolve(root, path));
  } catch {
    // In a container, a link the host cannot follow may be valid there (M-3): no result rather than a false failure.
    if (inContainer) throw new CheckNotRunError(`AgentX did not replay this command: the worker could not resolve ${path}.`);
    throw new Error(`cd: ${path}: no such directory in this workspace`);
  }
  // Containment first (M-13): a link out of the workspace is refused, whatever it points at.
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new CheckNotRunError(`AgentX did not replay this command: ${path} leads outside the workspace.`);
  }
  if (!(await stat(target)).isDirectory()) throw new Error(`cd: ${path}: not a directory`);
  return target;
}

/**
 * The worker's absolute workspace path, as "the workspace", in an error the worker or Pi raised (M-4, as #154 does for
 * readiness errors). A command's own output is stored as readiness output is, paths and all.
 */
function withoutRoot(text: string, root: string): string {
  return text.split(root).join("<workspace>");
}

function withoutRootError(error: unknown, root: string): unknown {
  if (!(error instanceof Error) || error instanceof CheckNotRunError || !error.message.includes(root)) return error;
  return new Error(withoutRoot(error.message, root), { cause: error });
}
