// Proof and test environment E3 (design proof-test-env, section 4.1 step 3): the Prove run. It checks a PROPOSED environment by doing what a task will do: set up, build, bring up the services (mocks, or a probe
// of pre-prod), run the smoke checks, run the whole suite once (timed, to learn how long it takes and to give the nightly its first coverage map), and check that no mock was asked for something it has no recording
// for. The result is a `TestEnvProveReport` bound to the proposal's digest. The broker re-reads it (`testEnvIsProved`), so nothing here is trusted as a verdict.
//
// This module is the sequence and its failure words; running commands, starting mocks and probing pre-prod are PORTS (the setup executor wires them to the workspace, the verifier's mock server and the pre-prod
// access), so every step can be tested without a machine. Rules:
//   - the first failed step ends the run; every later step is reported `skipped`, so a report never claims a step that did not run;
//   - a failed step gives a fixed failure word and a redacted tail (at most 4 KiB) of what the command printed; the command's own words are never a reason;
//   - one overall deadline bounds the run, and a stop signal ends it; either fails the step in progress with `infrastructure`;
//   - a suite that is longer than the round budget is NOT a failure (it is why test selection exists); a suite that hits its own time limit is.
import { RunnerKillUnconfirmedError } from "./collected-process.js";
import {
  validPeakMemory,
  type MachineChip,
  TEST_ENV_DEPENDENCY_PROVE_STEPS,
  TEST_ENV_PROVE_STEPS,
  TestEnvProveReportSchema,
  redactText,
  type ProjectCommand,
  type TestEnvProveReport,
  type TestEnvironmentBody,
  testEnvDigest,
} from "@agentx/contracts";

type Step = (typeof TEST_ENV_PROVE_STEPS)[number];
type Failure = NonNullable<TestEnvProveReport["steps"][number]["failure"]>;

export interface ProveCommandResult { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }

export interface ProvePorts {
  runCommand(command: ProjectCommand, signal: AbortSignal): Promise<ProveCommandResult>;
  /** Starts the mock of a service from its pinned fixture set; resolves when it answers. Rejects when it cannot. */
  startMock(service: TestEnvironmentBody["services"][number], signal: AbortSignal): Promise<void>;
  /** One call with a canned synthetic payload to the real pre-prod service. True when it answered. */
  probePreprod(service: TestEnvironmentBody["services"][number], signal: AbortSignal): Promise<boolean>;
  /** After the suite: how many requests each mock answered with no recording. */
  mockUnmatched(): Promise<Array<{ service: string; unmatchedFailed: number }>>;
  /** After the suite, when the environment selects by coverage map: builds the map from the run's contexts and returns its digest, or undefined when it cannot. */
  buildCoverageMap(signal: AbortSignal): Promise<string | undefined>;
  /** After the suite: how many tests it ran, read from the check's report (the caller parses it with `parseTestReport`). Undefined when there was no readable report. */
  suiteTestCount?(): Promise<number | undefined>;
  /** When the run ends, whatever it did: removes what the ports started (the test services' helpers and network, service-runner.ts). Absent for a run that started nothing; a failure here is not the run's. */
  release?(): Promise<void>;
  /** Asked-for sandbox cgroup peak, sampled after the full suite and before release. */
  peakMemory?(): Promise<number | undefined>;
  now(): number;
}

export interface ProveInput {
  measureMachine?: boolean;
  machineChip?: MachineChip;
  proposalDigest: string;
  environment: TestEnvironmentBody;
  signal: AbortSignal;
  /** The most the whole run may take, in milliseconds. */
  deadlineMs: number;
}

const TAIL_BYTES = 4_096;
const failureOf: Record<string, Failure> = { setup: "setup_failed", build: "build_failed", smoke: "smoke_failed", full_suite: "tests_failed" };

function tailOf(result: ProveCommandResult): string {
  const text = redactText([result.stdout, result.stderr].filter((part) => part !== "").join("\n"));
  const bytes = Buffer.from(text, "utf8");
  const cut = bytes.length > TAIL_BYTES ? bytes.subarray(bytes.length - TAIL_BYTES).toString("utf8").replace(/^�+/u, "") : text;
  // Plain text only: control characters other than newline and tab are replaced.
  return cut.replace(/[^\P{Cc}\n\t]/gu, "?").slice(-TAIL_BYTES);
}

interface StepResult { status: "passed" | "failed" | "skipped"; failure?: Failure; tail?: string; durationMs: number }

export async function proveEnvironment(ports: ProvePorts, input: ProveInput): Promise<TestEnvProveReport> {
  const env = input.environment;
  // The report is bound to the digest of the environment that was actually proved, recomputed here: a caller cannot label one environment's run with another's digest.
  if (testEnvDigest(env) !== input.proposalDigest) throw new RangeError("the proposal digest is not the environment's digest");
  const results = new Map<Step, StepResult>();
  const modes = new Map<string, "preprod" | "mocked">();
  let fullSuite: TestEnvProveReport["fullSuite"];
  let coverageMapRef: string | undefined;
  let failed = false;

  const controller = new AbortController();
  const stop = () => controller.abort();
  if (input.signal.aborted) stop(); else input.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, Math.max(0, input.deadlineMs));
  const aborted = () => controller.signal.aborted;

  const record = (step: Step, result: StepResult) => { results.set(step, result); if (result.status === "failed") failed = true; };
  const run = async (step: Step, work: () => Promise<Omit<StepResult, "durationMs"> | undefined>): Promise<void> => {
    if (failed) { results.set(step, { status: "skipped", durationMs: 0 }); return; }
    const at = ports.now();
    let outcome: Omit<StepResult, "durationMs"> | undefined;
    try {
      outcome = aborted() ? { status: "failed", failure: "infrastructure" } : await work();
    } catch (error) {
      // A command whose stop could not be confirmed may still be running: not an "infrastructure" failure to step past and go on (FIX-RUNNER-ABORT-JOIN).
      if (error instanceof RunnerKillUnconfirmedError) throw error;
      outcome = { status: "failed", failure: "infrastructure" };
    }
    if (outcome === undefined) { record(step, { status: "skipped", durationMs: 0 }); return; }
    if (aborted() && outcome.status !== "failed") outcome = { status: "failed", failure: "infrastructure" };
    record(step, { ...outcome, durationMs: Math.max(0, Math.round(ports.now() - at)) });
  };

  const commandsOf = (kinds: readonly string[]) => env.repos.flatMap((repo) => repo.checks.filter((check) => kinds.includes(check.kind)));
  const runAll = async (commands: Array<{ command: ProjectCommand }>, failure: Failure): Promise<Omit<StepResult, "durationMs"> | undefined> => {
    if (commands.length === 0) return undefined;
    for (const item of commands) {
      const result = await ports.runCommand(item.command, controller.signal);
      if (result.timedOut) return { status: "failed", failure: "round_budget_exceeded", tail: tailOf(result) };
      if (result.exitCode !== 0) return { status: "failed", failure, tail: tailOf(result) };
    }
    return { status: "passed" };
  };

  try {
    await run("setup", () => runAll(env.repos.flatMap((repo) => repo.setupCommands.map((command) => ({ command }))), failureOf["setup"]!));
    await run("build", () => runAll(commandsOf(["build"]), failureOf["build"]!));

    // Pre-prod probes first, so `auto` knows whether to use the mock.
    await run("preprod_probe", async () => {
      const probed = env.services.filter((service) => service.mode !== "mock");
      if (probed.length === 0) return undefined;
      for (const service of probed) {
        const answered = await ports.probePreprod(service, controller.signal);
        if (answered) modes.set(service.name, "preprod");
        else if (service.mode === "auto") modes.set(service.name, "mocked");
        else return { status: "failed", failure: "preprod_unreachable" };
      }
      return { status: "passed" };
    });
    await run("boot", async () => {
      if (env.services.length === 0) return undefined;
      for (const service of env.services) {
        const mode = service.mode === "mock" ? "mocked" : modes.get(service.name);
        if (mode === undefined) return { status: "failed", failure: "preprod_unreachable" };
        modes.set(service.name, mode);
        if (mode === "mocked") {
          try { await ports.startMock(service, controller.signal); } catch { return { status: "failed", failure: "boot_failed" }; }
        }
      }
      return { status: "passed" };
    });
    await run("smoke", () => runAll(commandsOf(["smoke"]), failureOf["smoke"]!));
    await run("full_suite", async () => {
      const tests = commandsOf(["test"]);
      if (tests.length === 0) return undefined;
      const at = ports.now();
      const outcome = await runAll(tests, failureOf["full_suite"]!);
      const durationMs = Math.max(0, Math.round(ports.now() - at));
      if (outcome?.status === "passed") {
        const count = await ports.suiteTestCount?.().catch(() => undefined);
        fullSuite = { durationMs, tests: count !== undefined && Number.isSafeInteger(count) && count >= 0 && count <= 100_000_000 ? count : 0 };
        if (input.measureMachine === true) {
          const peak = await Promise.resolve().then(() => ports.peakMemory?.()).catch(() => undefined);
          if (validPeakMemory(peak)) fullSuite.peakMemoryMiB = peak;
        }
        if (env.selection.method === "coverage_map") coverageMapRef = await ports.buildCoverageMap(controller.signal).catch(() => undefined);
      }
      return outcome;
    });
    await run("mocks", async () => {
      if (!env.services.some((service) => modes.get(service.name) === "mocked")) return undefined;
      const unmatched = await ports.mockUnmatched();
      return unmatched.some((item) => item.unmatchedFailed > 0) ? { status: "failed", failure: "mock_unmatched" } : { status: "passed" };
    });
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    await Promise.resolve().then(() => ports.release?.()).catch(() => undefined);
  }

  // The two dependency steps (test services) are in the report only when this run ran them; with the switch off the report is today's, step for step.
  const steps = TEST_ENV_PROVE_STEPS.filter((step) => results.has(step) || !(TEST_ENV_DEPENDENCY_PROVE_STEPS as readonly string[]).includes(step)).map((step) => {
    const result = results.get(step) ?? { status: "skipped" as const, durationMs: 0 };
    return { step, status: result.status, durationMs: result.durationMs, ...(result.failure === undefined ? {} : { failure: result.failure }), ...(result.tail === undefined || result.tail === "" ? {} : { outputTail: result.tail }) };
  });
  const finishedAt = new Date(ports.now()).toISOString();
  return TestEnvProveReportSchema.parse({
    ...(input.measureMachine === true && input.machineChip !== undefined ? { machineChip: input.machineChip } : {}),
    schemaVersion: 1, proposalDigest: input.proposalDigest, steps,
    ...(fullSuite === undefined ? {} : { fullSuite }),
    ...(coverageMapRef === undefined ? {} : { coverageMapRef }),
    services: env.services.map((service) => ({ name: service.name, modeUsed: modes.get(service.name) ?? (service.mode === "preprod" ? "preprod" : "mocked") })),
    finishedAt,
  });
}
