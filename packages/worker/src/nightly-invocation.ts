// The nightly run as the worker receives it (NH-1): builds the real ports of `runNightly` from the task invocation's dependencies, runs the night and reports its result through the broker's ONE nightly action.
// `run-task.ts` calls it from one early hunk, for a verification-mode (CHECKS) operation whose payload carries `nightlyRun`, after the workspace and the task sandbox are ready. Everything that touches the outside (the
// project's commands, the report files, the broker) is a port, so the whole night is tested without a machine.
//
// What this module guarantees (each is a test):
//   - ED-1: the workspace is the one the BROKER prepared at the commit it resolved for the default branch. A workspace with a pull request head checked out, more than one repository, or a commit that is not the one the run was
//     started for (the branch moved between the broker's read and the clone) is refused and nothing is reported: a night is never recorded for code it did not test;
//   - the environment is the APPROVED one the broker sent; one with services is refused until a worker can start them (below): a false "boot failed" would send the project to "Setup needs repair";
//   - the report files are read through the contained reader (no link, nothing outside the workspace) and the coverage data through the same;
//   - the result goes to the broker once; a broker that refuses it fails the night (nothing else changes), a stop or the wall clock sends nothing.
//
// NOT here (deferred to the staging real-run checks, listed in the lane report): starting service mocks and probing pre-prod from a worker (they need the verifier's mock host, which needs Docker), the saved image
// (`update`, `ranFrom: saved_image`), and a coverage map for anything but coverage.py contexts.
import { NIGHTLY_CALLBACK_BODY_MAX_BYTES, NIGHTLY_RUN_WALL_CLOCK_MS, NightlyResultSchema, agentXError, type NightFailedReason, type NightlyResultCallbackBody, type NightlyRunPayload, type WorkerInvocation, type TestEnvCheck } from "@agentx/contracts";
import { EventBatcher, type EventBatchSink } from "./events.js";
import type { WorkerCancellationController } from "./cancel.js";
import type { PreparationManifest } from "./prepare.js";
import { NightlyWallClockError, coverageMapFromContexts, reportLocation, runNightly, type NightlyPorts } from "./nightly-run.js";
import { setupRepositoriesOf } from "./setup-agent-run.js";
import type { CheckRunners } from "./verification/checks.js";
import { readContainedReport } from "./verification/report-file.js";
import { readTestReportAt } from "./verification/test-report-folder.js";
import { withTestIds } from "./verification/test-ids.js";

/** The most bytes of coverage data read for a map (coverage.py's JSON with contexts is large). */
const CONTEXTS_MAX_BYTES = 64 * 1_048_576;
const CONTEXTS_FILE = ".agentx-nightly-contexts.json";

export interface NightlyInvocationDependencies {
  /** The canonical workspace root. */
  rootPath: string;
  eventSink: EventBatchSink;
  cancellationController?: WorkerCancellationController | undefined;
  /** The broker's nightly action with this invocation's own capability (callback-client.ts `nightlyResult`). A nightly does not run without it. */
  nightlyResult?: ((body: NightlyResultCallbackBody) => Promise<unknown>) | undefined;
  /** The runners the project's commands go through: the task sandbox (or the dev container), as a task's checks do. */
  runners: CheckRunners;
  now?: (() => number) | undefined;
  /** Test seam: the night's wall clock in milliseconds (default `NIGHTLY_RUN_WALL_CLOCK_MS`). */
  wallClockMs?: number | undefined;
  /** Test seam: the ports a night uses instead of the real ones. */
  ports?: NightlyPorts | undefined;
}

/** The result a nightly operation ends with (the broker's terminal result is not the nightly result: that went through the action). */
export interface NightlyInvocationResult { conversationId: string; reopened: false; workflowMode: "CHECKS" }

/** The environment's services need a mock host (the verifier's, on Docker) and pre-prod access, neither of which a worker has yet. */
export const NIGHTLY_SERVICES_UNAVAILABLE = "this worker cannot start an environment's services yet, so the nightly run did not start";

function productionPorts(deps: NightlyInvocationDependencies, startedAtMs: number, now: () => number, coverageCheck: TestEnvCheck | undefined): NightlyPorts {
  const unavailable = async (): Promise<never> => { throw agentXError("RUNTIME_UNAVAILABLE", NIGHTLY_SERVICES_UNAVAILABLE); };
  return {
    runCommand: (command, signal) => deps.runners.runProjectCommand(command, signal),
    startMock: unavailable,
    probePreprod: unavailable,
    mockUnmatched: async () => [],
    async readReport(check: TestEnvCheck, command) {
      if (check.reportPath === undefined) return undefined;
      const report = (await readTestReportAt(deps.rootPath, reportLocation(command, check.reportPath))).report;
      return report === undefined ? undefined : withTestIds(report, { root: deps.rootPath, cwd: command.cwd });
    },
    async buildCoverageMap(signal) {
      // coverage.py with contexts: `coverage json --show-contexts` over the data the suite just wrote, in the directory of the first test check that approves a coverage report.
      const check = coverageCheck;
      if (check === undefined) return undefined;
      const command = { cwd: check.command.cwd, executable: "python", args: ["-m", "coverage", "json", "--show-contexts", "-o", CONTEXTS_FILE], timeoutSeconds: 600 };
      const ran = await deps.runners.runProjectCommand(command, signal);
      if (ran.exitCode !== 0 || ran.timedOut) return undefined;
      const read = await readContainedReport({ root: deps.rootPath, cwd: command.cwd, argument: CONTEXTS_FILE, maxBytes: CONTEXTS_MAX_BYTES, notBeforeMs: startedAtMs });
      if (!read.ok) return undefined;
      return coverageMapFromContexts(read.bytes.toString("utf8"), new Date(now()).toISOString(), check.command.cwd === "." ? {} : { sourceRoot: check.command.cwd });
    },
    now,
  };
}

/** A night this worker will not run, with the word the broker keeps for it. */
class NightlyRefused extends Error {
  constructor(readonly reason: NightFailedReason, message: string) { super(message); }
}

export async function runNightlyInvocation(
  invocation: Extract<WorkerInvocation, { kind: "task" }>,
  deps: NightlyInvocationDependencies,
  manifest: Pick<PreparationManifest, "repositories">,
): Promise<NightlyInvocationResult> {
  const run: NightlyRunPayload | undefined = invocation.payload.nightlyRun;
  if (run === undefined) throw agentXError("CONFIG_INVALID", "a nightly run carries what it was started to run");
  if (deps.nightlyResult === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the worker cannot reach the control plane's nightly callback");

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const conversationId = invocation.payload.conversationId;
  const events = new EventBatcher(deps.eventSink);
  const stop = new AbortController();
  const unregister = deps.cancellationController?.register(invocation.operationId, { abort: async () => stop.abort() });
  // The check whose coverage data the map is built from: the first test check that approves a coverage report.
  const coverageCheck = run.environment.repos.flatMap((repo) => repo.checks).find((check) => check.kind === "test" && check.coveragePath !== undefined);
  let posting = false; // true from the moment the result is sent: a night that was recorded is never also reported as failed
  try {
    // The broker reads the operation as RUNNING from this event, and its nightly action (a result, or the word for why there is none) is accepted only then.
    await events.append("lifecycle", { status: "RUNNING", conversationId });
    await events.flush();
    // ED-1: the broker's commit for the default branch, in the workspace the broker prepared, and nothing else.
    if (manifest.repositories.length !== 1) throw new NightlyRefused("worker_refused", "a nightly run needs exactly one prepared repository");
    let repositories: ReturnType<typeof setupRepositoriesOf>;
    try { repositories = setupRepositoriesOf(deps.rootPath, manifest.repositories); } catch { throw new NightlyRefused("worker_refused", "the workspace is not the default branch of one repository"); }
    const repository = repositories[0];
    if (repository === undefined) throw new NightlyRefused("worker_refused", "the workspace has no repository");
    // The branch moved between the broker's read of its head and the clone: the night is for the commit the broker named, so it is not run (and nothing is recorded for code it did not test).
    if (repository.resolvedCommit !== run.headSha) throw new NightlyRefused("branch_moved", "the workspace is not at the commit this nightly run was started for");
    if (run.environment.services.length > 0) throw new NightlyRefused("worker_refused", NIGHTLY_SERVICES_UNAVAILABLE);
    await events.append("progress", { message: "Rovara is running the project's whole test suite on the default branch for the nightly baseline. It makes no code changes." });
    const { result, coverageMap } = await runNightly({
      environment: run.environment, run: { slotId: run.slotId, envRevision: run.envRevision, branch: run.branch, headSha: run.headSha },
      ports: deps.ports ?? productionPorts(deps, startedAt, now, coverageCheck), signal: stop.signal, deadlineMs: deps.wallClockMs ?? NIGHTLY_RUN_WALL_CLOCK_MS, startedAtMs: startedAt,
    });
    // The body must fit the control plane's request limit. A map that would not fit is not sent, and the result says so (it names no map then): the night is recorded, the selection falls back to the full suite
    // until a map arrives. The follow-up is to upload the map to a presigned address instead of in the body.
    const whole: NightlyResultCallbackBody = { result, ...(coverageMap === undefined ? {} : { coverageMap }) };
    posting = true;
    if (coverageMap !== undefined && Buffer.byteLength(JSON.stringify(whole), "utf8") > NIGHTLY_CALLBACK_BODY_MAX_BYTES) {
      const { coverageMapRef: _named, ...rest } = result; // eslint-disable-line @typescript-eslint/no-unused-vars -- the reference goes with the map
      await events.append("progress", { message: "Rovara built a coverage map for this night but it is too large to send, so this night is recorded without it." });
      await deps.nightlyResult({ result: NightlyResultSchema.parse({ ...rest, coverageMapSkipped: "too_large" }) });
    } else {
      await deps.nightlyResult(whole);
    }
    // From here on the result is the broker's: nothing that fails afterwards (the terminal event) is reported as a failed night, so `posting` stays true to the end.
    await events.append("result", { status: "SUCCEEDED", conversationId, workflowMode: "CHECKS" });
    await events.flush();
    return { conversationId, reopened: false, workflowMode: "CHECKS" };
  } catch (error) {
    await events.append("error", { message: error instanceof Error ? error.message.slice(0, 300) : "the nightly run failed" }).catch(() => undefined);
    // Why the night did not finish, in a fixed word, for the project's health page and Home. A stop by a person says nothing; a broker that refused the result is not asked again; the broker also writes `infra` itself
    // if the operation ends with no word.
    const stopped = stop.signal.aborted;
    if (!stopped && !posting) {
      const reason: NightFailedReason = error instanceof NightlyRefused ? error.reason : error instanceof NightlyWallClockError ? "wall_clock" : "infra";
      await deps.nightlyResult({ failed: { reason } }).catch(() => undefined);
    }
    await events.flush().catch(() => undefined);
    throw error;
  } finally {
    unregister?.();
  }
}
