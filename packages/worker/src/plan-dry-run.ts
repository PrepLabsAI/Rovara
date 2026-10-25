import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PLAN_DRY_RUN_SCHEMA_VERSION, PLAN_DRY_RUN_TOTAL_BUDGET_MS, PlanDryRunReportSchema, builtinFileCheckOf, parsePlanDocument, planDryRunCommandSha256,
  type PlanDryRunClass, type PlanDryRunReport, type PlanDryRunUnavailableReason,
} from "@agentx/contracts";
import { ROVARA_CREATED_LABEL, ROVARA_RUN_LABEL, createProcessDockerCli, type DockerCli } from "@agentx/verifier";
import { materializeBaseSource } from "./baseline-source-export.js";
import type { CandidateRepositoryInput } from "./verification/candidate.js";
import { workflowE2EApplicationRuntimeConfig } from "./workflow-e2e-application-runtime.js";

/**
 * PLANDRYRUN. While it plans, the worker tries each check a coding plan proposes on the code as the task started, and reports a fixed class per check (see
 * PlanDryRunReportSchema) and nothing else: no output, no exit code, no message. The commands are model-written and run BEFORE anyone approves them, so:
 *
 * - They never run in the workspace. The task's base commit is written as plain files into a fresh folder (baseline-source-export.ts, the safe git path) and that folder
 *   is mounted read-only into a throwaway container of the executor image (the one image certain to be on the host), started with no network, every capability dropped,
 *   a read-only root, a small memory-backed /tmp, no new privileges, resource limits and an unprivileged user, and with none of the worker's environment: Docker gives a
 *   container only the image's own variables plus the ones set here, so no worker credential, token or cloud variable exists in it.
 * - Their output is never read into a result: the Docker call returns it and this module drops it. The class comes from the exit code and the clock alone.
 * - The whole dry run is bounded (120 s for the checks, a check that the budget cannot start is "not-run"), each check also has its own timeout, and a container is
 *   removed by name after a timeout (the Docker CLI being killed does not stop it) and carries the labels the stale-run sweeper looks for.
 * - Nothing here ever fails or delays the planning run beyond the budget: any trouble is a fixed "UNAVAILABLE" reason. Only the operation's own cancellation throws.
 */

const MAX_CHECK_SECONDS = 1_800;
const REMOVE_TIMEOUT_MS = 15_000;
const SAFE_PATH = /^[A-Za-z0-9._/+-]+$/;
const GREP_LIKE = new Set(["grep", "egrep", "fgrep", "rg"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
const TEST_LIKE = new Set(["test", "["]);
/** The programs, besides AgentX's own built-in file checks, whose result on the base export does not depend on installed dependencies or tools: plain grep and test, run directly (no shell). */
const TRIED_PROGRAMS = new Set(["grep", "egrep", "fgrep", "test"]);
const PREFLIGHT_TIMEOUT_MS = 15_000;
/** Blank in the container whatever the image sets, so an ambient proxy or Node option cannot change what a check does. */
const BLANKED_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_OPTIONS"].flatMap((name) => ["-e", `${name}=`]);

export interface ProposedCheckToTry { command: { cwd: string; executable: string; args: readonly string[]; timeoutSeconds: number } }

/** The checks a coding plan proposes, as the plan's own document reads them (all or nothing: an unreadable plan or block proposes nothing). */
export function proposedChecksOfPlan(planText: string, repositoryPaths: readonly string[]): ProposedCheckToTry[] {
  const read = parsePlanDocument(planText, { kind: "plan", checks: { repositoryPaths: [...repositoryPaths], required: [] } });
  if (!read.ok) return [];
  return (read.plan.checks?.proposed ?? []).map((check) => ({ command: { cwd: check.command.cwd, executable: check.command.executable, args: [...check.command.args], timeoutSeconds: check.command.timeoutSeconds } }));
}

/**
 * Whether a proposed check is tried at all. The export has no installed dependencies and the sandbox image has few tools, so `npm test`, `rg`, `git`, `pytest` and the like would
 * read as broken or failed on code they work fine on. Those are "not-checked": no container, no finding.
 */
export function dryRunTries(command: { executable: string; args: readonly string[] }): boolean {
  return builtinFileCheckOf(command) !== undefined || TRIED_PROGRAMS.has(command.executable);
}

/** What an exit code says about a check, from the program and the code alone (the output is never looked at). */
export function classifyDryRunExit(executable: string, exitCode: number, options: { builtinFileCheck?: boolean } = {}): PlanDryRunClass {
  if (exitCode === 0) return "passed";
  // Docker's own failure to start or find the program (125 to 127) and a signal (128 and up: killed, out of memory): nothing was learned.
  if (exitCode === 125) return "not-run";
  if (exitCode === 126 || exitCode === 127 || exitCode >= 128) return "broken";
  // A built-in file check says what its exit code means (a file that is not there fails it), so a missing file on the unchanged code is a check that failed, not one that is broken.
  if (options.builtinFileCheck === true) return "failed";
  // A usage error of grep, a shell or test (2) says nothing about the code either.
  const name = executable.slice(executable.lastIndexOf("/") + 1);
  if (exitCode >= 2 && (GREP_LIKE.has(name) || SHELLS.has(name) || TEST_LIKE.has(name))) return "broken";
  return "failed";
}

export interface PlanDryRunInput {
  /** The exact plan text the worker uploads; the report is bound to its digest. */
  planText: string;
  checks: readonly ProposedCheckToTry[];
  /** The workspace-relative path of the one repository (a check's folder is this path or a folder under it). */
  repositoryPath: string;
  repositories: readonly CandidateRepositoryInput[];
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  docker?: DockerCli;
  now?: () => number;
  /** Test seams. */
  config?: { executorImage: string; runRoot: string };
  runId?: () => string;
  materialize?: typeof materializeBaseSource;
  totalBudgetMs?: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const unavailable = (planSha256: string, reason: PlanDryRunUnavailableReason): PlanDryRunReport => ({ schemaVersion: PLAN_DRY_RUN_SCHEMA_VERSION, status: "UNAVAILABLE", planSha256, reason });
const cancelled = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("the plan dry run was cancelled"));

/** Tries the checks on the unchanged code and returns the fixed report. Never throws except for the operation's own cancellation. */
export async function runPlanDryRun(input: PlanDryRunInput): Promise<PlanDryRunReport> {
  const planSha256 = sha256(input.planText);
  try {
    const report = await tryChecks(input, planSha256);
    // The report is held to its own schema before it leaves, so nothing outside the fixed shape can be sent.
    return PlanDryRunReportSchema.parse(report);
  } catch {
    if (input.signal.aborted) throw cancelled(input.signal);
    return unavailable(planSha256, "internal-error");
  }
}

async function tryChecks(input: PlanDryRunInput, planSha256: string): Promise<PlanDryRunReport> {
  if (input.signal.aborted) throw cancelled(input.signal);
  if (input.checks.length === 0) return unavailable(planSha256, "internal-error");
  const tried = input.checks.map((check) => dryRunTries(check.command));
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budgetMs = input.totalBudgetMs ?? PLAN_DRY_RUN_TOTAL_BUDGET_MS;
  // Nothing to try (every check needs dependencies or tools the sandbox lacks): say so without needing a sandbox at all.
  if (!tried.some(Boolean)) {
    return { schemaVersion: PLAN_DRY_RUN_SCHEMA_VERSION, status: "COMPLETE", planSha256, totalMs: 0,
      checks: input.checks.map((check) => ({ commandSha256: planDryRunCommandSha256(check.command), class: "not-checked" as const, durationMs: 0 })) };
  }
  let config: { executorImage: string; runRoot: string };
  try {
    config = input.config ?? workflowE2EApplicationRuntimeConfig(input.environment ?? process.env, input.platform, input.arch);
  } catch {
    return unavailable(planSha256, "sandbox-not-configured");
  }
  if (input.repositories.length !== 1 || !SAFE_PATH.test(input.repositoryPath) || input.repositoryPath.startsWith("/") || input.repositoryPath.split("/").includes("..")) {
    return unavailable(planSha256, "source-unavailable");
  }
  const docker = input.docker ?? createProcessDockerCli();
  // One look at the sandbox before anything runs: a missing Docker binary reads as exit 127 and a missing image as 125, which must never be taken for the checks being broken.
  try {
    const inspected = await docker.run(["image", "inspect", config.executorImage], { signal: input.signal, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    if (input.signal.aborted) throw cancelled(input.signal);
    if (inspected.code !== 0) return unavailable(planSha256, "sandbox-unavailable");
  } catch {
    if (input.signal.aborted) throw cancelled(input.signal);
    return unavailable(planSha256, "sandbox-unavailable");
  }
  const runId = input.runId?.() ?? `pdr-${randomUUID()}`;
  // A sibling of the application runs' folder: the worker and the Docker host share it at the same path.
  const runDirectory = join(dirname(config.runRoot), "plan-dry-runs", runId);
  const source = join(runDirectory, "src");
  try {
    await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
    const exportSignal = AbortSignal.any([input.signal, AbortSignal.timeout(budgetMs + 15_000)]);
    let exported: { status: "READY" | "UNAVAILABLE" };
    try {
      await mkdir(runDirectory, { mode: 0o700 });
      exported = await (input.materialize ?? materializeBaseSource)({ repositories: input.repositories, destination: source, signal: exportSignal });
    } catch {
      if (input.signal.aborted) throw cancelled(input.signal);
      exported = { status: "UNAVAILABLE" };
    }
    if (exported.status !== "READY") return unavailable(planSha256, "source-unavailable");

    const checks: Array<{ commandSha256: string; class: PlanDryRunClass; durationMs: number }> = [];
    let sandboxFailed = false;
    for (const [index, check] of input.checks.entries()) {
      const commandSha256 = planDryRunCommandSha256(check.command);
      const result = (cls: PlanDryRunClass, durationMs = 0) => { checks.push({ commandSha256, class: cls, durationMs: Math.max(0, Math.round(durationMs)) }); };
      if (input.signal.aborted) throw cancelled(input.signal);
      if (!tried[index]) { result("not-checked"); continue; }
      const remaining = budgetMs - (now() - startedAt);
      if (sandboxFailed || remaining < 1_000) { result("not-run"); continue; }
      const ownMs = Math.min(check.command.timeoutSeconds, MAX_CHECK_SECONDS) * 1_000;
      const capped = remaining < ownMs;
      const began = now();
      const outcome = await runOne({ docker, config, runId, index, source, repositoryPath: input.repositoryPath, check, timeoutMs: Math.min(ownMs, remaining), signal: input.signal, now });
      const duration = now() - began;
      if (input.signal.aborted) throw cancelled(input.signal);
      if (outcome === "timeout") result(capped ? "not-run" : "broken", duration);
      else if (outcome === "sandbox-failed") { sandboxFailed = true; result("not-run", duration); }
      else result(outcome, duration);
    }
    if (checks.every((entry) => entry.class === "not-run") && sandboxFailed) return unavailable(planSha256, "sandbox-unavailable");
    return { schemaVersion: PLAN_DRY_RUN_SCHEMA_VERSION, status: "COMPLETE", planSha256, checks, totalMs: Math.max(0, Math.round(now() - startedAt)) };
  } finally {
    await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The `docker run` of one check: no network, no capabilities, no new privileges, a read-only root, a small memory-backed /tmp, the base export mounted read-only, resource
 * limits, an unprivileged user, the image never pulled, and none of the worker's environment. Exported so the Linux runtime test can run the very arguments with real Docker.
 */
export function planDryRunSandboxArgs(input: { name: string; runId: string; createdAt: number; image: string; source: string; repositoryPath: string; cwd: string; executable: string; args: readonly string[] }): string[] {
  return ["run", "--rm", "--name", input.name, "--pull=never",
    "--label", `${ROVARA_RUN_LABEL}=${input.runId}`, "--label", `${ROVARA_CREATED_LABEL}=${input.createdAt}`,
    "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256", "--cpus", "1", "--user", "1000:1000",
    "-v", `${input.source}:/work/${input.repositoryPath}:ro`, "-w", `/work/${input.cwd}`,
    ...BLANKED_ENV, "-e", "HOME=/tmp", "-e", "CI=true",
    "--entrypoint", input.executable, input.image, ...input.args];
}

/** One check in a throwaway container. Everything the command prints is dropped here. */
async function runOne(input: { docker: DockerCli; config: { executorImage: string }; runId: string; index: number; source: string; repositoryPath: string; check: ProposedCheckToTry;
  timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<PlanDryRunClass | "timeout" | "sandbox-failed"> {
  const { cwd, executable, args } = input.check.command;
  const inside = cwd === input.repositoryPath ? "" : cwd.startsWith(`${input.repositoryPath}/`) ? cwd.slice(input.repositoryPath.length + 1) : undefined;
  if (inside === undefined || !SAFE_PATH.test(cwd) || cwd.split("/").includes("..")) return "not-run";
  // A folder that does not exist on the unchanged code is a check that cannot pass there; no container is needed to know that.
  const info = await stat(inside === "" ? input.source : join(input.source, inside)).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return "failed";
  const name = `rovara-plan-dry-${input.runId}-${input.index}`;
  const dockerArgs = planDryRunSandboxArgs({ name, runId: input.runId, createdAt: input.now(), image: input.config.executorImage, source: input.source, repositoryPath: input.repositoryPath, cwd, executable, args });
  let result: { code: number };
  try {
    result = await input.docker.run(dockerArgs, { signal: input.signal, timeoutMs: input.timeoutMs });
  } catch {
    return "sandbox-failed";
  }
  // The CLI being killed does not stop the container it started.
  if (result.code === 124 || result.code === 130) await input.docker.run(["rm", "-f", name], { signal: new AbortController().signal, timeoutMs: REMOVE_TIMEOUT_MS }).catch(() => undefined);
  if (result.code === 130) return "not-run";
  if (result.code === 124) return "timeout";
  const cls = classifyDryRunExit(executable, result.code, { builtinFileCheck: builtinFileCheckOf({ executable, args }) !== undefined });
  return cls === "not-run" ? "sandbox-failed" : cls;
}
